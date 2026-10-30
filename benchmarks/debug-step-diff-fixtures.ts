import type { DebugReportStep } from "../shared/debug-report";
import type { DebugTaskCheckResult } from "../shared/debug-task";
import type { DebugDiffObservation } from "../shared/debug-snapshot-diff";
import { debugDiffSnapshotIdentity } from "../shared/debug-snapshot-diff";
import type { UiNode, UiSnapshot } from "../shared/types";
import type { TestReportStep } from "../shared/test-report";
import type { DebugReportData } from "../src/features/reports/debug-report-view";

export const DIFF_PACKAGE = "sample.app", DIFF_SERIAL = "fixture-diff";
export const DIFF_BEFORE = "2026-10-12T01:00:00.000Z", DIFF_AFTER = "2026-10-12T01:00:01.000Z";

export function makeDiffNode(id: string, name: string | null, text = "保存"): UiNode {
  return { id, index: 0, className: "android.widget.Button", package: DIFF_PACKAGE, text,
    resourceId: name === null ? null : `${DIFF_PACKAGE}:id/${name}`, contentDesc: null,
    bounds: { left: 20, top: 60, right: 200, bottom: 100, raw: "[20,60][200,100]" }, clickable: true, enabled: true,
    focusable: true, focused: false, scrollable: false, selected: false, visibleToUser: true, children: [] };
}

export function makeDiffSnapshot(nodes: UiNode[]): UiSnapshot {
  const frame = { width: 360, height: 640, rotation: 0 as const };
  return { serial: DIFF_SERIAL, root: { ...makeDiffNode("0", "root", "页面"), className: "android.widget.FrameLayout",
    attributes: { "debug-observation-component": `${DIFF_PACKAGE}/.Main`, "debug-observation-window-id": "window-1",
      "debug-observation-activity-record-id": "activity-1" }, children: nodes }, nodeCount: nodes.length + 1,
    rawXml: null, xmlSize: 0, screenshotDataUrl: null, error: null, warning: null, inspectionSource: "uiautomator",
    captureMode: "fast", hierarchyDumpMode: "full", captureGeometry: { screenshotSize: frame, hierarchyRotation: 0,
      beforeScreenshot: frame, afterScreenshot: frame } };
}

export function makeDiffObservation(snapshot: UiSnapshot, side: "before" | "after"): DebugDiffObservation {
  return { snapshotId: side, capturedAt: side === "before" ? DIFF_BEFORE : DIFF_AFTER, freshness: "current", treeError: null,
    snapshot, identity: debugDiffSnapshotIdentity(snapshot) };
}

export type DiffFixtureState = "normal" | "empty" | "partial" | "missing" | "error" | "check";
export function makeDebugDiffReportFixture(state: DiffFixtureState = "normal") {
  const old = makeDiffSnapshot([makeDiffNode("0/0", "save", "提交订单"), makeDiffNode("0/1", "cancel", "取消")]);
  const fresh = state === "empty" ? structuredClone(old) : makeDiffSnapshot([
    { ...makeDiffNode("0/0", "done", "订单已保存"), enabled: false },
    { ...makeDiffNode("0/1", "save", "保存完成"), bounds: { left: 20, top: 120, right: 220, bottom: 168, raw: "[20,120][220,168]" }, enabled: false },
  ]);
  if (state === "partial") {
    old.root!.children.push(makeDiffNode("0/2", "row", "商品甲"), makeDiffNode("0/3", "row", "商品乙"));
    fresh.root!.children.push(makeDiffNode("0/2", "row", "新商品"), makeDiffNode("0/3", "row", "商品甲"));
    old.nodeCount += 2; fresh.nodeCount += 2;
  }
  const record: DebugReportStep = { step: { id: 7, time: DIFF_BEFORE, action: "tap_node", status: "done",
    input: { selector: { resourceId: `${DIFF_PACKAGE}:id/save` } }, message: "已读取保存的执行记录", dispatchState: "not_sent" },
    finishedAt: DIFF_AFTER, durationMs: 1000, verified: null, before: { snapshotId: "before", freshness: "current", reason: null },
    after: { snapshotId: "after", freshness: "current", reason: null } };
  const data: DebugReportData = { session: { id: "fixture-session", serial: DIFF_SERIAL, packageName: DIFF_PACKAGE,
    startedAt: DIFF_BEFORE, updatedAt: DIFF_AFTER, active: false, stopReason: "本地渲染样本", totalSteps: 7, droppedSteps: 0 }, steps: [record],
    snapshots: [old, fresh].map((snapshot, i) => ({ snapshot, treeError: null, screenshotArtifactId: null,
      evidence: { snapshotId: i ? "after" : "before", capturedAt: i ? DIFF_AFTER : DIFF_BEFORE, source: "uiautomator",
        tree: { path: i ? "after.json" : "before.json", sha256: "a".repeat(64), size: 1 }, screenshot: null, warnings: [] } })) };
  if (state === "missing") record.after = { snapshotId: "before", freshness: "previous", reason: "未取得本次的新观察" };
  if (state === "error") { data.snapshots[1].snapshot = null; data.snapshots[1].treeError = "保存的节点文件校验失败"; }
  const check: DebugTaskCheckResult = { taskId: "fixture-task", checkpointId: null, stepId: record.step.id, checkedAt: DIFF_AFTER,
    status: "passed", reason: "原始保存结果", conditions: [], observations: {
      first: { snapshotId: "before", capturedAt: DIFF_BEFORE, component: `${DIFF_PACKAGE}/.Main`, windowId: "window-1", activityRecordId: "activity-1" },
      second: { snapshotId: "after", capturedAt: DIFF_AFTER, component: `${DIFF_PACKAGE}/.Main`, windowId: "window-1", activityRecordId: "activity-1" } } };
  if (state === "check") { record.step.action = "check_debug_task"; record.step.taskCheck = check;
    data.taskAssessment = { checks: [{ recorded: check, effective: { status: "failed", reason: "保存的观察不满足已固定条件", conditions: [] } }], final: null }; }
  const step: TestReportStep = { id: "7", api: record.step.action, label: record.step.message, status: "completed", durationMs: 1000, source: null, error: null };
  return { data, record, step, check, images: [] };
}
