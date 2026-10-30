import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  LIVE_PREVIEW_INTERVAL_MS, LIVE_PREVIEW_MAX_PNG_BYTES, LIVE_PREVIEW_MAX_PIXELS, LIVE_PREVIEW_TIMEOUT_MS,
  isLivePreviewSerial, type LivePreviewEvent, type LivePreviewFrame, type LivePreviewState,
  type LivePreviewStopReason,
} from "../../shared/live-preview";
import { captureScreen } from "./screen";
import { findAdbPath, type CommandResult } from "./runtime";
import { pngSize } from "./capture-display";

export class LivePreviewDisconnectedError extends Error {}

// Only the owned screencap child is killed. Resolve after close so a replacement
// frame or a higher-priority capture cannot overlap a child that is still alive.
export function runPreviewScreenCommand(adbPath: string, serial: string, signal: AbortSignal,
  timeoutMs = LIVE_PREVIEW_TIMEOUT_MS): Promise<CommandResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(adbPath, ["-s", serial, "exec-out", "screencap", "-p"],
      { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [], errors: Buffer[] = [];
    let bytes = 0, errorBytes = 0, failure: unknown;
    const stop = (error: unknown) => {
      failure ??= error;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      else { child.stdout?.destroy(); child.stderr?.destroy(); }
    };
    const abort = () => stop(signal.reason ?? Error("预览已取消。"));
    const timer = setTimeout(() => stop(Error("预览截图超时，已暂停。")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout!.on("data", (chunk: Buffer) => {
      if (bytes < LIVE_PREVIEW_MAX_PNG_BYTES) chunks.push(Buffer.from(chunk.subarray(0, LIVE_PREVIEW_MAX_PNG_BYTES - bytes)));
      bytes += chunk.length;
      if (bytes > LIVE_PREVIEW_MAX_PNG_BYTES) stop(Error("预览截图超过 8 MiB，已暂停。"));
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (errorBytes < 4096) errors.push(Buffer.from(chunk.subarray(0, 4096 - errorBytes)));
      errorBytes += chunk.length;
      if (errorBytes > 4096) stop(Error("预览截图错误输出过长，已暂停。"));
    });
    child.once("error", error => { failure ??= error; });
    child.once("exit", () => {
      if (failure) { child.stdout?.destroy(); child.stderr?.destroy(); }
    });
    child.once("close", code => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors).toString("utf8") });
    });
  });
}

export type LivePreviewImage = Pick<LivePreviewFrame, "screenshotDataUrl" | "size">;

export async function captureLivePreviewScreen(serial: string, signal: AbortSignal): Promise<LivePreviewImage> {
  if (!isLivePreviewSerial(serial)) throw Error("预览设备无效。");
  signal.throwIfAborted();
  const adbPath = findAdbPath();
  if (!adbPath) throw new LivePreviewDisconnectedError("未找到 ADB，预览已关闭。");
  const capture = await captureScreen(adbPath, serial, {
    readGeometry: false,
    runScreenshot: (path, device) => runPreviewScreenCommand(path, device, signal),
  });
  signal.throwIfAborted();
  if (capture.result.code !== 0) {
    const detail = capture.result.stderr.trim();
    if (/device.*(?:offline|not found|unauthorized)|no devices|device disconnected|error:\s*closed/i.test(detail))
      throw new LivePreviewDisconnectedError("设备已断开或未授权，预览已关闭。");
    throw Error("无法读取设备截图，已暂停。请检查设备后继续。");
  }
  const size = pngSize(capture.result.stdout);
  if (!capture.screenshotDataUrl || !size) throw Error("设备未返回有效 PNG，预览已暂停。");
  if (size.width * size.height > LIVE_PREVIEW_MAX_PIXELS) throw Error("预览截图尺寸过大，已暂停。");
  return { screenshotDataUrl: capture.screenshotDataUrl, size };
}

export type LivePreviewControllerOptions = {
  capture?: (serial: string, signal: AbortSignal) => Promise<LivePreviewImage>;
  isBusy: () => boolean;
  onEvent: (event: LivePreviewEvent) => void;
  now?: () => number;
  // Returns a cancellation function. Tests use a deterministic timer queue.
  setTimer?: (callback: () => void, milliseconds: number) => () => void;
  sessionId?: () => string;
};

export class LivePreviewController {
  private state: LivePreviewState;
  private frame: LivePreviewFrame | null = null;
  private generation = 0;
  private sequence = 0;
  private cancelTimer: (() => void) | null = null;
  private work: { controller: AbortController; done: Promise<void> } | null = null;
  private disposed = false;
  private readonly capture: NonNullable<LivePreviewControllerOptions["capture"]>;
  private readonly now: NonNullable<LivePreviewControllerOptions["now"]>;

  constructor(private readonly options: LivePreviewControllerOptions) {
    this.capture = options.capture ?? captureLivePreviewScreen;
    this.now = options.now ?? Date.now;
    this.state = { sessionId: null, serial: null, revision: 0, status: "stopped", activity: "idle",
      intervalMs: LIVE_PREVIEW_INTERVAL_MS, startedAt: null, updatedAt: this.timestamp(),
      frameCapturedAt: null, error: null, stopReason: null };
  }

  getEvent(): LivePreviewEvent {
    return { state: { ...this.state }, frame: this.frame ? { ...this.frame, size: { ...this.frame.size } } : null };
  }

  async start(serial: string): Promise<LivePreviewEvent> {
    if (this.disposed) throw Error("预览窗口已关闭。");
    if (!isLivePreviewSerial(serial)) throw Error("预览设备无效。");
    // Each viewer opening gets its own identity, including StrictMode remounts.
    // Cleanup of a delayed prior start cannot close a newer opening on this device.
    this.cancelPending(); this.generation++; this.sequence = 0; this.frame = null;
    const sessionId = (this.options.sessionId ?? randomUUID)();
    this.change({ sessionId, serial, status: "running", activity: "idle", startedAt: this.timestamp(),
      frameCapturedAt: null, error: null, stopReason: null }, null);
    const initial = this.getEvent();
    await this.settled();
    if (this.state.sessionId === sessionId && this.state.status === "running" && !this.disposed) this.schedule(0);
    return this.state.sessionId === sessionId ? this.getEvent() : initial;
  }

  async pause(sessionId: string): Promise<LivePreviewEvent> {
    if (!this.matches(sessionId) || this.state.status !== "running") return this.getEvent();
    this.cancelPending(); this.generation++;
    this.change({ status: "paused", activity: "idle" });
    const paused = this.getEvent();
    await this.settled();
    return this.state.sessionId === sessionId ? this.getEvent() : paused;
  }

  async resume(sessionId: string): Promise<LivePreviewEvent> {
    if (!this.matches(sessionId) || this.state.status !== "paused") return this.getEvent();
    this.change({ status: "running", activity: "idle", error: null });
    const resumed = this.getEvent();
    await this.settled();
    if (this.matches(sessionId) && this.running()) this.schedule(0);
    return this.state.sessionId === sessionId ? this.getEvent() : resumed;
  }

  async stop(reason: LivePreviewStopReason = "closed", sessionId?: string): Promise<LivePreviewEvent> {
    if (sessionId !== undefined && !this.matches(sessionId)) return this.getEvent();
    this.cancelPending(); this.generation++; this.frame = null;
    this.change({ status: "stopped", activity: "idle", frameCapturedAt: null, error: null, stopReason: reason }, null);
    const stopped = this.getEvent();
    await this.settled();
    return this.state.sessionId === stopped.state.sessionId ? this.getEvent() : stopped;
  }

  // The caller marks its higher-priority operation busy before awaiting this.
  // Aborted frames are discarded even when a capture implementation ignores abort.
  async yieldForCapture(): Promise<void> {
    this.cancelPending();
    if (this.state.status === "running") this.change({ activity: "waiting" });
    await this.settled();
    if (this.state.status === "running" && !this.disposed) this.schedule(LIVE_PREVIEW_INTERVAL_MS);
  }

  async dispose(reason: LivePreviewStopReason = "window-closed"): Promise<void> {
    this.disposed = true;
    await this.stop(reason);
  }

  async settled(): Promise<void> {
    await this.work?.done;
  }

  private timestamp() { return new Date(this.now()).toISOString(); }
  private running() { return !this.disposed && this.state.status === "running"; }
  private matches(sessionId: string) { return !this.disposed && this.state.sessionId === sessionId; }
  private cancelPending() {
    this.cancelTimer?.(); this.cancelTimer = null;
    this.work?.controller.abort(Error("预览已取消。"));
  }
  private change(patch: Partial<LivePreviewState>, frame?: LivePreviewFrame | null) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1, updatedAt: this.timestamp() };
    const event: LivePreviewEvent = { state: { ...this.state }, ...(frame !== undefined ? { frame } : {}) };
    this.options.onEvent(event);
  }
  private schedule(delay: number) {
    this.cancelTimer?.();
    if (this.disposed || this.state.status !== "running") { this.cancelTimer = null; return; }
    const callback = () => { this.cancelTimer = null; this.tick(); };
    this.cancelTimer = this.options.setTimer ? this.options.setTimer(callback, delay) : (() => {
      const timer = setTimeout(callback, delay); timer.unref?.();
      return () => clearTimeout(timer);
    })();
  }
  private tick() {
    if (this.disposed || this.state.status !== "running" || this.work || !this.state.serial || !this.state.sessionId) return;
    if (this.options.isBusy()) {
      if (this.state.activity !== "waiting") this.change({ activity: "waiting" });
      this.schedule(LIVE_PREVIEW_INTERVAL_MS); return;
    }
    const serial = this.state.serial, sessionId = this.state.sessionId, generation = this.generation;
    const controller = new AbortController();
    this.change({ activity: "capturing" });
    const current = () => !controller.signal.aborted && !this.disposed && this.generation === generation
      && this.state.sessionId === sessionId && this.state.status === "running";
    const work = { controller, done: Promise.resolve() };
    this.work = work;
    work.done = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return this.capture(serial, controller.signal);
    }).then(image => {
      if (!current() || this.options.isBusy()) return;
      const capturedAt = this.timestamp();
      this.frame = { ...image, size: { ...image.size }, serial, sessionId, sequence: ++this.sequence, capturedAt };
      this.change({ activity: "idle", frameCapturedAt: capturedAt, error: null }, this.frame);
    }).catch(error => {
      if (!current()) return;
      if (error instanceof LivePreviewDisconnectedError) {
        this.generation++; this.frame = null;
        this.change({ status: "stopped", activity: "idle", frameCapturedAt: null, error: null,
          stopReason: "device-disconnected" }, null);
      } else this.change({ status: "paused", activity: "idle",
        error: error instanceof Error ? error.message.slice(0, 240) : "截图失败，预览已暂停。" });
    }).finally(() => {
      if (this.work === work) this.work = null;
      if (!this.disposed && this.state.status === "running") {
        if (this.state.activity === "capturing") this.change({ activity: this.options.isBusy() ? "waiting" : "idle" });
        this.schedule(LIVE_PREVIEW_INTERVAL_MS);
      }
    });
  }
}
