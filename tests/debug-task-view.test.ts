import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DebugReportStep } from "../shared/debug-report";
import type { DebugTaskAssessment, DebugTaskCheckResult, DebugTaskConditionResult, DebugTaskRecord, DebugTaskStatus } from "../shared/debug-task";
import type { LoadedTestReport, TestReportStep } from "../shared/test-report";
import type { UiNode, UiSnapshot } from "../shared/types";
import { DebugReportStepDetails, DebugTaskCheckEvidence } from "../src/features/reports/DebugReportStepDetails";
import { DebugTaskSummary } from "../src/features/reports/DebugTaskSummary";
import { debugInputMarker, debugStepDisplayMessage, debugStepMatches, debugStepOutcomeLabel, debugTaskCheckAssessment,
  debugTaskConditionLabel, debugTaskObservation, debugTaskView, type DebugReportData } from "../src/features/reports/debug-report-view";

const time = (second: number) => `2026-10-11T00:00:${String(second).padStart(2, "0")}.000Z`;
const id = (number: number) => `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
function node(text: string): UiNode {
  return { id: "0/0", index: 0, text, className: "android.widget.TextView", package: "sample.app", resourceId: "sample.app:id/result",
    contentDesc: "历史验收控件", bounds: { left: 0, top: 0, right: 100, bottom: 200, raw: "[0,0][100,200]" }, clickable: false,
    enabled: true, focusable: false, focused: false, scrollable: false, selected: false, visibleToUser: true, attributes: {}, children: [] };
}
function snapshot(text: string): UiSnapshot {
  return { serial: "fixture", root: node(text), nodeCount: 1, rawXml: null, xmlSize: 0, screenshotDataUrl: null, error: null, warning: null };
}
function result(conditionId: string, status: DebugTaskStatus = "passed", matches = 1): DebugTaskConditionResult {
  return { conditionId, status, reason: "已按保存的完整树复核。", firstMatchCount: matches, secondMatchCount: matches,
    firstNodeId: matches ? "0/0" : null, secondNodeId: matches ? "0/0" : null };
}
function assessment(check: DebugTaskCheckResult, status: DebugTaskStatus = "passed", reason = "两次观察的固定条件均满足。"): DebugTaskAssessment {
  return { status, reason, conditions: check.conditions.map(item => ({ ...item, status, reason })) };
}
function check(checkpointId: string | null, stepId: number, firstId: number): DebugTaskCheckResult {
  return { taskId: id(1), checkpointId, stepId, checkedAt: time(stepId * 2), status: "passed", reason: "原始记录声明通过。",
    observations: { first: { snapshotId: id(firstId), capturedAt: time(stepId * 2 - 2), component: "sample.app/.Page",
      windowId: "Window{fixture}", activityRecordId: "ActivityRecord{fixture}" },
    second: { snapshotId: id(firstId + 1), capturedAt: time(stepId * 2 - 1), component: "sample.app/.Page",
      windowId: "Window{fixture}", activityRecordId: "ActivityRecord{fixture}" } },
    conditions: checkpointId ? [result("settings_visible")] : [result("saved_visible"), result("error_absent", "passed", 0)] };
}
function record(check: DebugTaskCheckResult): DebugReportStep {
  return { step: { id: check.stepId, time: check.observations.first!.capturedAt, action: "check_debug_task", status: "done",
    input: { taskId: check.taskId, ...(check.checkpointId ? { checkpointId: check.checkpointId } : {}) }, message: "验收记录已保存。", taskCheck: check,
    dispatchState: "not_sent" }, durationMs: 2000, finishedAt: check.checkedAt, verified: null,
    before: { snapshotId: check.observations.first!.snapshotId, freshness: "current", reason: null },
    after: { snapshotId: check.observations.second!.snapshotId, freshness: "current", reason: null } };
}
function fixture() {
  const phase = check("settings", 2, 101), final = check(null, 4, 103);
  const task: DebugTaskRecord = { id: id(1), definedAt: time(0), definedStepId: 1,
    definition: { goal: "保存设置，并确认保存结果。", checkpoints: [{ id: "settings", title: "打开设置页",
      conditions: [{ id: "settings_visible", selector: { text: "设置" }, state: "visible" }] }],
    finalConditions: [{ id: "saved_visible", selector: { text: "已保存" }, state: "visible" },
      { id: "error_absent", selector: { resourceId: "sample.app:id/error" }, state: "absent" }] }, checks: [phase, final] };
  const data: DebugReportData = { session: { id: id(10), serial: "fixture", packageName: "sample.app", startedAt: time(0), updatedAt: time(8),
    active: false, stopReason: "用户停止", totalSteps: 4, droppedSteps: 0 }, task,
    taskAssessment: { checks: [phase, final].map(recorded => ({ recorded, effective: assessment(recorded) })), final: assessment(final) },
    steps: [record(phase), record(final)], snapshots: [phase, final].flatMap(proof => [proof.observations.first!, proof.observations.second!].map(observed => ({
      evidence: { snapshotId: observed.snapshotId, capturedAt: observed.capturedAt, source: "uiautomator", warnings: [],
        tree: { path: `${observed.snapshotId}.json`, sha256: "a".repeat(64), size: 1 },
        screenshot: { path: `${observed.snapshotId}.png`, sha256: observed.snapshotId.replace(/-/g, "").padEnd(64, "b"), size: 1 } },
      snapshot: snapshot(proof.checkpointId ? "设置" : "已保存"), treeError: null, screenshotArtifactId: observed.snapshotId }))) };
  const images: LoadedTestReport["images"] = data.snapshots.map(saved => ({ attemptId: data.session.id,
    artifactId: saved.screenshotArtifactId!, dataUrl: `data:image/png;base64,${saved.evidence.snapshotId}`, error: null }));
  const step: TestReportStep = { id: "4", api: "check_debug_task", label: "验收记录已保存。", status: "passed", durationMs: 2000, source: null, error: null };
  return { data, images, phase, final, step, record: data.steps[1] };
}
const summary = (data: DebugReportData) => renderToStaticMarkup(createElement(DebugTaskSummary, { data, onSelectCheck: () => {} }));

test("reports without a task preserve the ordinary unverified result", () => {
  const f = fixture(); delete f.data.task; delete f.data.taskAssessment;
  assert.equal(debugTaskView(f.data), null); assert.equal(summary(f.data), "");
  f.record.step.action = "tap_node"; f.record.verified = true;
  assert.equal(debugStepOutcomeLabel(f.record, f.data), "操作完成 · 尚未验收");
});

test("raw passed task records cannot become green without a reviewed assessment", () => {
  const f = fixture(); delete f.data.taskAssessment;
  assert.equal(debugTaskView(f.data)?.finalAssessment?.status, "insufficient_evidence");
  assert.equal(debugTaskCheckAssessment(f.data, f.final).status, "insufficient_evidence");
  assert.equal(debugStepOutcomeLabel(f.record, f.data), "最终验收证据不足");
  const html = summary(f.data);
  assert.match(html, /历史结果：证据不足/); assert.doesNotMatch(html, /data-task-status="passed"/);
  const mismatch = fixture(); mismatch.data.taskAssessment!.checks[1].recorded = { ...mismatch.final, checkedAt: time(30) };
  assert.equal(debugTaskCheckAssessment(mismatch.data, mismatch.final).status, "insufficient_evidence");
});

test("check messages use the effective evidence reason instead of an unverified original passed claim", () => {
  const f = fixture(); f.record.step.message = "任务验收通过。"; f.step.label = "任务验收通过。（验收未确认）";
  const reason = "第二次完整树缺失，不能确认任务通过。";
  f.data.taskAssessment!.checks[1].effective = assessment(f.final, "insufficient_evidence", reason);
  f.data.taskAssessment!.final = f.data.taskAssessment!.checks[1].effective;
  assert.equal(debugStepDisplayMessage(f.record, f.data, f.step.label), reason);
  const html = renderToStaticMarkup(createElement(DebugReportStepDetails, f));
  assert.match(html, new RegExp(reason)); assert.doesNotMatch(html, /任务验收通过。/);
  f.record.step.taskCheck = undefined;
  assert.equal(debugStepDisplayMessage(f.record, f.data), "原始记录：任务验收通过。");
  f.record.step.action = "tap_node";
  assert.equal(debugStepDisplayMessage(f.record, f.data, "已点击保存"), "已点击保存");
});

test("reviewed task summary retains fixed goal, conditions and historical step/time evidence links", () => {
  const f = fixture(), html = summary(f.data);
  assert.match(html, /aria-label="任务验收摘要" data-task-status="passed" data-task-review-needed="false"/);
  assert.match(html, /原始目标：保存设置，并确认保存结果。/);
  assert.match(html, /自然语言仅说明目标；验收按下列固定条件/);
  assert.match(html, /不证明手机当前状态/); assert.match(html, /历史结果：通过/);
  assert.match(html, /data-task-checkpoint="settings" data-task-status="passed"/);
  assert.match(html, /data-task-checkpoint="final" data-task-status="passed"/);
  assert.match(html, /data-task-check-step="2"/); assert.match(html, /data-task-check-step="4"/);
  assert.match(html, /2026-10-11T00:00:08.000Z/); assert.match(html, /应无屏内可见匹配/);
  assert.doesNotMatch(debugTaskConditionLabel(f.data.task!.definition.finalConditions[1]), /不存在/);
});

test("stage-only checks and missing stage evidence cannot imply a final pass", () => {
  const f = fixture(); f.data.task!.checks = [f.phase]; f.data.taskAssessment!.final = null;
  assert.equal(debugTaskView(f.data)?.finalAssessment, null); assert.match(summary(f.data), /尚未最终验收/);
  const incomplete = fixture(); incomplete.data.task!.checks = [incomplete.final];
  assert.equal(debugTaskView(incomplete.data)?.finalAssessment?.status, "insufficient_evidence");
  assert.match(summary(incomplete.data), /缺少全部阶段的有效通过证据/);
});

test("failed and insufficient evidence use effective verdicts, including step search", () => {
  for (const status of ["failed", "insufficient_evidence"] as const) {
    const f = fixture(), reason = status === "failed" ? "两次观察均未满足固定条件。" : "第二次完整树缺失。";
    f.data.taskAssessment!.checks[1].effective = assessment(f.final, status, reason);
    f.data.taskAssessment!.final = assessment(f.final, status, reason);
    const html = summary(f.data);
    assert.match(html, new RegExp(`data-task-checkpoint="final" data-task-status="${status}"`));
    assert.match(html, new RegExp(reason));
    assert.equal(debugStepMatches(f.record, reason, f.step, f.data), true);
    assert.equal(debugStepOutcomeLabel(f.record, f.data), status === "failed" ? "最终验收失败" : "最终验收证据不足");
  }
});

test("later input requires a new check while the prior effective verdict remains historical", () => {
  const f = fixture();
  const later: DebugReportStep = { ...f.record, step: { ...f.record.step, id: 5, action: "tap_node", taskCheck: undefined, dispatchState: "sent" } };
  f.data.steps.push(later); f.data.session.totalSteps = 5;
  assert.equal(debugTaskView(f.data)?.needsReview, true);
  assert.equal(debugTaskView(f.data)?.finalAssessment?.status, "passed");
  assert.match(summary(f.data), /需重新验收/); assert.match(summary(f.data), /当时的验收结果仍保留/);
  later.step.dispatchState = "unknown"; assert.equal(debugTaskView(f.data)?.needsReview, true);
  later.step.dispatchState = "not_sent"; assert.equal(debugTaskView(f.data)?.needsReview, false);
  later.step.action = "wait_for_ui"; later.verified = true;
  assert.equal(debugTaskView(f.data)?.needsReview, false); assert.equal(debugStepOutcomeLabel(later, f.data), "页面断言通过");
  f.data.task!.checks = []; f.data.taskAssessment!.final = null;
  assert.match(summary(f.data), /尚未最终验收/);
});

test("discarded history after final check cannot prove there were no later input changes", () => {
  const f = fixture(); f.data.session.totalSteps = 150; f.data.session.droppedSteps = 50;
  f.data.steps = [{ ...f.record, step: { ...f.record.step, id: 51, action: "capture_ui", taskCheck: undefined } }];
  assert.equal(debugTaskView(f.data)?.laterHistoryMissing, true);
  assert.match(summary(f.data), /后部分步骤已丢弃|后的部分步骤已丢弃/);
  assert.match(summary(f.data), /历史结果：通过/);
});

test("two check observations use exact snapshot and session image IDs and never draw an input marker", () => {
  const f = fixture();
  f.images.unshift({ ...f.images[2], attemptId: "other-session", dataUrl: "data:image/png;base64,wrong" });
  assert.equal(debugTaskObservation(f.data, f.images, f.final, "before").image?.artifactId, id(103));
  assert.equal(debugTaskObservation(f.data, f.images, f.final, "after").image?.artifactId, id(104));
  f.record.step.resolvedInput = { action: { kind: "tap", x: 20, y: 30 }, frame: { width: 100, height: 200, rotation: 0 }, targetNodeId: "0/0" };
  assert.equal(debugInputMarker(f.record, "before", { width: 100, height: 200 }).marker, null);
  // Task checks use their own observation references even if an ordinary step reference is stale.
  f.record.before = { snapshotId: id(101), freshness: "previous", reason: "之前观察" };
  const html = renderToStaticMarkup(createElement(DebugReportStepDetails, f));
  assert.match(html, /data-task-observation="first"/); assert.match(html, /data-task-observation="second"/);
  assert.match(html, /第1次验收观察/); assert.match(html, /第2次验收观察/);
  assert.match(html, new RegExp(`data:image/png;base64,${id(103)}`));
  assert.doesNotMatch(html, /操作前参考|操作后观察|debug-report-input-marker|此观察中记录的目标属性/);
  assert.match(html, /只读验收/); assert.match(html, /前置条件不足时不采集/);
});

test("rolled out check proofs still expose real historical observations and read-only node queries", () => {
  const f = fixture(); f.data.steps = []; f.data.session.totalSteps = 150; f.data.session.droppedSteps = 150;
  const html = renderToStaticMarkup(createElement(DebugTaskCheckEvidence, { data: f.data, images: f.images, check: f.final }));
  assert.match(html, /aria-label="任务验收历史证据"/); assert.match(html, /执行步骤已不在最近100步中/);
  assert.match(html, /data-task-check-step="4"/); assert.match(html, /data-task-observation="first"/);
  assert.match(html, /aria-label="筛选历史控件"/); assert.match(html, /仅查询保存时的树，不代表手机当前控件/);
  assert.match(html, /已保存/); assert.doesNotMatch(html, /输入派发|debug-report-input-marker/);
});

test("uncollected or missing check observations remain explicit and cannot be claimed as verified", () => {
  const f = fixture(); f.final.observations = { first: null, second: null }; f.record.step.taskCheck = f.final;
  f.data.taskAssessment!.final = assessment(f.final, "insufficient_evidence", "前置阶段未通过，本次没有采集。");
  f.data.taskAssessment!.checks[1].effective = f.data.taskAssessment!.final;
  const html = renderToStaticMarkup(createElement(DebugReportStepDetails, f));
  assert.match(html, /最终验收证据不足/); assert.match(html, /第1次验收观察缺失/); assert.match(html, /第2次验收观察缺失/);
  assert.doesNotMatch(html, /<img|data-task-status="passed"/);
  f.record.step.taskCheck = undefined; f.record.step.status = "failed";
  assert.equal(debugStepOutcomeLabel(f.record, f.data), "验收证据不足");
});
