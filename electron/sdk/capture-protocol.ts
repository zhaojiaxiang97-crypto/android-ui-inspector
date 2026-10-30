import type { UiBounds, UiNode, ViewStyleResult } from "../../shared/types";
import { matchesViewRoot } from "../capture/view-protocol";
import { MAX_POSITION_DRIFT_PX } from "./sdk-hybrid";


export function windowAcceleration(root: UiNode) {
  const nativeAcceleration = root.children[0]?.attributes?.["hardware-accelerated"];
  return nativeAcceleration ?? root.attributes?.["sdk-window-hardware-accelerated"] ?? root.children[0]?.attributes?.["sdk-hardwareAccelerated"];
}

export function assertSafeSoftwareSdkCapture(root: UiNode) {
  // Legacy IsolatedCapture always constructs a HardwareCanvasProvider. Do not
  // reach it on a confirmed software window; the new wake version accompanies
  // the SDK fix that selects a software canvas for these windows.
  if (windowAcceleration(root) === "false" && root.attributes?.["sdk-ui-wake-version"] !== "1")
    throw new Error("软件窗口需要新版 SDK 的安全唤醒能力，已停止旧硬件渲染取图");
}

export function isStaleCaptureTreeError(error: unknown): boolean {
  return error instanceof Error && /^(Debug 窗口与当前控件树不一致|Debug 窗口身份已变化|SDK 特殊画面控件与当前控件树不一致|SDK 纯布局控件与当前控件树不一致|SDK 已发布控件树在绘制(?:前|期间)变化|SDK 可见层中 \d+ 个移动、\d+ 个尺寸或状态变化)/.test(error.message);
}

/** A busy SDK is not an unsupported SDK. Do not start another full capture on its UI thread. */
export function isSdkVisibleCaptureInterruption(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (error instanceof SdkMergedTreeFailure) return true;
  return /^SDK 可见层抓取失败：[\s\S]*?(?:View (?:capture|selection) timed out|View capture could not reach UI thread|Visible capture time budget exceeded|java\.lang\.InterruptedException)/.test(error.message)
    || /^会话调用超时：capture-visible$/.test(error.message);
}

/** A failed UI-thread request must not be repeated through JDWP on the same busy app. */
export async function captureSdkRefOrFallback<T>(capture: () => Promise<T>, fallback: () => Promise<T>,
  reportError: (error: unknown) => void, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  try {
    return await capture();
  } catch (error) {
    signal?.throwIfAborted();
    reportError(error);
    if (error instanceof Error && (/^SDK 补齐抓取失败：[\s\S]*?(?:View (?:capture|selection) timed out|View capture could not reach UI thread|Visible capture time budget exceeded|java\.lang\.InterruptedException)/.test(error.message)
      || /^会话调用超时：capture-refs$/.test(error.message))) throw error;
  }
  signal?.throwIfAborted();
  return fallback();
}

export function markFailedSupplementImages(root: UiNode, nodes: UiNode[], error: unknown): void {
  for (const node of nodes) {
    if (node.layerImageDataUrl) continue;
    node.layerImageStatus = "failed";
    node.attributes = { ...node.attributes, "image-capture-error": node.attributes?.["image-capture-error"]
      ?? `独立画面补采中断：${error instanceof Error ? error.message : "采集失败"}` };
  }
  root.attributes = { ...root.attributes, "texture-capture-warning": "部分控件的独立画面补采失败，已保留此前采集结果。" };
}

export function markInterruptedSdkImages(root: UiNode, error: Error): void {
  root.attributes = { ...root.attributes, "sdk-visible-interrupted": error.message };
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    pending.push(...node.children);
    // A partial preview is not a completed capture. Unmeasured containers are also
    // unresolved; do not misreport a partial page as zero failures / fully verified.
    if (!node.attributes?.["view-ref"] || !node.visibleToUser || node.layerImageDataUrl
        || node.layerImageEmpty === true || node.layerImageStatus === "style" || node.layerImageStatus === "hidden") continue;
    node.layerImageStatus = "failed";
    node.attributes = { ...node.attributes, "image-capture-error": "SDK 采集中断，此控件尚无独立画面证据。" };
  }
}

/** Failure telemetry is optional and never authorizes images, geometry or success. */
function parseSdkFailureTiming(raw: string | undefined, wait: number, phase: string): string | undefined {
  if (!raw || raw.length > 2048) return;
  try {
    const value = JSON.parse(raw);
    const events = ["enteredMs", "snapshotStartedMs", "snapshotReturnedMs"];
    const totals = ["queueMs", "geometryMs", "drawMs", "verifyMs", "snapshotPrepareMs", "snapshotInvokeMs"];
    if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
        || value.observedMs !== wait || Object.keys(value).some(k => !["version", "observedMs", ...events, ...totals].includes(k))
        || totals.some(k => !Number.isSafeInteger(value[k]) || value[k] < 0 || value[k] > 65000)) return;
    let previous = 0, missing = false;
    for (const key of events) {
      if (value[key] === undefined) { missing = true; continue; }
      if (missing || !Number.isSafeInteger(value[key]) || value[key] < previous || value[key] > wait) return;
      previous = value[key];
    }
    if (phase === "ui-queue" ? value.enteredMs !== undefined : value.enteredMs === undefined) return;
    if (["geometry", "draw", "draw-prepare"].includes(phase) && value.snapshotStartedMs !== undefined) return;
    if (phase === "draw-snapshot" && value.snapshotStartedMs === undefined) return;
    return JSON.stringify(value);
  } catch { return; }
}

export function parseSdkCaptureFailure(field: (name: string) => string | undefined, nonce: string, rootRef: string, instance?: string): Record<string, string> | null {
  const phase = field("failurePhase"), target = field("failureTarget"), wait = field("failureWaitMs"), completed = field("failureCompleted");
  if (field("result") === "ok" || !field("error")?.includes("View capture timed out") || field("nonce") !== nonce
      || !matchesViewRoot(rootRef, field("rootRef") ?? "") || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(field("processInstance") ?? "")
      || instance !== undefined && field("processInstance") !== instance
      || !phase || !["ui-queue", "geometry", "draw", "draw-prepare", "draw-snapshot", "verify"].includes(phase)
      || !target || target.length > 256 || !/^[\w.$]+@[0-9a-f]{1,8}$/i.test(target)
      || !wait || !/^\d+$/.test(wait) || Number(wait) > 65000
      || !completed || !/^\d+$/.test(completed) || Number(completed) > 5000) return null;
  const started = field("failurePhaseStartedMs"), phaseWait = field("failurePhaseWaitMs");
  if (started !== undefined || phaseWait !== undefined) {
    if (!started || !phaseWait || !/^\d+$/.test(started) || !/^\d+$/.test(phaseWait)
        || Number(started) > Number(wait) || Number(phaseWait) > Number(wait)
        || Math.abs(Number(started) + Number(phaseWait) - Number(wait)) > 1) return null;
  }
  const timing = parseSdkFailureTiming(field("failureTiming"), Number(wait), phase);
  return { "sdk-visible-failure-phase": phase, "sdk-visible-failure-target": target,
    "sdk-visible-failure-wait-ms": wait, "sdk-visible-failure-completed": completed,
    ...(timing !== undefined ? { "sdk-visible-failure-timing": timing } : {}),
    ...(started !== undefined && phaseWait !== undefined ? { "sdk-visible-failure-phase-started-ms": started,
      "sdk-visible-failure-phase-wait-ms": phaseWait } : {}) };
}

/** Wait for the provider request, not the image promise (which itself waits for tree adoption). */
export async function settleSdkMergedTree<T>(request: Promise<T>, readTree: () => Promise<unknown | undefined>, onTree: (tree: unknown) => Promise<void>, onMissing: () => void,
  checkOutcome: (outcome: T) => void = () => {}): Promise<T> {
  const outcome = await request;
  checkOutcome(outcome);
  const tree = await readTree();
  if (tree === undefined) onMissing();
  else await onTree(tree);
  return outcome;
}

export class SdkMergedTreeFailure extends Error {}

/** Failure-only guard: never accepts a tree/image or relaxes its identity checks. */
export function checkSdkMergedTreeOutcome(outcome: { reply: { stdout: Buffer; code: number | null } | null; error: unknown }, nonce: string,
  processInstance?: string): void {
  if (outcome.error) {
    if (isSdkVisibleCaptureInterruption(outcome.error) || outcome.error instanceof Error && outcome.error.name === "AbortError") throw outcome.error;
    return; // Existing unsupported/transport compatibility stays unchanged.
  }
  if (!outcome.reply) return;
  const output = outcome.reply.stdout.toString("utf8");
  const field = (name: string) => new RegExp(`\\b${name}=([^,}\\]]+)`).exec(output)?.[1]?.trim();
  const failure = field("treeFailure");
  if (failure !== undefined) {
    if (outcome.reply.code !== 0 || field("tree") !== "failed" || field("nonce") !== nonce
        || processInstance !== undefined && field("processInstance") !== processInstance
        || !["ui-timeout", "ui-unavailable", "interrupted"].includes(failure))
      throw new SdkMergedTreeFailure("SDK 合并控件树失败响应无效，请重新采集。");
    throw new SdkMergedTreeFailure(failure === "ui-timeout"
      ? "SDK 控件树超时：合并任务未在期限内完成，已停止重复取树。"
      : "SDK 合并控件树无法执行：主线程不可用或请求已中断，已停止重复取树。");
  }
  // Old SDK replies lack treeFailure; their explicit drawing/selection timeout still
  // must not release the missing-tree latch and enqueue a classic tree.
  const error = field("error");
  if (error) {
    const failure = new Error(`SDK 可见层抓取失败：${error}`);
    if (isSdkVisibleCaptureInterruption(failure)) throw failure;
  }
}

/** Optional telemetry only; malformed fields must not invalidate otherwise verified pixels. */
export function parseSdkTaskDiagnostics(field: (key: string) => string | undefined): Record<string, string> {
  const buckets = field("uiQueueBuckets"), max = field("uiQueueMaxMs"), slow = field("uiSlowTasks");
  const integer = (value: string | undefined, limit: number) => value !== undefined && /^\d+$/.test(value) && Number(value) <= limit;
  if (!buckets || buckets.length > 40 || !integer(max, 65000) || !slow || slow.length > 3000) return {};
  const counts = buckets.split(";");
  if (counts.length !== 5 || !counts.every(v => integer(v, 5000)) || counts.reduce((sum, n) => sum + Number(n), 0) > 5000) return {};
  const tasks = slow === "-" ? [] : slow.split(";");
  if (tasks.length > 8 || !tasks.every(task => {
    const parts = task.split("|");
    return parts.length === 4 && parts[0].length <= 256 && /^[\w.$]+@[0-9a-f]{1,8}$/i.test(parts[0])
      && parts.slice(1).every(v => integer(v, 65000)) && Number(parts[2]) <= Number(max)
      && Math.max(Number(parts[2]), Number(parts[3])) >= 50;
  })) return {};
  return { "sdk-task-queue-buckets": buckets, "sdk-task-queue-max-ms": max!, "sdk-task-slow": slow };
}

export function parsePureViewRefs(value: string | undefined): Set<string> {
  if (value === undefined || value === "-") return new Set(); // Older SDKs did not report this hint.
  const entries = value.split(";");
  const refs = new Set(entries);
  if (value.length > 16_000 || refs.size !== entries.length || !entries.every((entry) => /^[\w.$]+@[0-9a-f]{1,8}$/i.test(entry))) {
    throw new Error("SDK 纯布局控件身份无效");
  }
  return refs;
}

export function parseSdkCapturePhases(field: (name: string) => string | undefined): Record<string, number> {
  const names = { uiQueueMs: "SDK 主线程排队", geometryMs: "SDK 几何读取", drawMs: "SDK 独立图绘制", verifyMs: "SDK 绘制后校验" };
  const snapshotNames = { snapshotPrepareMs: "SDK 截图接口准备", snapshotInvokeMs: "SDK 截图调用", uiTaskMaxMs: "SDK 最长主线程任务", snapshotInvokeMaxMs: "SDK 最长截图调用" };
  const cpuNames = { geometryCpuMs: "SDK 几何读取 CPU", drawCpuMs: "SDK 独立图绘制 CPU", verifyCpuMs: "SDK 绘制后校验 CPU", encodeCpuMs: "SDK 编码 CPU", geometryWriteCpuMs: "SDK 几何文件构建 CPU" };
  const geometryNames = { geometryJsonMs: "SDK 几何 JSON 序列化", geometryUtf8Ms: "SDK 几何 UTF-8 转换", geometryDiskMs: "SDK 几何文件写入", geometryJsonCpuMs: "SDK 几何 JSON 序列化 CPU", geometryUtf8CpuMs: "SDK 几何 UTF-8 转换 CPU", geometryDiskCpuMs: "SDK 几何文件写入 CPU" };
  if ([...Object.keys(names), ...Object.keys(snapshotNames), ...Object.keys(cpuNames), ...Object.keys(geometryNames), "geometryWriteMs"].every(key => field(key) === undefined)) return {};
  const phases: Record<string, number> = {};
  for (const [key, label] of Object.entries(names)) {
    const value = Number(field(key));
    if (!Number.isSafeInteger(value) || value < 0 || value > 65_000) throw new Error("SDK 采集分阶段计时无效");
    phases[label] = value;
  }
  if (field("geometryWriteMs") !== undefined) {
    const value = Number(field("geometryWriteMs"));
    // Two bounded workers accumulate overlapping task time; it may exceed wall duration.
    if (!Number.isSafeInteger(value) || value < 0 || value > 130_000) throw new Error("SDK 几何文件计时无效");
    phases["SDK 几何文件构建"] = value;
  }
  for (const [key, label] of Object.entries(snapshotNames)) {
    if (field(key) === undefined) continue;
    const value = Number(field(key));
    if (!Number.isSafeInteger(value) || value < 0 || value > 65_000) throw new Error("SDK 截图分阶段计时无效");
    phases[label] = value;
  }
  for (const [key, label] of Object.entries(cpuNames)) {
    if (field(key) === undefined) continue;
    const value = Number(field(key));
    const limit = key === "encodeCpuMs" || key === "geometryWriteCpuMs" ? 130_000 : 65_000;
    if (!Number.isSafeInteger(value) || value < 0 || value > limit) throw new Error("SDK 线程 CPU 计时无效");
    phases[label] = value;
  }
  for (const [key, label] of Object.entries(geometryNames)) {
    if (field(key) === undefined) continue;
    const value = Number(field(key));
    const limit = key.startsWith("geometryDisk") ? 65_000 : 130_000;
    if (!Number.isSafeInteger(value) || value < 0 || value > limit) throw new Error("SDK 几何构建分阶段计时无效");
    phases[label] = value;
  }
  return phases;
}

export function parseViewStyleReply(output: string, ref: string, rootRef: string, instance: string, bounds: UiBounds): ViewStyleResult {
  const match = /^Result: Bundle\[\{([^\r\n]{0,2048})\}\]$/.exec(output.trim());
  if (!match) throw new Error("目标 App 的样式读取失败；请确认 Debug SDK 已更新。");
  const fields = new Map<string, string>();
  for (const entry of match[1].split(", ")) {
    const separator = entry.indexOf("=");
    if (separator < 1 || fields.has(entry.slice(0, separator))) throw new Error("样式数据格式无效。");
    fields.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  if (fields.get("result") !== "ok") throw new Error("目标 App 未能读取此控件样式；请确认 Debug SDK 已更新。");
  if (fields.get("ref") !== ref || fields.get("rootRef") !== rootRef || fields.get("processInstance") !== instance)
    throw new Error("控件或窗口身份已变化，请重新采集整页。");
  const coordinate = (key: string) => {
    const raw = fields.get(key);
    if (!raw || !/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("样式数据中的控件尺寸无效。");
    return Number(raw);
  };
  if (Math.abs(coordinate("x") - bounds.left) > MAX_POSITION_DRIFT_PX
      || Math.abs(coordinate("y") - bounds.top) > MAX_POSITION_DRIFT_PX
      || coordinate("width") !== bounds.right - bounds.left || coordinate("height") !== bounds.bottom - bounds.top)
    throw new Error("控件位置或尺寸已变化，请刷新控件后再读取样式。");
  const capturedAtMillis = coordinate("capturedAtMillis");
  if (capturedAtMillis < 1) throw new Error("样式采集时间无效。");
  const backgroundType = fields.get("backgroundType") ?? null;
  const backgroundColor = fields.get("backgroundColor") ?? null;
  const textColor = fields.get("textColor") ?? null;
  const rawSize = fields.get("textSizePx");
  const textSizePx = rawSize === undefined ? null : Number(rawSize);
  if (backgroundType !== null && !/^[\w.$]{1,512}$/.test(backgroundType)
      || backgroundColor !== null && (!backgroundType || !/^#[0-9A-F]{8}$/.test(backgroundColor))
      || textColor !== null && !/^#[0-9A-F]{8}$/.test(textColor)
      || (textColor === null) !== (rawSize === undefined)
      || textSizePx !== null && (!Number.isFinite(textSizePx) || textSizePx <= 0 || textSizePx > 10_000))
    throw new Error("样式数据无效。");
  return { ref, capturedAtMillis, backgroundType, backgroundColor, textColor, textSizePx };
}
