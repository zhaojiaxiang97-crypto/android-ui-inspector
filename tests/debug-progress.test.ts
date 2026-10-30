import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DebugSession } from "../electron/automation/debug-session";
import { DebugSessionProgress } from "../src/features/automation/DebugSessionProgress";
import { DebugReportStepLogs } from "../src/features/reports/DebugReportStepLogs";
import { acceptDebugSessionUpdate, debugProgressElapsed, debugProgressPhaseLabel } from "../shared/debug-progress";
import type { DebugReportStep } from "../shared/debug-report";
import type { DebugSessionState } from "../shared/types";

function state(id = "session", revision = 10): DebugSessionState {
  const startedAt = "2026-10-12T08:00:00.000Z";
  return { id, revision, startedAt, serial: "fixture", packageName: "com.example.progress", active: true, busy: true,
    expiresAt: "2026-10-12T08:30:00.000Z", steps: [], evidencePath: null,
    progress: { sessionId: id, taskId: null, stepId: 1, action: "wait_for_ui", phase: "wait", startedAt, updatedAt: startedAt,
      stepStartedAt: "2026-10-12T08:00:05.000Z", stepFinishedAt: null, finishedAt: null, reason: "等待两次新观察确认页面条件。" } };
}

test("progress rejects old and retired grant events, stale revisions and unrelated task identities", () => {
  const current = state(), retired = new Set(["old-session"]);
  assert.equal(acceptDebugSessionUpdate(current, state("old-session", 1000), retired, true), false);
  assert.equal(acceptDebugSessionUpdate(current, state("session", 9), retired), false);
  assert.equal(acceptDebugSessionUpdate(current, state("session", 10), retired), false);
  assert.equal(acceptDebugSessionUpdate(current, state("session", 11), retired), true);
  const newer = state("next-session", 0); newer.startedAt = "2026-10-12T08:01:00.000Z";
  assert.equal(acceptDebugSessionUpdate(current, newer, retired), false); assert.equal(acceptDebugSessionUpdate(current, newer, retired, true), true);
  const stopped = { ...current, active: false }; assert.equal(acceptDebugSessionUpdate(stopped, current, retired, true), false);
  const mismatched = state("session", 11); mismatched.progress!.taskId = "another-task";
  assert.equal(acceptDebugSessionUpdate(current, mismatched, retired), false);
  const wrongSession = state("session", 11); wrongSession.progress!.sessionId = "another-session";
  assert.equal(acceptDebugSessionUpdate(current, wrongSession, retired), false);
  assert.equal(acceptDebugSessionUpdate(current, null, retired), false);
});

test("session and step elapsed time remain separate and freeze on their actual end times", () => {
  const progress = state().progress!;
  assert.deepEqual(debugProgressElapsed(progress, Date.parse("2026-10-12T08:00:10.000Z")), { sessionMs: 10000, stepMs: 5000 });
  progress.stepFinishedAt = "2026-10-12T08:00:08.000Z";
  assert.deepEqual(debugProgressElapsed(progress, Date.parse("2026-10-12T08:00:12.000Z")), { sessionMs: 12000, stepMs: 3000 });
  progress.finishedAt = "2026-10-12T08:00:12.000Z";
  assert.deepEqual(debugProgressElapsed(progress, Date.parse("2026-10-12T09:00:00.000Z")), { sessionMs: 12000, stepMs: 3000 });
});

test("grant, completion and Checker acceptance render independently without inventing a phone prompt", () => {
  const current = state();
  const html = renderToStaticMarkup(createElement(DebugSessionProgress, { state: current, onStop: () => {}, androidLogsEnabled: false, onAndroidLogsChange: () => {} }));
  for (const label of ["等待页面条件", "步骤 #1", "会话授权", "操作结果", "任务验收", "未声明任务", "停止", "Android 错误日志"]) assert.ok(html.includes(label));
  assert.ok(!html.includes("等待手机确认")); assert.match(html, /aria-live="polite"/); assert.match(html, /type="checkbox"[^>]*disabled/);
  assert.equal(debugProgressPhaseLabel("expired"), "授权已到期");
});

test("real session phases bind their own step and increasing revision through failure, stop and expiry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-progress-"));
  const events: DebugSessionState[] = [];
  const session = new DebugSession({ serial: "fixture", packageName: "com.example.progress", snapshotPath: join(directory, "current.json"), directory,
    onEvent: event => events.push(event.state), observe: async () => { throw new Error("capture unavailable"); } });
  try {
    assert.equal(session.state.progress!.phase, "idle");
    await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    assert.ok(events.some(event => event.progress!.phase === "capture")); assert.ok(events.some(event => event.progress!.phase === "recording"));
    assert.equal(events.at(-1)!.progress!.phase, "failed");
    assert.ok(events.every(event => event.progress!.sessionId === session.state.id && event.progress!.stepId === 1));
    assert.ok(events.every((event, index) => !index || event.revision! > events[index - 1].revision!));
    const stepFinishedAt = session.state.progress!.stepFinishedAt;
    session.stop("授权已到期"); assert.equal(session.state.progress!.phase, "expired");
    assert.equal(session.state.progress!.stepFinishedAt, stepFinishedAt); assert.equal(session.state.progress!.reason, "授权已到期");
    session.stop("later stop"); assert.equal(session.state.progress!.reason, "授权已到期");
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("compound scroll input invalidates an earlier task verdict while observation recovery does not", () => {
  const current = state();
  current.task = { id: "task", definedAt: current.startedAt!, definedStepId: 1,
    definition: { goal: "测试", finalConditions: [{ id: "ready", selector: { text: "ready" }, state: "visible" }], checkpoints: [] },
    checks: [{ taskId: "task", checkpointId: null, stepId: 2, checkedAt: current.startedAt!, status: "passed", reason: "已确认",
      conditions: [], observations: { first: null, second: null } }] };
  for (const action of ["scroll_until", "perform_ui_step", "resume_ui_step"]) {
    current.progress!.action = action;
    current.steps = [{ id: 3, time: current.startedAt!, action, input: {}, status: "done", message: "完成", dispatchState: "sent" }];
    const html = renderToStaticMarkup(createElement(DebugSessionProgress, { state: current }));
    assert.equal(html.includes("页面已操作，需重新验收"), action !== "resume_ui_step");
    if (action === "scroll_until") assert.ok(html.includes("连续滚动查找"));
  }
});

test("legacy, missing, truncated and cancelled log states are visible on the same historical step", () => {
  const current = state(), time = current.startedAt!;
  const record: DebugReportStep = { step: { id: 3, action: "capture_ui", time, input: {}, status: "failed", message: "failed" },
    finishedAt: time, durationMs: 10, verified: false, before: { snapshotId: null, freshness: "missing", reason: "missing" }, after: { snapshotId: null, freshness: "missing", reason: "missing" } };
  const legacy = renderToStaticMarkup(createElement(DebugReportStepLogs, { record })); assert.match(legacy, /旧报告/);
  record.logs = [{ source: "android", sessionId: current.id, stepId: 3, packageName: current.packageName, startedAt: time, finishedAt: time,
    status: "cancelled", attribution: "missing", reason: "缺少证据", truncated: true, lineCount: 0, file: null, androidScope: null }];
  const html = renderToStaticMarkup(createElement(DebugReportStepLogs, { record }));
  for (const label of ["步骤 #3", "采集已取消", "已截断", "缺少证据"]) assert.ok(html.includes(label));
});
