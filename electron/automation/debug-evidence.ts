import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEBUG_LOG_LIMITS, DEBUG_REPORT_VERSION, DEBUG_SNAPSHOT_VERSION, type DebugLogCapture, type DebugReportFile, type DebugReportStep,
  type DebugSessionReport, type DebugSnapshotDocument, type DebugSnapshotEvidence, type DebugSnapshotReference } from "../../shared/debug-report";
import { isUiSnapshot } from "../../shared/snapshot-validation";
import type { DebugSessionState, DebugStep, DebugStepError, UiNode, UiSnapshot } from "../../shared/types";
import type { McpSnapshot } from "./mcp-snapshot";
import type { DebugTaskCheckResult } from "../../shared/debug-task";
import { boundedDebugLogText, debugLogConfigurationSecrets, sanitizeDebugLogText } from "./debug-logs";
import { measureDebugPhaseSync } from "./debug-timing";
import { debugSnapshotPriorities } from "../../shared/debug-evidence-priority";

const MiB = 1024 * 1024;
export const DEBUG_EVIDENCE_LIMITS = {
  maxSteps: 100, maxSnapshots: 200, maxImages: 100, maxBytes: 32 * MiB,
  maxTreeBytes: 2 * MiB, maxImageBytes: 10 * MiB,
} as const;
export type DebugEvidenceObservation = { entry: McpSnapshot | null; freshness: DebugSnapshotReference["freshness"]; reason: string | null };
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const explanation = (error: unknown) => error instanceof Error ? sanitizeDebugLogText(error.message, debugLogConfigurationSecrets()).slice(0, 16000) : "证据保存失败。";
const recordingError = (code: string, error: unknown): DebugStepError => ({ category: "recording", code, phase: "recording", message: explanation(error) });
const capacityWarning = "证据总容量超过上限，已按保留优先级裁剪该附件。";
const imageCountWarning = "截图数量超过上限，已按保留优先级裁剪该图片。";
const capacityIssue: DebugStepError = { category: "recording", code: "evidence_capacity_exceeded", phase: "recording",
  message: "证据容量或图片数量已达上限，部分附件未保存。优先保留当前操作、验收双帧、失败现场及操作前后；同优先级树优先于图片，缺失项见快照警告。" };

export function appendDebugRecordingErrors(step: DebugStep, errors: DebugStepError[]) {
  if (!errors.length) return false;
  const previous = JSON.stringify(step.recordingErrors ?? []);
  const unique = new Map([...(step.recordingErrors ?? []), ...errors].map(error => [JSON.stringify(error), error]));
  const items = [...unique.values()];
  step.recordingErrors = items.length <= 100 ? items : [...items.slice(-99), {
    category: "recording", code: "recording_errors_truncated", phase: "recording",
    message: "记录错误超过100条，只保留最近99条；其他错误未展开。",
  }];
  return previous !== JSON.stringify(step.recordingErrors);
}

/** Preserve properties and capture identity, without saving independent render layers twice. */
export function debugEvidenceSnapshot(snapshot: UiSnapshot): UiSnapshot {
  const copy = (node: UiNode): UiNode => {
    const { layerImageDataUrl: _image, layerImageSize: _size, layerCapturePlacement: _placement,
      layerImageEmpty: _empty, layerImageStatus: _status, ...properties } = node;
    return { ...properties, children: node.children.map(copy) };
  };
  const result = { ...snapshot, root: snapshot.root ? copy(snapshot.root) : null, screenshotDataUrl: null };
  if (!isUiSnapshot(result)) throw new Error("留证快照的树或采集身份无效。");
  return result;
}

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("证据目录不能是链接或普通文件。");
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

function atomicWrite(path: string, data: Buffer) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Local bounded evidence only. Construction and recording never observe or input a device. */
export class DebugEvidenceWriter {
  readonly path: string;
  private readonly report: DebugSessionReport;
  private readonly owned = new Map<string, { ino: number; dev: number }>();
  private readonly trimmed = new Map<string, Partial<Record<"tree" | "screenshot", DebugReportFile>>>();
  private committed = new Set<string>();
  private reportSaved = false;

  constructor(private readonly directory: string, state: DebugSessionState,
    limits: Partial<DebugSessionReport["limits"]> = {}) {
    const actual = { ...DEBUG_EVIDENCE_LIMITS, ...limits };
    for (const [key, value] of Object.entries(actual)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > DEBUG_EVIDENCE_LIMITS[key as keyof typeof DEBUG_EVIDENCE_LIMITS])
        throw new Error("证据限额必须为正整数且不能超过默认上限。");
    }
    this.path = join(directory, "report.json");
    const startedAt = state.startedAt ?? new Date().toISOString();
    this.report = { schemaVersion: DEBUG_REPORT_VERSION,
      session: { id: state.id, serial: state.serial, packageName: state.packageName, startedAt, updatedAt: startedAt,
        active: state.active, stopReason: state.stopReason ?? null, totalSteps: 0, droppedSteps: 0 },
      limits: actual, storage: { bytes: 0 }, steps: [], snapshots: [] };
  }

  saveSession(state: DebugSessionState, totalSteps: number) {
    this.reportSaved = false;
    Object.assign(this.report.session, { active: state.active, stopReason: state.stopReason ?? null,
      totalSteps, droppedSteps: Math.max(0, totalSteps - this.report.steps.length), updatedAt: new Date().toISOString() });
    this.report.session.progress = structuredClone(state.progress);
    this.report.session.androidLogsEnabled = state.androidLogsEnabled ?? false;
    // Cleanup may fail after the last step was saved. Retain its error without
    // rewriting input receipts or reopening any snapshot attachments.
    for (const saved of this.report.steps) {
      const current = state.steps.find(step => step.id === saved.step.id);
      if (current?.recordingErrors?.length) appendDebugRecordingErrors(saved.step, current.recordingErrors);
    }
    const errors: DebugStepError[] = [];
    this.report.task = structuredClone(state.task ?? null);
    this.retainSnapshots();
    try { this.persist(new Map(), errors, this.report.steps.at(-1)); }
    catch (error) {
      for (const check of this.report.task?.checks ?? []) this.insufficient(check, "任务记录保存失败，无法保留完整验收证据。");
      this.normalizeTaskEvidence(); throw error;
    } finally { this.syncTaskState(state); }
    return errors;
  }

  record(state: DebugSessionState, totalSteps: number, record: DebugReportStep,
    before: DebugEvidenceObservation, after: DebugEvidenceObservation, logs?: DebugLogCapture[], scrollObservations?: McpSnapshot[], assertionObservations?: McpSnapshot[]): DebugStepError[] {
    this.reportSaved = false;
    const errors: DebugStepError[] = [];
    const assets = new Map<string, Buffer>();
    const saved: DebugReportStep = structuredClone(record);
    if (saved.step.scrollTask) {
      // A synchronous stop can record while a gesture is still unwinding.
      // Its input belongs to the iteration, never a second top-level gesture.
      delete saved.step.resolvedInput;
      delete saved.step.inputEvidence;
    }
    if (logs) saved.logs = logs.slice(0, DEBUG_LOG_LIMITS.maxSources).map(log => {
      const evidence = structuredClone(log.evidence);
      if (log.text) {
        const content = boundedDebugLogText(log.text);
        const bytes = Buffer.from(content.text ?? ""), digest = sha(bytes), path = `artifacts/${digest}.txt`;
        evidence.lineCount = content.lineCount; evidence.truncated ||= content.truncated;
        if (bytes.length > 0 && bytes.length <= DEBUG_LOG_LIMITS.maxBytes) { assets.set(path, bytes); evidence.file = { path, sha256: digest, size: bytes.length }; }
        else { evidence.status = "unavailable"; evidence.reason = "日志附件超过128KiB上限，未保存。"; evidence.file = null; evidence.lineCount = 0; evidence.truncated = true; }
      }
      delete evidence.text; delete evidence.loadError;
      return evidence;
    });
    this.report.task = structuredClone(state.task ?? null);
    this.report.steps = [...this.report.steps.filter(item => item.step.id !== saved.step.id), saved].slice(-this.report.limits.maxSteps);
    Object.assign(this.report.session, { active: state.active, stopReason: state.stopReason ?? null,
      totalSteps, droppedSteps: Math.max(0, totalSteps - this.report.steps.length), updatedAt: new Date().toISOString() });
    this.report.session.progress = structuredClone(state.progress);
    this.report.session.androidLogsEnabled = state.androidLogsEnabled ?? false;
    const reference = (observation: DebugEvidenceObservation): DebugSnapshotReference => {
      if (!observation.entry) return { snapshotId: null, freshness: "missing", reason: observation.reason ?? "没有接受到该阶段的观察。" };
      const previous = this.report.snapshots.find(item => item.snapshotId === observation.entry!.id);
      if (!previous) {
        this.report.snapshots.push(measureDebugPhaseSync("attachments", () => this.snapshot(observation.entry!, assets, errors)));
      } else if (previous.warnings.some(warning => warning === capacityWarning || warning === imageCountWarning)) {
        // A previously trimmed capture may now be an input's before frame or a
        // final confirmation. Reconsider the supplied original at its new role.
        const restored = measureDebugPhaseSync("attachments", () => this.snapshot(observation.entry!, assets, errors));
        const expected = this.trimmed.get(previous.snapshotId);
        for (const kind of ["tree", "screenshot"] as const) if (!previous[kind] && expected?.[kind] && restored[kind]) {
          if (restored[kind].path === expected[kind].path && restored[kind].size === expected[kind].size) {
            previous[kind] = restored[kind]; delete expected[kind];
          } else {
            const issue = recordingError("artifact_identity_changed", new Error("重复快照的附件内容已变化，未替换此前证据。"));
            errors.push(issue); if (!previous.warnings.includes(issue.message)) previous.warnings.push(issue.message);
          }
        }
        if (expected && Object.keys(expected).length === 0) {
          this.trimmed.delete(previous.snapshotId);
          previous.warnings = previous.warnings.filter(warning => warning !== capacityWarning && warning !== imageCountWarning);
        }
      }
      return { snapshotId: observation.entry.id, freshness: observation.freshness, reason: observation.reason };
    };
    saved.before = reference(before); saved.after = reference(after);
    for (const entry of scrollObservations ?? []) reference({ entry, freshness: "current", reason: null });
    for (const entry of assertionObservations ?? []) reference({ entry, freshness: "current", reason: null });
    this.retainSnapshots();
    appendDebugRecordingErrors(saved.step, errors);
    try { this.persist(assets, errors, saved); }
    catch (error) {
      if (saved.step.assertionConfirmation) saved.verified = saved.step.verified = null;
      if (saved.step.taskCheck) {
        this.insufficient(saved.step.taskCheck, "任务记录保存失败，无法保留完整验收证据。");
        const latest = this.report.task?.checks.find(item => item.stepId === saved.step.id);
        if (latest) Object.assign(latest, structuredClone(saved.step.taskCheck));
      }
      this.normalizeTaskEvidence(); throw error;
    } finally { this.syncTaskState(state, record); }
    return errors;
  }

  /** Update final measurements only. Never reopen, trim or reserialize snapshot/log attachments. */
  finalizeTiming(state: DebugSessionState, totalSteps: number, step: DebugStep) {
    if (!step.timings) return;
    const saved = this.report.steps.find(item => item.step.id === step.id);
    if (!this.reportSaved || !saved) throw new Error("步骤证据尚未保存，无法回填最终计时。");
    const previousTimings = saved.step.timings, previousSession = this.report.session, previousBytes = this.report.storage.bytes;
    saved.step.timings = structuredClone(step.timings);
    this.report.session = { ...previousSession, active: state.active, stopReason: state.stopReason ?? null,
      totalSteps, droppedSteps: Math.max(0, totalSteps - this.report.steps.length), updatedAt: new Date().toISOString(),
      progress: structuredClone(state.progress), androidLogsEnabled: state.androidLogsEnabled ?? false };
    try {
      const bytes = this.serialize();
      // Timing metadata must not evict evidence which was already saved successfully.
      if (this.report.storage.bytes > this.report.limits.maxBytes) throw new Error("最终计时超过证据总容量上限，已保留此前报告和附件。");
      privateDirectory(this.directory);
      atomicWrite(this.path, bytes);
    } catch (error) {
      if (previousTimings) saved.step.timings = previousTimings; else delete saved.step.timings;
      this.report.session = previousSession; this.report.storage.bytes = previousBytes;
      throw error;
    }
  }

  private protectedSnapshots() {
    return new Set([...(this.report.task?.checks ?? []).filter(check => check.status === "passed")
      .flatMap(check => [check.observations.first?.snapshotId, check.observations.second?.snapshotId]),
      ...this.report.steps.flatMap(item => item.step.scrollTask?.confirmation
        ? [item.step.scrollTask.confirmation.firstSnapshotId, item.step.scrollTask.confirmation.secondSnapshotId] : []),
      ...this.report.steps.flatMap(item => item.step.assertionConfirmation
        ? [item.step.assertionConfirmation.first.snapshotId, item.step.assertionConfirmation.second.snapshotId] : [])].filter(Boolean));
  }

  private retainSnapshots() {
    const referenced = new Set([...this.report.steps.flatMap(item => [item.before.snapshotId, item.after.snapshotId]),
      ...this.report.steps.flatMap(item => [item.step.beforeId, item.step.afterId,
        item.step.resolvedInput?.visualConfirmation?.referenceSnapshotId, item.step.resolvedInput?.visualConfirmation?.currentSnapshotId]),
      ...this.report.steps.flatMap(item => item.step.scrollTask?.observationIds ?? []),
      ...this.report.steps.flatMap(item => item.step.assertionConfirmation
        ? [item.step.assertionConfirmation.first.snapshotId, item.step.assertionConfirmation.second.snapshotId] : []),
      ...this.report.steps.flatMap(item => (item.step.scrollTask?.iterations ?? []).flatMap(iteration => [iteration.beforeId, iteration.afterId])),
      ...(this.report.task?.checks ?? []).flatMap(check => [check.observations.first?.snapshotId, check.observations.second?.snapshotId])].filter(Boolean));
    const candidates = this.report.snapshots.filter(item => referenced.has(item.snapshotId)), priorities = debugSnapshotPriorities(this.report);
    const priority = [...candidates].sort((left, right) => priorities.get(left.snapshotId)! - priorities.get(right.snapshotId)!);
    const retainedIds = new Set(priority.slice(-this.report.limits.maxSnapshots).map(item => item.snapshotId));
    this.report.snapshots = candidates.filter(item => retainedIds.has(item.snapshotId));
    for (const id of this.trimmed.keys()) if (!retainedIds.has(id)) this.trimmed.delete(id);
    const retained = new Set(this.report.snapshots.map(item => item.snapshotId));
    for (const item of this.report.steps) {
      for (const side of ["before", "after"] as const) {
        if (item[side].snapshotId && !retained.has(item[side].snapshotId)) item[side] = {
          snapshotId: null, freshness: "missing", reason: "快照数量超过上限，未保留该观察。",
        };
        const id = item[side].snapshotId;
        if (id) item.step[side === "before" ? "beforeId" : "afterId"] = id;
        else delete item.step[side === "before" ? "beforeId" : "afterId"];
      }
    }
    this.normalizeTaskEvidence();
  }

  private insufficient(check: DebugTaskCheckResult, reason: string) {
    check.status = "insufficient_evidence"; check.reason = reason;
    check.conditions = check.conditions.map(item => ({ ...item, status: "insufficient_evidence", reason,
      ...(!check.observations.first ? { firstMatchCount: 0, firstNodeId: null } : {}),
      ...(!check.observations.second ? { secondMatchCount: 0, secondNodeId: null } : {}) }));
  }

  private normalizeTaskEvidence() {
    for (const item of this.report.steps) if (item.step.assertionConfirmation && item.verified === true) {
      const { first, second } = item.step.assertionConfirmation;
      const observations = [first, second];
      if (first.snapshotId === second.snapshotId || Date.parse(first.capturedAt) < Date.parse(item.step.time)
        || Date.parse(second.capturedAt) <= Date.parse(first.capturedAt)
        || item.after.freshness !== "current" || item.after.snapshotId !== second.snapshotId
        || observations.some(observation => {
          const saved = this.report.snapshots.find(entry => entry.snapshotId === observation.snapshotId);
          return !saved?.tree || !saved.screenshot || saved.capturedAt !== observation.capturedAt || saved.source !== "accessibility-helper";
        })) item.verified = item.step.verified = null;
    }
    for (const item of this.report.steps) if (item.step.scrollTask && item.verified === true) {
      const confirmation = item.step.scrollTask.confirmation;
      if (!confirmation || item.after.freshness !== "current" || item.after.snapshotId !== confirmation.secondSnapshotId
        || [confirmation.firstSnapshotId, confirmation.secondSnapshotId].some(id => !this.report.snapshots.find(entry => entry.snapshotId === id)?.tree)) {
        // Keep the observed outcome and trace, but a trimmed report no longer proves it.
        item.verified = item.step.verified = null;
      }
    }
    const normalize = (check: DebugTaskCheckResult) => {
      const definition = this.report.task?.definition;
      const conditions = check.checkpointId === null ? definition?.finalConditions
        : definition?.checkpoints.find(item => item.id === check.checkpointId)?.conditions;
      const partial = conditions?.some(condition => condition.visibility === "partial");
      let missing = false;
      for (const side of ["first", "second"] as const) {
        const observation = check.observations[side];
        const snapshot = observation && this.report.snapshots.find(item => item.snapshotId === observation.snapshotId);
        if (observation && !snapshot) check.observations[side] = null;
        if (!snapshot?.tree || partial && !snapshot.screenshot) missing = true;
      }
      if (missing) this.insufficient(check, check.status === "insufficient_evidence" ? check.reason
        : partial ? "partial 缺少已保存的两份验收树或截图，不能确认页面条件。" : "缺少已保存的两份验收树，不能确认页面条件。");
    };
    for (const item of this.report.steps) if (item.step.taskCheck) normalize(item.step.taskCheck);
    for (const check of this.report.task?.checks ?? []) normalize(check);
    if (this.report.task) {
      let prerequisites = true;
      for (const checkpoint of this.report.task.definition.checkpoints) {
        const check = this.report.task.checks.find(item => item.checkpointId === checkpoint.id);
        if (check && !prerequisites) this.insufficient(check, "前置阶段缺少有效通过证据，本阶段结果不能继续作为有效验收。");
        prerequisites = prerequisites && check?.status === "passed";
      }
      const final = this.report.task.checks.find(item => item.checkpointId === null);
      if (final && !prerequisites) this.insufficient(final, "最终验收的前置阶段缺少有效通过证据。");
    }
    for (const item of this.report.steps) if (item.step.taskCheck) {
      const latest = this.report.task?.checks.find(check => check.stepId === item.step.id);
      if (latest) item.step.taskCheck = structuredClone(latest);
      item.verified = item.step.verified = item.step.taskCheck.status === "passed";
      if (item.step.status === "done") item.step.message = item.step.taskCheck.reason;
    }
  }

  private syncTaskState(state: DebugSessionState, record?: DebugReportStep) {
    state.task = structuredClone(this.report.task ?? null);
    for (const step of [...state.steps, ...(record ? [record.step] : [])]) {
      const saved = this.report.steps.find(item => item.step.id === step.id);
      if (!saved) continue;
      if (saved.step.assertionConfirmation) step.verified = saved.verified;
      if (!saved.step.taskCheck) continue;
      step.taskCheck = structuredClone(saved.step.taskCheck); step.verified = saved.verified;
      if (step.status === "done") step.message = saved.step.message;
      if (saved.before.snapshotId) step.beforeId = saved.before.snapshotId; else delete step.beforeId;
      if (saved.after.snapshotId) step.afterId = saved.after.snapshotId; else delete step.afterId;
    }
  }

  private snapshot(entry: McpSnapshot, assets: Map<string, Buffer>, errors: DebugStepError[]): DebugSnapshotEvidence {
    const evidence: DebugSnapshotEvidence = { snapshotId: entry.id, capturedAt: entry.sharedAt,
      source: entry.snapshot.inspectionSource ?? "unknown", tree: null, screenshot: null, warnings: [] };
    const file = (bytes: Buffer, extension: "json" | "png"): DebugReportFile => {
      const digest = sha(bytes), path = `artifacts/${digest}.${extension}`;
      assets.set(path, bytes);
      return { path, sha256: digest, size: bytes.length };
    };
    try {
      const document: DebugSnapshotDocument = { schemaVersion: DEBUG_SNAPSHOT_VERSION, snapshotId: entry.id,
        capturedAt: entry.sharedAt, content: "tree-properties-without-layer-bitmaps", snapshot: debugEvidenceSnapshot(entry.snapshot) };
      const bytes = Buffer.from(JSON.stringify(document));
      if (bytes.length > this.report.limits.maxTreeBytes) evidence.warnings.push("树文件超过单文件上限，未保存树与属性。");
      else evidence.tree = file(bytes, "json");
    } catch (error) {
      evidence.warnings.push(`树留证失败：${explanation(error)}`.slice(0, 16000));
      errors.push(recordingError("tree_serialization_failed", error));
    }
    const dataUrl = entry.snapshot.screenshotDataUrl;
    if (!dataUrl) evidence.warnings.push("该观察没有屏幕截图。");
    else {
      const prefix = "data:image/png;base64,", encoded = dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : "";
      if (encoded.length > Math.ceil(this.report.limits.maxImageBytes / 3) * 4) evidence.warnings.push("截图超过单文件上限，未保存PNG。");
      else if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) evidence.warnings.push("截图不是有效的PNG编码，未保存图片。");
      else {
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.length > this.report.limits.maxImageBytes) evidence.warnings.push("截图超过单文件上限，未保存PNG。");
        else if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") evidence.warnings.push("截图不是PNG，未保存图片。");
        else evidence.screenshot = file(bytes, "png");
      }
    }
    return evidence;
  }

  private files() {
    const files = new Map<string, DebugReportFile>();
    for (const snapshot of this.report.snapshots) for (const file of [snapshot.tree, snapshot.screenshot]) if (file) {
      // A shared image inherits its newest observation's position, rather than its first use.
      files.delete(file.path); files.set(file.path, file);
    }
    for (const step of this.report.steps) for (const log of step.logs ?? []) if (log.file) {
      files.delete(log.file.path); files.set(log.file.path, log.file);
    }
    return files;
  }

  private evictionOrder() {
    const priorities = debugSnapshotPriorities(this.report), files = this.files();
    const priority = new Map<string, number>();
    for (const snapshot of this.report.snapshots) {
      const role = priorities.get(snapshot.snapshotId) ?? -1;
      for (const kind of ["tree", "screenshot"] as const) {
        const file = snapshot[kind];
        // Role wins, then tree before image. Ordinary old trees must not evict
        // the current action's screenshot. Shared PNGs keep their strongest role.
        if (file) priority.set(file.path, Math.max(priority.get(file.path) ?? -3, role * 2 + (kind === "tree" ? 1 : 0)));
      }
    }
    for (const item of this.report.steps) for (const log of item.logs ?? []) if (log.file) priority.set(log.file.path, -3);
    return [...files.values()].sort((left, right) => priority.get(left.path)! - priority.get(right.path)!);
  }

  private omit(path: string, warning: string) {
    for (const snapshot of this.report.snapshots) {
      for (const kind of ["tree", "screenshot"] as const) if (snapshot[kind]?.path === path) {
        if (warning === capacityWarning || warning === imageCountWarning) {
          const expected = this.trimmed.get(snapshot.snapshotId) ?? {};
          expected[kind] = snapshot[kind]!; this.trimmed.set(snapshot.snapshotId, expected);
        }
        snapshot[kind] = null;
        if (!snapshot.warnings.includes(warning)) snapshot.warnings.push(warning);
      }
    }
    for (const step of this.report.steps) for (const log of step.logs ?? []) if (log.file?.path === path) {
      log.file = null; log.status = "unavailable"; log.lineCount = 0; log.reason = warning;
    }
  }

  private serialize() {
    return measureDebugPhaseSync("serialization", () => {
    const fileBytes = [...this.files().values()].reduce((sum, file) => sum + file.size, 0);
    let bytes = Buffer.from(JSON.stringify(this.report));
    for (let attempt = 0; attempt < 8; attempt++) {
      this.report.storage.bytes = fileBytes + bytes.length;
      const next = Buffer.from(JSON.stringify(this.report));
      if (next.length === bytes.length) return next;
      bytes = next;
    }
    throw new Error("证据容量计算失败。");
    });
  }

  private fit(errors: DebugStepError[], record?: DebugReportStep) {
    const requiredIds = new Set(record ? [record.before.snapshotId, record.after.snapshotId,
      record.step.beforeId, record.step.afterId,
      record.step.resolvedInput?.visualConfirmation?.referenceSnapshotId, record.step.resolvedInput?.visualConfirmation?.currentSnapshotId,
      record.step.scrollTask?.confirmation?.firstSnapshotId, record.step.scrollTask?.confirmation?.secondSnapshotId,
      record.step.assertionConfirmation?.first.snapshotId, record.step.assertionConfirmation?.second.snapshotId,
      record.step.taskCheck?.observations.first?.snapshotId, record.step.taskCheck?.observations.second?.snapshotId,
      ...(record.step.scrollTask?.iterations ?? []).flatMap(item => [item.beforeId, item.afterId,
        item.resolvedInput?.visualConfirmation?.referenceSnapshotId, item.resolvedInput?.visualConfirmation?.currentSnapshotId]),
    ] : []);
    const requiredPaths = new Set(this.report.snapshots.filter(snapshot => requiredIds.has(snapshot.snapshotId))
      .flatMap(snapshot => [snapshot.tree, snapshot.screenshot].flatMap(file => file ? [file.path] : [])));
    const omit = (file: DebugReportFile, warning: string) => {
      this.omit(file.path, warning);
      // Historical retention gaps are warnings; only losing this step's evidence blocks it.
      if (!requiredPaths.has(file.path)) return;
      if (!errors.some(error => error.code === capacityIssue.code)) errors.push({ ...capacityIssue });
      if (record) appendDebugRecordingErrors(record.step, [capacityIssue]);
    };
    const images = this.evictionOrder().filter(file => file.path.endsWith(".png"));
    for (const file of images.slice(0, Math.max(0, images.length - this.report.limits.maxImages))) omit(file, imageCountWarning);
    this.normalizeTaskEvidence();
    let bytes = this.serialize();
    while (this.report.storage.bytes > this.report.limits.maxBytes) {
      const file = this.evictionOrder()[0];
      if (!file) throw new Error("步骤元数据超过证据总容量上限，未写入报告。");
      omit(file, capacityWarning);
      this.normalizeTaskEvidence();
      bytes = this.serialize();
    }
    return bytes;
  }

  private persist(assets: Map<string, Buffer>, errors: DebugStepError[] = [], record?: DebugReportStep) {
    privateDirectory(this.directory); privateDirectory(join(this.directory, "artifacts"));
    this.cleanup(this.committed, errors);
    const uncleared = [...this.owned.keys()].some(path => !this.committed.has(path));
    // An unsuccessful cleanup must not accumulate a new set of orphan files on every step.
    if (uncleared) for (const path of assets.keys()) if (!this.committed.has(path)) this.omit(path, "旧附件清理未完成，未继续写入新附件。");
    this.fit(errors, record);
    const taskTrees = new Set([...this.protectedSnapshots(), ...[...this.report.steps.flatMap(item => item.step.taskCheck ? [item.step.taskCheck] : []),
      ...(this.report.task?.checks ?? [])].flatMap(check => [check.observations.first?.snapshotId, check.observations.second?.snapshotId])]
      .map(id => this.report.snapshots.find(item => item.snapshotId === id)?.tree?.path).filter(Boolean));
    try {
      for (const [relative, file] of this.files()) {
        const data = assets.get(relative);
        if (!data && !taskTrees.has(relative)) continue;
        try {
          const path = join(this.directory, relative);
          try {
            const previous = lstatSync(path);
            if (!previous.isFile() || previous.isSymbolicLink() || previous.size !== file.size || sha(readFileSync(path)) !== file.sha256)
              throw new Error("同名证据附件已变化，不能覆盖。");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            if (!data) throw new Error("此前保存的验收树文件已缺失。");
            atomicWrite(path, data);
            const stat = lstatSync(path); this.owned.set(relative, { ino: stat.ino, dev: stat.dev });
          }
        } catch (error) {
          this.omit(relative, `附件写入失败：${explanation(error)}`.slice(0, 16000));
          // Optional log failures are evidence gaps, never action or Checker failures.
          if (!relative.endsWith(".txt")) {
            const issue = recordingError("artifact_write_failed", error); errors.push(issue);
            if (record) appendDebugRecordingErrors(record.step, [issue]);
          }
        }
      }
      atomicWrite(this.path, this.fit(errors, record));
      this.committed = new Set(this.files().keys());
    } catch (error) {
      this.cleanup(this.committed, errors);
      for (const file of this.files().values()) if (!this.committed.has(file.path)) this.omit(file.path, "报告写入失败，附件未提交。");
      throw error;
    }
    this.cleanup(this.committed, errors);
    // Cleanup errors are secondary recording errors, never an action failure.
    if (record && appendDebugRecordingErrors(record.step, errors)) {
      atomicWrite(this.path, this.fit(errors, record));
      this.committed = new Set(this.files().keys());
      this.cleanup(this.committed, errors);
    }
    this.reportSaved = true;
  }

  private cleanup(keep: Set<string>, errors: DebugStepError[]) {
    for (const [relative, identity] of this.owned) {
      if (keep.has(relative)) continue;
      try {
        const path = join(this.directory, relative), stat = lstatSync(path);
        if (stat.ino !== identity.ino || stat.dev !== identity.dev || !stat.isFile() || stat.isSymbolicLink()) {
          this.owned.delete(relative); throw new Error("已移除附件的位置被其他文件替换，未删除该文件。");
        }
        rmSync(path); this.owned.delete(relative);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") this.owned.delete(relative);
        else errors.push(recordingError("artifact_cleanup_failed", error));
      }
    }
  }
}
