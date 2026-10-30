import { isSdkVisibleCaptureInterruption, isStaleCaptureTreeError } from "../sdk/capture-protocol";
import { StartupRetryBudgetError } from "./startup-retry-budget";

export type CaptureFailureReason = "startup-transient" | "initializing" | "sdk-tree-timeout" | "sdk-tree-mismatch"
  | "published-tree-changed" | "stale-tree" | "debug-properties" | "debug-connect-timeout" | "command-timeout"
  | "sdk-interrupted" | "sdk-tree-interrupted" | "startup-budget" | "readiness-timeout" | "other";
export type CaptureFailure = { reason: CaptureFailureReason; message: string; error: unknown };
export class CaptureError extends Error {
  constructor(readonly reason: CaptureFailureReason, message: string, readonly original?: unknown) { super(message); this.name = "CaptureError"; }
}

/** Compatibility boundary for errors from legacy device/protocol adapters and caller callbacks. */
export function classifyCaptureFailure(error: unknown): CaptureFailure {
  const message = error instanceof Error ? error.message : "读取 Debug 控件树失败。";
  const failure = (reason: CaptureFailureReason): CaptureFailure => ({ reason, message, error });
  if (error instanceof CaptureError) return failure(error.reason);
  if (error instanceof StartupRetryBudgetError) return failure("startup-budget");
  if (!(error instanceof Error)) return failure("other");
  if (/^SDK 已发布控件树在绘制(?:前|期间)变化/.test(message)) return failure("published-tree-changed");
  if (message.startsWith("App 仍在启动")) return failure("startup-transient");
  if (message.includes("App 正在初始化")) return failure("initializing");
  if (/SDK 控件树(?:连续)?超时/.test(message)) return failure(isSdkVisibleCaptureInterruption(error) ? "sdk-tree-interrupted" : "sdk-tree-timeout");
  if (message.startsWith("SDK 与独立画面的")) return failure("sdk-tree-mismatch");
  if (isStaleCaptureTreeError(error)) return failure("stale-tree");
  if (isSdkVisibleCaptureInterruption(error)) return failure("sdk-interrupted");
  if (message.includes("Debug V2")) return failure("debug-properties");
  if (message.includes("Debug View 连接超时")) return failure("debug-connect-timeout");
  if (message.startsWith("命令执行超时")) return failure("command-timeout");
  if (message.startsWith("前台 App 在 18 秒内未准备好")) return failure("readiness-timeout");
  return failure("other");
}

export function shouldRetryCapture(failure: CaptureFailure | null, remainingMs: number, singleAttempt = false) {
  return !singleAttempt && failure?.reason === "startup-transient" && Number.isFinite(remainingMs) && remainingMs > 2_000;
}
export function startupImageFailure(failure: CaptureFailure, startupWaited: boolean) {
  return failure.reason === "stale-tree" || failure.reason === "debug-properties" || failure.reason === "initializing"
    || startupWaited && (failure.reason === "sdk-tree-timeout" || failure.reason === "sdk-tree-interrupted" || failure.reason === "debug-connect-timeout");
}
export function blocksSdkCompatibility(failure: CaptureFailure) {
  return isSdkInterruption(failure) || failure.reason === "stale-tree" || failure.reason === "published-tree-changed"
    || failure.reason === "initializing" || failure.reason === "sdk-tree-timeout";
}

export function isSdkInterruption(failure: CaptureFailure) {
  return failure.reason === "sdk-interrupted" || failure.reason === "sdk-tree-interrupted";
}
