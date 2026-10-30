import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptureError, blocksSdkCompatibility, classifyCaptureFailure, isSdkInterruption, shouldRetryCapture, startupImageFailure } from "../electron/capture/capture-errors";
import { StartupRetryBudgetError } from "../electron/capture/startup-retry-budget";
import { SdkMergedTreeFailure } from "../electron/sdk/capture-protocol";

const failure = (message: string) => classifyCaptureFailure(new Error(message));

test("legacy boundary messages become explicit reasons without changing their text or identity", () => {
  for (const [message, reason] of [
    ["App 仍在启动，等待页面", "startup-transient"], ["App 正在初始化：层级变化", "initializing"],
    ["SDK 控件树超时：目标 App 页面尚未就绪", "sdk-tree-timeout"], ["SDK 控件树连续超时：目标 App 页面尚未就绪", "sdk-tree-timeout"],
    ["SDK 与独立画面的节点位置不同", "sdk-tree-mismatch"], ["Debug 窗口与当前控件树不一致", "stale-tree"],
    ["SDK 已发布控件树在绘制期间变化", "published-tree-changed"], ["Debug V2 导出失败", "debug-properties"],
    ["Debug View 连接超时", "debug-connect-timeout"], ["命令执行超时：adb", "command-timeout"],
    ["前台 App 在 18 秒内未准备好控件树和焦点窗口", "readiness-timeout"], ["unknown", "other"],
  ] as const) {
    const error = new Error(message), result = classifyCaptureFailure(error);
    assert.equal(result.reason, reason); assert.equal(result.message, message); assert.equal(result.error, error);
  }
});

test("only transient startup outcomes retry inside the remaining request budget", () => {
  const transient = failure("App 仍在启动");
  for (const remaining of [NaN, Infinity, -1, 0, 1999, 2000]) assert.equal(shouldRetryCapture(transient, remaining), false);
  assert.equal(shouldRetryCapture(transient, 2001), true); assert.equal(shouldRetryCapture(transient, 45000, true), false);
  for (const stopped of [failure("前台 App 在 18 秒内未准备好"), failure("SDK 已发布控件树在绘制前变化"), classifyCaptureFailure(new StartupRetryBudgetError()), null])
    assert.equal(shouldRetryCapture(stopped, 45000), false);
});

test("typed outcomes remain authoritative even when display text changes", () => {
  const transient = classifyCaptureFailure(new CaptureError("startup-transient", "display text"));
  assert.equal(shouldRetryCapture(transient, 45000), true);
  assert.equal(shouldRetryCapture(classifyCaptureFailure(new CaptureError("other", "App 仍在启动")), 45000), false);
});

test("startup image conversion preserves warm/cold differences and never retries published trees", () => {
  for (const message of ["Debug V2 failed", "App 正在初始化", "Debug 窗口身份已变化"])
    assert.equal(startupImageFailure(failure(message), false), true);
  for (const message of ["SDK 控件树超时", "Debug View 连接超时"]) {
    assert.equal(startupImageFailure(failure(message), false), false); assert.equal(startupImageFailure(failure(message), true), true);
  }
  const published = failure("SDK 已发布控件树在绘制期间变化");
  assert.equal(startupImageFailure(published, true), false); assert.equal(blocksSdkCompatibility(published), true);
});

test("merged-tree timeouts retain interruption semantics and cannot open compatibility capture", () => {
  const merged = classifyCaptureFailure(new SdkMergedTreeFailure("SDK 控件树超时：合并任务未在期限内完成，已停止重复取树。"));
  assert.equal(merged.reason, "sdk-tree-interrupted"); assert.equal(isSdkInterruption(merged), true); assert.equal(blocksSdkCompatibility(merged), true);
  assert.equal(startupImageFailure(merged, false), false); assert.equal(startupImageFailure(merged, true), true);
  const identity = classifyCaptureFailure(new SdkMergedTreeFailure("SDK 树就绪通知与实际控件树实例不一致"));
  assert.equal(isSdkInterruption(identity), true); assert.equal(blocksSdkCompatibility(identity), true);
  assert.equal(blocksSdkCompatibility(failure("protocol unsupported")), false);
});
