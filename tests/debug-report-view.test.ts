import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DebugReportStep } from "../shared/debug-report";
import type { LoadedTestReport, TestReportStep } from "../shared/test-report";
import type { DebugInputEvidence, UiNode, UiSnapshot } from "../shared/types";
import { DebugReportStepDetails } from "../src/features/reports/DebugReportStepDetails";
import { confirmedDebugInput, debugDispatchLabel, debugInputMarker, debugNodeProperties, debugObservation,
  debugSnapshotNodes, debugStepMatches, debugStepOutcomeLabel, uniqueDebugNode, type DebugReportData } from "../src/features/reports/debug-report-view";

function node(id: string, text = "保存"): UiNode {
  return { id, index: 0, text, className: "android.widget.Button", package: "sample.app", resourceId: "sample.app:id/save", contentDesc: null,
    bounds: { left: 10, top: 20, right: 30, bottom: 40, raw: "[10,20][30,40]" }, clickable: true, enabled: true,
    focusable: false, focused: false, scrollable: false, selected: false, visibleToUser: true, attributes: { "debug-name": "<script>名称</script>" }, children: [] };
}
function snapshot(text: string): UiSnapshot {
  return { serial: "fixture", root: { ...node("0", "根"), children: [node("0/0", text)] }, nodeCount: 2,
    rawXml: null, xmlSize: 0, screenshotDataUrl: null, error: null, warning: null };
}
function receipt(): DebugInputEvidence {
  return { classification: "accepted", spawned: true, closed: true, exitCode: 0, signal: null, durationMs: 5,
    stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
}
function fixture() {
  const record: DebugReportStep = { step: { id: 12, time: "2026-10-11T00:00:00Z", action: "tap_node", status: "done",
    input: { nodeId: "0/0", selector: { text: "保存" } }, message: "操作已完成", dispatchState: "sent", inputEvidence: receipt(),
    resolvedInput: { action: { kind: "tap", x: 20, y: 30 }, frame: { width: 100, height: 200, rotation: 0 }, targetNodeId: "0/0" } },
    finishedAt: "2026-10-11T00:00:01Z", durationMs: 1000, verified: null,
    before: { snapshotId: "before", freshness: "current", reason: null },
    after: { snapshotId: "after", freshness: "current", reason: null } };
  const data: DebugReportData = { session: { id: "session", serial: "fixture", packageName: "sample.app", startedAt: record.step.time,
    updatedAt: record.finishedAt, active: false, stopReason: "用户停止", totalSteps: 112, droppedSteps: 12 }, steps: [record],
    snapshots: ["before", "after"].map(id => ({ evidence: { snapshotId: id, capturedAt: id === "before" ? record.step.time : record.finishedAt,
      source: "uiautomator", tree: { path: `${id}.json`, sha256: "a".repeat(64), size: 1 }, screenshot: { path: `${id}.png`, sha256: id === "before" ? "b".repeat(64) : "c".repeat(64), size: 1 }, warnings: [] },
      snapshot: snapshot(id === "before" ? "原目标" : "新页面"), treeError: null, screenshotArtifactId: `${id}-image` })) };
  const images: LoadedTestReport["images"] = ["before", "after"].map(id => ({ attemptId: "session", artifactId: `${id}-image`, dataUrl: `data:image/png;base64,${id}`, error: null }));
  const step: TestReportStep = { id: "12", api: "tap_node", label: "操作已完成", status: "completed", durationMs: 1000, source: null, error: null };
  return { record, data, images, step };
}

test("debug observations associate exact snapshot/image/session IDs without substituting neighboring evidence", () => {
  const f = fixture();
  f.images.unshift({ ...f.images[0], attemptId: "other-session", dataUrl: "data:image/png;base64,wrong" });
  assert.equal(debugObservation(f.data, f.images, "before", f.record).image?.dataUrl, "data:image/png;base64,before");
  assert.equal(debugObservation(f.data, f.images, "after", f.record).image?.dataUrl, "data:image/png;base64,after");
  f.record.after = { snapshotId: "before", freshness: "previous", reason: "未取得新观察" };
  const previous = debugObservation(f.data, f.images, "after", f.record);
  assert.match(previous.label, /之前观察（不是操作后采集）/);
  assert.equal(previous.image?.dataUrl, "data:image/png;base64,before");
  f.record.after = { snapshotId: "absent", freshness: "current", reason: null };
  assert.equal(debugObservation(f.data, f.images, "after", f.record).image, null);
  f.record.after = { snapshotId: "before", freshness: "missing", reason: "留证容量已满" };
  assert.equal(debugObservation(f.data, f.images, "after", f.record).saved, null);
});

test("input overlays require a fresh pre-action image, exact pixel dimensions and a valid spatial action", () => {
  const { record } = fixture();
  assert.equal(debugInputMarker(record, "before", { width: 100, height: 200 }).marker?.confirmed, true);
  assert.equal(debugInputMarker(record, "after", { width: 100, height: 200 }).marker, null);
  assert.equal(debugInputMarker(record, "before", null).marker, null);
  assert.match(debugInputMarker(record, "before", { width: 200, height: 100 }).reason!, /尺寸/);
  record.before.freshness = "previous";
  assert.equal(debugInputMarker(record, "before", { width: 100, height: 200 }).marker, null);
  record.before.freshness = "current";
  record.step.resolvedInput!.action = { kind: "tap", x: 100, y: 30 };
  assert.match(debugInputMarker(record, "before", { width: 100, height: 200 }).reason!, /超出截图/);
  record.step.resolvedInput!.action = { kind: "tap", x: NaN, y: 30 };
  assert.equal(debugInputMarker(record, "before", { width: 100, height: 200 }).marker, null);
  record.step.resolvedInput!.action = { kind: "back" };
  assert.deepEqual(debugInputMarker(record, "before", { width: 100, height: 200 }), { marker: null, reason: null });
});

test("sent/unknown/not-sent labels keep planned coordinates separate from confirmed dispatch", () => {
  const { record } = fixture();
  const size = { width: 100, height: 200 };
  assert.equal(confirmedDebugInput(record.step), true);
  assert.equal(debugInputMarker(record, "before", size).marker?.label, "已发送");
  record.step.dispatchState = "unknown";
  assert.equal(debugInputMarker(record, "before", size).marker?.label, "计划位置，派发未确认");
  record.step.dispatchState = "not_sent";
  assert.equal(debugInputMarker(record, "before", size).marker?.label, "计划位置，未发送");
  assert.equal(debugDispatchLabel(record.step), "未发送");
  record.step.dispatchState = "sent";
  for (const bad of [undefined, { ...receipt(), classification: "unexpected-output" as const }, { ...receipt(), closed: false },
    { ...receipt(), spawned: false }, { ...receipt(), exitCode: 1 }, { ...receipt(), signal: "SIGTERM" }]) {
    record.step.inputEvidence = bad;
    assert.equal(confirmedDebugInput(record.step), false);
    assert.equal(debugInputMarker(record, "before", size).marker?.label, "计划位置，派发未确认");
    assert.equal(debugDispatchLabel(record.step), "派发未确认");
  }
});

test("swipe markers preserve both actual endpoints and reject either endpoint outside the image", () => {
  const { record } = fixture();
  record.step.resolvedInput!.action = { kind: "swipe", fromX: 10, fromY: 150, toX: 10, toY: 30, durationMs: 350 };
  const marker = debugInputMarker(record, "before", { width: 100, height: 200 }).marker!;
  assert.deepEqual(marker.action, record.step.resolvedInput!.action);
  record.step.resolvedInput!.action.toY = 200;
  assert.equal(debugInputMarker(record, "before", { width: 100, height: 200 }).marker, null);
});

test("step labels and literal search never promote input completion to business verification", () => {
  const { record, step } = fixture();
  assert.equal(debugStepOutcomeLabel(record), "操作完成 · 尚未验收");
  assert.equal(debugStepMatches(record, "#12", step), true);
  assert.equal(debugStepMatches(record, "保存", step), true);
  assert.equal(debugStepMatches(record, "TAP_NODE", step), true);
  assert.equal(debugStepMatches(record, "[.*]", step), false);
  step.error = { category: "capture", code: "FRAME_CHANGED", message: "窗口已变化" };
  assert.equal(debugStepMatches(record, "窗口", step), true);
  record.verified = true;
  assert.equal(debugStepOutcomeLabel(record), "操作完成 · 尚未验收");
  record.step.action = "wait_for_ui";
  assert.equal(debugStepOutcomeLabel(record), "页面断言通过");
  record.verified = false;
  record.step.status = "failed";
  record.step.error = { category: "assertion", phase: "verify", code: "VERIFY_NOT_MET", message: "未满足页面断言" };
  assert.equal(debugStepOutcomeLabel(record), "页面断言未通过");
  record.step.error.phase = "capture";
  assert.equal(debugStepOutcomeLabel(record), "操作失败");
  record.verified = null; record.step.status = "failed";
  assert.equal(debugStepOutcomeLabel(record), "操作失败");
});

test("historical node search is bounded, preserves properties, and rejects ambiguous exact IDs", () => {
  const page = snapshot("目标文字");
  page.root!.children.push(...Array.from({ length: 60 }, (_, i) => node(`0/${i + 1}`, `节点${i}`)));
  const before = JSON.stringify(page);
  const result = debugSnapshotNodes(page, "节点", 1000);
  assert.equal(result.total, 60); assert.equal(result.rows.length, 50);
  assert.equal(debugSnapshotNodes(page, "目标文字").rows[0].id, "0/0");
  assert.equal(debugSnapshotNodes(page, "<script>").total, 62);
  assert.equal(uniqueDebugNode(page, "0/0")?.text, "目标文字");
  const properties = debugNodeProperties(page.root!.children[0]);
  assert.equal(properties.resourceId, "sample.app:id/save");
  assert.equal("children" in properties, false); assert.equal("layerImageDataUrl" in properties, false);
  assert.equal(JSON.stringify(page), before);
  page.root!.children.push(node("0/0", "重复路径"));
  assert.equal(uniqueDebugNode(page, "0/0"), null);
});

test("debug step detail renders correct historical labels, errors and read-only properties without taking action", () => {
  const f = fixture();
  f.record.after = { snapshotId: "before", freshness: "previous", reason: "采集超时，保留之前观察" };
  f.record.step.status = "failed";
  f.record.step.recordingErrors = [{ category: "evidence", phase: "recording", code: "FILE_MISSING", message: "未保存操作后截图" }];
  f.step.error = { category: "capture", phase: "capture", code: "CAPTURE_TIMEOUT", message: "未取得操作后观察" };
  const html = renderToStaticMarkup(createElement(DebugReportStepDetails, { ...f, step: f.step }));
  assert.match(html, /aria-label="调试步骤详情"/);
  assert.match(html, /data-observation="before" data-freshness="current"/);
  assert.match(html, /data-observation="after" data-freshness="previous"/);
  assert.match(html, /之前观察（不是操作后采集）/);
  assert.match(html, /结构化步骤错误/); assert.match(html, /CAPTURE_TIMEOUT/);
  assert.match(html, /此步骤的留证缺失或错误/); assert.match(html, /FILE_MISSING/);
  assert.match(html, /此观察中记录的目标属性/); assert.match(html, /原目标/);
  assert.match(html, /&lt;script&gt;名称&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /最多显示前50个/);
  assert.match(html, /图片尺寸尚未确认/);
  assert.doesNotMatch(html, /class="debug-report-input-marker"/);
  const source = readFileSync("src/features/reports/DebugReportStepDetails.tsx", "utf8") + readFileSync("src/features/reports/debug-report-view.ts", "utf8");
  assert.doesNotMatch(source, /electronApi|inspectDevice|startDebugSession|fetch\(|ipcRenderer|dangerouslySetInnerHTML|<iframe/);
});

test("direct-open debug entry shares the protected import lifecycle and describes saved authorization state", () => {
  const panel = readFileSync("src/features/reports/TestReportPanel.tsx", "utf8");
  assert.match(panel, /debugReportRequest\?: number/);
  assert.match(panel, /!open \|\| !loadDebugReport \|\| !debugReportRequest/);
  assert.match(panel, /debugReportRequest <= handledDebugRequest\.current \|\| pending\.current/);
  assert.match(panel, /handledDebugRequest\.current = debugReportRequest;\s*void receiveReport\(loadDebugReport, "debug"\)/);
  assert.match(panel, /!mounted\.current \|\| pending\.current !== request \|\| result\?\.canceled/);
  assert.match(panel, /保存这份记录时会话仍在授权中/);
  assert.doesNotMatch(panel, /读取时会话仍在录制/);
});
