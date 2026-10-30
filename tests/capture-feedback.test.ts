import assert from "node:assert/strict";
import { test } from "node:test";
import { captureFeedback, rememberCaptureFailures } from "../shared/capture-feedback";
import { createCaptureReadiness } from "../shared/capture-readiness";
import { recordCaptureAttempt } from "../shared/capture-attempts";
import type { UiSnapshot } from "../shared/types";

const failed = (error = "前台 App 在 18 秒内未准备好控件树和焦点窗口：超时"): UiSnapshot => ({ serial: "sample",
  root: null, nodeCount: 0, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error, warning: null });
const focus = { component: "sample/.Main", windowId: "abc", activityRecordId: "def" };

test("early budget exit still reports missing focus with actual elapsed time, not a tree timeout", () => {
  const error = "前台 App 在 18 秒内未准备好控件树和焦点窗口，请等待页面就绪后重试。窗口确认：无法确认焦点窗口：系统焦点为空，窗口尚未就绪。剩余就绪预算不足 1.5 秒，已提前停止，避免中途打断系统查询。";
  const readiness = createCaptureReadiness(18000, () => 16541);
  readiness.phase("focus-before");
  const s = { ...failed(error), captureReadiness: readiness.snapshot(error) };
  assert.equal(captureFeedback(s, error).title, "App 窗口尚未就绪");
  assert.deepEqual(captureFeedback(s, error).timing, ["就绪检查 16.54 秒"]);
  assert.equal(s.captureReadiness.treeReadCount, 0);
  assert.equal(rememberCaptureFailures([], s, "cold-start")[0].error, error);
});

test("missing window is distinct from confirmed window with tree timeout", async () => {
  let ms = 0; const r = createCaptureReadiness(18000, () => ms);
  r.phase("focus-before"); ms = 18000;
  const s = { ...failed(), captureReadiness: r.snapshot("timeout") };
  assert.equal(captureFeedback(s, s.error).title, "App 窗口尚未就绪");
  assert.deepEqual(captureFeedback(s, s.error).timing, ["就绪检查 18.00 秒"]);
  ms = 14000; r.focused(focus);
  await r.read(async () => { ms = 18000; }); s.captureReadiness = r.snapshot("timeout");
  assert.equal(captureFeedback(s, s.error).title, "控件树读取超时");
  assert.ok(captureFeedback(s, s.error).timing.includes("最近读树 4.00 秒 · 共 1 次"));
});

test("focus-after rejection and insufficient budget never become tree or image timeout", async () => {
  const r = createCaptureReadiness(18000, () => 100);
  r.focused(focus); r.phase("focus-before");
  const s = { ...failed(), captureReadiness: r.snapshot("budget exhausted") };
  assert.equal(captureFeedback(s, s.error).title, "就绪检查未完成");
  await r.read(async () => {}); r.phase("focus-after"); s.captureReadiness = r.snapshot("window changed");
  assert.equal(captureFeedback(s, s.error).title, "采集窗口无法复核");
});

test("ready failures distinguish later images from unrelated later capture errors", async () => {
  const r = createCaptureReadiness(18000, () => 100); r.focused(focus); await r.read(async () => {}); r.ready();
  for (const [error, title] of [["SDK 独立画面抓取失败", "独立画面采集失败"], ["采集期间窗口发生变化", "后续采集失败"]]) {
    const s = { ...failed(error), captureReadiness: r.snapshot() };
    assert.equal(captureFeedback(s, error).title, title);
  }
});

test("cold SDK tree timeout is not classified as an image failure by wrapper wording", async () => {
  const r = createCaptureReadiness(18000, () => 10485);
  r.focused(focus); await r.read(async () => {}); r.ready();
  for (const label of ["SDK 控件树超时", "SDK 控件树连续超时"]) {
    // Sanitized wording from the saved failed request; no business tree or image.
    const error = `App 仍在启动，独立画面尚未就绪，请等待页面稳定后重试。App 正在初始化：${label}：目标 App 页面尚未就绪，请稍后重试。`;
    const s = { ...failed(error), captureReadiness: r.snapshot() };
    const feedback = captureFeedback(s, error);
    assert.equal(feedback.title, "SDK 控件树读取超时");
    assert.match(feedback.hint, /基础控件树/);
    assert.match(feedback.hint, /尚未返回/);
    assert.ok(!/主线程|死锁|绘制失败/.test(feedback.hint), "timeout alone does not prove a business blocker");
    assert.equal(captureFeedback(s, "SDK 独立画面抓取失败").title, "读取失败", "do not reuse stale evidence");
  }
});

test("cancellation, old snapshots, bad diagnostics and error overrides never inherit stale timings", () => {
  assert.equal(captureFeedback(failed(), failed().error).title, "App 尚未准备好");
  const r = createCaptureReadiness(18000, () => 100);
  const s = { ...failed(), captureReadiness: r.snapshot() };
  assert.equal(captureFeedback(s, "已取消采集，可以重新开始。").title, "采集已取消");
  assert.equal(captureFeedback(s, "已取消采集，可以重新开始。").timing.length, 0);
  assert.equal(captureFeedback(s, "设备已断线").title, "读取失败");
  assert.equal(captureFeedback(s, "设备已断线").timing.length, 0);
  assert.equal(captureFeedback({ ...s, captureReadiness: { ...s.captureReadiness, elapsedMs: -1 } }, s.error).readiness, null);
});

test("successful manual recovery does not clear earlier bounded failure scalars", () => {
  const r = createCaptureReadiness(18000, () => 18000);
  const s = { ...failed(), captureReadiness: r.snapshot("timeout") };
  const first = rememberCaptureFailures([], s, "request-1");
  const recovered = rememberCaptureFailures(first, { ...failed(), error: null }, "request-2");
  assert.equal(recovered, first);
  s.captureReadiness.elapsedMs = 1;
  assert.equal(recovered[0].readiness?.elapsedMs, 18000);
  let records = recovered;
  for (let i = 0; i < 20; i++) records = rememberCaptureFailures(records, failed("failed"), `request-${i}`);
  assert.equal(records.length, 8);
  assert.equal(JSON.stringify(records).includes("root"), false);
});

test("internal retry retains first failure even after success and last attempt alone supplies current diagnosis", () => {
  const s = failed(); const r = createCaptureReadiness(18000, () => 10);
  s.captureReadiness = r.snapshot("timeout");
  const attempts = recordCaptureAttempt([], s, 1, 0, 100);
  const success = { ...failed(), error: null };
  success.captureRequestDiagnostics = { totalDurationMs: 300, totalAttempts: 2, droppedAttempts: 0,
    attempts: recordCaptureAttempt(attempts, success, 2, 200, 100) };
  const records = rememberCaptureFailures([], success, "retry");
  assert.equal(records.length, 1); assert.equal(records[0].attempt, 1);
  const secondFailure = { ...failed("device disconnected"), captureRequestDiagnostics: { ...success.captureRequestDiagnostics,
    attempts: recordCaptureAttempt(attempts, failed("device disconnected"), 2, 200, 100) } };
  assert.equal(captureFeedback(secondFailure, secondFailure.error).readiness, null);
});
