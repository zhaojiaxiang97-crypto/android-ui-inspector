import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrollDispatchState, type DebugScrollProgress } from "../../shared/debug-scroll";
import { isDebugScrollProgress } from "../../shared/debug-scroll-validation";
import { isHelperObservationEvidence, type HelperObservationEvidence } from "../../shared/helper-observation";

export const MAX_DEBUG_REQUEST_RECORDS = 1000;
export const MAX_DEBUG_REQUEST_LEDGER_BYTES = 16 * 1024 * 1024;
export const DEBUG_REQUEST_LEDGER_FILENAME = "requests.json";

export type DebugRequestDispatchState = "not_sent" | "unknown" | "sent";
export type DebugRequestRecord = {
  requestId: string;
  fingerprint: string;
  input: Record<string, unknown>;
  dispatchState: DebugRequestDispatchState;
  state: "running" | "completed" | "interrupted";
  stepId?: number;
  result?: Record<string, unknown>;
  progress?: DebugScrollProgress;
  observationSource?: HelperObservationEvidence;
  createdAt: string;
  updatedAt: string;
};
type LedgerFile = { format: "inspector-debug-requests-1"; sessionId: string; records: DebugRequestRecord[] };
type Options = { sessionDirectory: string; sessionId: string; maxRecords?: number; maxBytes?: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestKey(value: string): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new Error("请求 ID 必须是 UUID。");
  return value.toLowerCase();
}

/** Parsed command objects only: omit absent optional fields, but never silently coerce values. */
function canonicalObject(input: unknown): Record<string, unknown> {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 40) throw new Error("请求台账对象过大或嵌套过深。");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error("请求台账只接受有效 JSON 对象。");
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
      throw new Error("请求台账只接受普通 JSON 对象。");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return Array.from(value, item => visit(item, depth + 1));
      return Object.fromEntries(Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, visit((value as Record<string, unknown>)[key], depth + 1)]));
    } finally { ancestors.delete(value); }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请求台账需要 JSON 对象。");
  return visit(input, 0) as Record<string, unknown>;
}
function fingerprint(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function limit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("请求台账容量上限无效。");
  return value;
}
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** One session owns the ledger. Every operation also checks disk under an exclusive write lock. */
export class DebugRequestLedger {
  readonly path: string;
  private readonly directory: string;
  private readonly sessionId: string;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private records = new Map<string, DebugRequestRecord>();

  constructor(options: Options) {
    if (typeof options.sessionId !== "string" || !options.sessionId || options.sessionId.length > 128)
      throw new Error("请求台账会话 ID 无效。");
    this.directory = options.sessionDirectory;
    this.path = join(this.directory, DEBUG_REQUEST_LEDGER_FILENAME);
    this.sessionId = options.sessionId;
    this.maxRecords = limit(options.maxRecords, MAX_DEBUG_REQUEST_RECORDS);
    this.maxBytes = limit(options.maxBytes, MAX_DEBUG_REQUEST_LEDGER_BYTES);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(this.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("请求台账目录无效。");
    this.locked(() => {
      let records: DebugRequestRecord[];
      try { records = this.read(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.persist([]);
        return;
      }
      let changed = false;
      for (const record of records) if (record.state === "running") {
        record.state = "interrupted";
        if (record.dispatchState !== "not_sent") record.dispatchState = "unknown";
        record.updatedAt = new Date().toISOString();
        changed = true;
      }
      if (changed) this.persist(records);
      else this.remember(records);
    });
  }

  reserve(requestId: string, input: Record<string, unknown>): { created: boolean; record: DebugRequestRecord } {
    const key = requestKey(requestId), normalized = canonicalObject(input), hash = fingerprint(normalized);
    return this.locked(() => {
      this.refresh();
      const existing = this.records.get(key);
      if (existing) {
        // Before backend selection existed, an omitted backend meant UIAutomator.
        // Preserve the stored digest; normalize only this newly explicit default for replay.
        const legacyDefault = existing.input.backend === undefined && normalized.backend === "uiautomator"
          && fingerprint(canonicalObject({ ...normalized, backend: undefined })) === existing.fingerprint;
        if (existing.fingerprint !== hash && !legacyDefault) throw new Error("相同请求 ID 的参数不同，已拒绝重复操作。");
        return { created: false, record: copy(existing) };
      }
      if (this.records.size >= this.maxRecords) throw new Error("请求台账已满，旧请求不会被移除；未执行新操作。");
      const now = new Date().toISOString();
      const record: DebugRequestRecord = { requestId: key, fingerprint: hash, input: normalized,
        dispatchState: "not_sent", state: "running", createdAt: now, updatedAt: now };
      this.persist([...this.records.values(), record]);
      return { created: true, record: copy(record) };
    });
  }

  get(requestId: string): DebugRequestRecord | undefined {
    const key = requestKey(requestId);
    return this.locked(() => {
      this.refresh();
      const record = this.records.get(key);
      return record ? copy(record) : undefined;
    });
  }

  markDispatch(requestId: string, dispatchState: DebugRequestDispatchState, stepId?: number): DebugRequestRecord {
    if (!["not_sent", "unknown", "sent"].includes(dispatchState)) throw new Error("请求发送状态无效。");
    if (stepId !== undefined && (!Number.isSafeInteger(stepId) || stepId < 1)) throw new Error("请求步骤 ID 无效。");
    return this.update(requestId, record => {
      if (record.state !== "running") throw new Error("请求已经结束或中断，不能重新发送输入。");
      if (record.dispatchState === "sent" && dispatchState !== "sent") throw new Error("已发送的请求不能回退为未发送。");
      if (record.stepId !== undefined && stepId !== undefined && record.stepId !== stepId)
        throw new Error("请求不能关联到另一个输入步骤。");
      record.dispatchState = dispatchState;
      if (stepId !== undefined) record.stepId = stepId;
    });
  }

  /** Bind before the first input. Recovery may inspect this identity but cannot replace it. */
  bindObservationSource(requestId: string, source: HelperObservationEvidence): DebugRequestRecord {
    if (!isHelperObservationEvidence(source)) throw new Error("Helper 采集来源证据无效。");
    return this.update(requestId, record => {
      if (record.input.backend !== "accessibility-helper") throw new Error("请求未选择 Helper，不能混用采集来源。");
      if (record.observationSource) {
        if (record.observationSource.serviceInstanceId !== source.serviceInstanceId
          || record.observationSource.protocolVersion !== source.protocolVersion)
          throw new Error("Helper 服务已重启，不能替换原请求的来源证据。");
        return;
      }
      if (record.state !== "running" || record.dispatchState !== "not_sent")
        throw new Error("输入开始后不能补写 Helper 来源证据。");
      record.observationSource = copy(source);
    });
  }

  /** Also stores read-only resumed observations; it never resets dispatch state or permits input. */
  finish(requestId: string, result: Record<string, unknown>): DebugRequestRecord {
    const normalized = canonicalObject(result);
    return this.update(requestId, record => {
      if (normalized.scrollTask !== undefined) {
        if (!isDebugScrollProgress(normalized.scrollTask)) throw new Error("滚动任务记录无效。");
        this.checkScrollHistory(record, normalized.scrollTask, false);
        record.progress = copy(normalized.scrollTask);
      }
      record.result = normalized; record.state = "completed";
    });
  }

  /** Persist the current gesture and all prior receipts atomically, before any next input. */
  checkpoint(requestId: string, progress: DebugScrollProgress, stepId: number): DebugRequestRecord {
    const normalized = canonicalObject(progress);
    if (!isDebugScrollProgress(normalized) || !Number.isSafeInteger(stepId) || stepId < 1)
      throw new Error("滚动任务进度无效。");
    return this.update(requestId, record => {
      if (record.state !== "running") throw new Error("请求已经结束或中断，不能重新发送输入。");
      if (record.stepId !== undefined && record.stepId !== stepId) throw new Error("请求不能关联到另一个输入步骤。");
      this.checkScrollHistory(record, normalized, true);
      record.stepId = stepId;
      record.progress = copy(normalized);
      record.dispatchState = scrollDispatchState(normalized);
    });
  }

  private checkScrollHistory(record: DebugRequestRecord, next: DebugScrollProgress, running: boolean) {
    if (record.progress?.scope && JSON.stringify(canonicalObject(record.progress.scope)) !== JSON.stringify(next.scope && canonicalObject(next.scope)))
      throw new Error("滚动任务的窗口范围不能改变。");
    if (record.progress?.observationIds.some((id, index) => next.observationIds[index] !== id))
      throw new Error("已有滚动观察不能删除或重排。");
    const previous = record.progress?.iterations ?? [];
    if (next.iterations.length < previous.length || next.iterations.length > previous.length + (running ? 1 : 0))
      throw new Error("滚动记录不能丢失或跳过已记录的输入。");
    for (let index = 0; index < previous.length; index++) {
      const before = previous[index], after = next.iterations[index];
      if (index < previous.length - 1 || !running || next.iterations.length > previous.length) {
        if (JSON.stringify(canonicalObject(before)) !== JSON.stringify(canonicalObject(after)))
          throw new Error("已有滚动记录不可重写。");
      } else if (before.dispatchState === "sent" && after.dispatchState !== "sent") {
        throw new Error("已发送的滚动不能回退为未发送。");
      }
      if (before.dispatchState !== "not_sent") {
        for (const key of ["startedAt", "beforeId", "resolvedInput"] as const) {
          if (JSON.stringify(canonicalObject({ value: before[key] })) !== JSON.stringify(canonicalObject({ value: after[key] })))
            throw new Error("已派发滚动的目标与坐标不能改变。");
        }
        if (before.dispatchState === "unknown" && after.dispatchState === "not_sent" && after.inputEvidence?.spawned !== false)
          throw new Error("无法证明输入未派发，必须保留未知状态。");
      }
    }
  }

  private update(requestId: string, change: (record: DebugRequestRecord) => void): DebugRequestRecord {
    const key = requestKey(requestId);
    return this.locked(() => {
      this.refresh();
      const existing = this.records.get(key);
      if (!existing) throw new Error("请求台账中不存在此请求。");
      const record = copy(existing);
      change(record);
      record.updatedAt = new Date().toISOString();
      this.persist([...this.records.values()].map(entry => entry.requestId === key ? record : entry));
      return copy(record);
    });
  }

  private remember(records: DebugRequestRecord[]) { this.records = new Map(records.map(record => [record.requestId, record])); }
  private refresh() { this.remember(this.read()); }

  private read(): DebugRequestRecord[] {
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > this.maxBytes) throw new Error("请求台账文件无效或超过容量上限。");
      const data = readFileSync(fd, "utf8");
      if (Buffer.byteLength(data) > this.maxBytes) throw new Error("请求台账超过容量上限。");
      const value: unknown = JSON.parse(data);
      if (!plain(value) || !exactKeys(value, ["format", "sessionId", "records"])
        || value.format !== "inspector-debug-requests-1" || value.sessionId !== this.sessionId
        || !Array.isArray(value.records) || value.records.length > this.maxRecords) throw new Error("请求台账格式或会话不匹配。");
      const seen = new Set<string>();
      const records = value.records.map((entry: unknown) => {
        if (!plain(entry) || !exactKeys(entry, ["requestId", "fingerprint", "input", "dispatchState", "state", "stepId", "result", "progress", "observationSource", "createdAt", "updatedAt"])
          || typeof entry.requestId !== "string" || requestKey(entry.requestId) !== entry.requestId || seen.has(entry.requestId)
          || typeof entry.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(entry.fingerprint)
          || !["not_sent", "unknown", "sent"].includes(String(entry.dispatchState))
          || !["running", "completed", "interrupted"].includes(String(entry.state))
          || !timestamp(entry.createdAt) || !timestamp(entry.updatedAt) || entry.updatedAt < entry.createdAt
          || (entry.stepId !== undefined && (!Number.isSafeInteger(entry.stepId) || (entry.stepId as number) < 1))
          || (entry.state === "completed" && entry.result === undefined)
          || (entry.state === "running" && entry.result !== undefined)) throw new Error("请求台账记录损坏。");
        const input = canonicalObject(entry.input);
        if (fingerprint(input) !== entry.fingerprint) throw new Error("请求台账参数校验失败。");
        if (entry.result !== undefined) canonicalObject(entry.result);
        if (entry.progress !== undefined && !isDebugScrollProgress(entry.progress)) throw new Error("滚动任务记录损坏。");
        if (entry.observationSource !== undefined && (!isHelperObservationEvidence(entry.observationSource)
          || input.backend !== "accessibility-helper")) throw new Error("Helper 来源记录损坏。");
        seen.add(entry.requestId);
        return { ...entry, input } as DebugRequestRecord;
      });
      return records;
    } finally { closeSync(fd); }
  }

  private persist(records: DebugRequestRecord[]) {
    const value: LedgerFile = { format: "inspector-debug-requests-1", sessionId: this.sessionId, records };
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > this.maxBytes) throw new Error("请求台账超过容量上限，未执行新操作。");
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, data, "utf8");
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, this.path);
      if (process.platform !== "win32") {
        const directoryFd = openSync(this.directory, "r");
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      }
      this.remember(records);
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }

  private locked<T>(operation: () => T): T {
    const lock = `${this.path}.lock`;
    // A leftover lock is deliberately not reclaimed: a different process may still be sending input.
    mkdirSync(lock, { mode: 0o700 });
    try { return operation(); }
    finally { rmdirSync(lock); }
  }
}
