import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { inspectionReadOnlyScope, validDiagnosticPackage } from "../shared/inspection-policy";
import type { UiNode } from "../shared/types";
import { diagnosticImageState, summarizeLiveDiagnosis, type LiveDiagnosisResult } from "../src/features/reports/live-diagnosis";
import { LivePageDiagnosis } from "../src/features/reports/LivePageDiagnosis";

function node(id: string): UiNode {
  return { id, className: "android.view.View", package: "sample.app", index: 0, text: null, resourceId: null, contentDesc: null,
    bounds: { left: 1, top: 2, right: 11, bottom: 22, raw: "[1,2][11,22]" }, clickable: false, enabled: true,
    focusable: false, focused: false, scrollable: false, selected: false, visibleToUser: true, children: [] };
}
function fixture(): LiveDiagnosisResult {
  return { requestId: "local-fixture", serial: "fixture", expectedPackage: "sample.app", startedAt: "2026-10-09T00:00:00Z", finishedAt: "2026-10-09T00:00:01Z",
    snapshot: { serial: "fixture", root: node("0"), nodeCount: 1, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null,
      inspectionSource: "debug-view", captureRequestDiagnostics: { totalAttempts: 1, totalDurationMs: 1, droppedAttempts: 0, attempts: [] } } };
}

test("diagnostic IPC scope requires a plain fixed package and explicit single attempt", () => {
  assert.equal(inspectionReadOnlyScope(undefined, false), undefined);
  assert.deepEqual(inspectionReadOnlyScope({ expectedPackage: "sample.app" }, true), { expectedPackage: "sample.app" });
  for (const value of [null, false, [], {}, { expectedPackage: " sample.app" }, { expectedPackage: "sample.app; input" },
    { expectedPackage: "https://example.com" }, { expectedPackage: "sample.app", allowAppRestart: true }]) {
    assert.throws(() => inspectionReadOnlyScope(value, true), /有效/);
  }
  assert.throws(() => inspectionReadOnlyScope({ expectedPackage: "sample.app" }, false), /单次/);
  assert.equal(validDiagnosticPackage("app"), false);
  assert.equal(validDiagnosticPackage("sample." + "a".repeat(200)), false);
});

test("image states distinguish measured transparency from missing, unknown and failed images", () => {
  const view = node("0");
  assert.equal(diagnosticImageState(view), "unknown");
  view.layerImageEmpty = true; view.attributes = { "skip-draw": "true" };
  assert.equal(diagnosticImageState(view), "unknown", "skip-draw/empty marker without captured image is not measured transparency");
  view.layerImageStatus = "captured";
  assert.equal(diagnosticImageState(view), "unavailable");
  view.layerImageDataUrl = "data:image/png;base64,fixture";
  assert.equal(diagnosticImageState(view), "transparent");
  view.layerImageEmpty = false; assert.equal(diagnosticImageState(view), "visible");
  delete view.layerImageEmpty; assert.equal(diagnosticImageState(view), "captured");
  for (const status of ["style", "failed", "hidden", "ambiguous", "unavailable"] as const) {
    view.layerImageStatus = status; assert.equal(diagnosticImageState(view), status);
  }
});

test("summary retains actual names, geometry, source and missing-image reasons without mutating the snapshot", () => {
  const result = fixture();
  result.snapshot.root!.attributes = { "debug-process-id": "42", "debug-component": "sample.app/.Main", "debug-window-name": "window" };
  result.snapshot.root!.children = [{ ...node("0/0"), text: "实际名称", layerImageStatus: "failed",
    attributes: { "image-source": "SDK own", "image-capture-error": "控件已变化" } },
    { ...node("0/1"), layerImageStatus: "unavailable", attributes: { "skip-draw": "true" } }];
  const before = JSON.stringify(result), summary = summarizeLiveDiagnosis(result);
  assert.equal(summary.rejection, null);
  assert.deepEqual(summary.rows.map(row => row.id), ["0", "0/0", "0/1"]);
  assert.equal(summary.rows[1].name, "实际名称"); assert.equal(summary.rows[1].reason, "控件已变化");
  assert.equal(summary.rows[1].source, "SDK own"); assert.equal(summary.rows[1].bounds, "1, 2 · 10 × 20 px");
  assert.match(summary.rows[2].reason, /不等于已测透明/);
  assert.equal(summary.processId, "42"); assert.equal(summary.windowId, "window");
  assert.equal(summary.counts.failed, 1); assert.equal(summary.counts.transparent, 0);
  assert.equal(JSON.stringify(result), before);
});

test("wrong App/device, failed capture and non-single records cannot supply diagnostic nodes", () => {
  for (const change of [(r: LiveDiagnosisResult) => { r.snapshot.serial = "other"; },
    (r: LiveDiagnosisResult) => { r.snapshot.root!.package = "other.app"; },
    (r: LiveDiagnosisResult) => { r.snapshot.error = "采集失败"; },
    (r: LiveDiagnosisResult) => { r.snapshot.root = null; },
    (r: LiveDiagnosisResult) => { r.snapshot.captureRequestDiagnostics!.totalAttempts = 2; },
    (r: LiveDiagnosisResult) => { delete r.snapshot.captureRequestDiagnostics; },
    (r: LiveDiagnosisResult) => { r.snapshot.captureMode = "fast"; },
    (r: LiveDiagnosisResult) => { r.snapshot.inspectionSource = "accessibility-helper"; }]) {
    const result = fixture(); change(result); const summary = summarizeLiveDiagnosis(result);
    assert.ok(summary.rejection); assert.deepEqual(summary.rows, []);
    assert.equal(summary.processId, "未标注"); assert.equal(summary.counts.transparent, 0);
  }
});

test("UI starts without any capture or guessed report-to-node link and disables unsupported/offline state", () => {
  let calls = 0;
  const html = renderToStaticMarkup(createElement(LivePageDiagnosis, { serial: null, deviceLabel: "合成设备", supported: false,
    blocked: false, stage: "未采集", onCapture: async () => { calls++; return fixture().snapshot; }, onCancel: () => { calls++; }, onViewNode: () => { calls++; } }));
  assert.equal(calls, 0);
  assert.match(html, /不是原测试现场/); assert.match(html, /不自动匹配旧截图或控件/);
  assert.match(html, /没有在线设备/); assert.match(html, /当前运行版本不支持/);
  assert.match(html, /type="submit" disabled=""/);
  const source = readFileSync("src/features/reports/LivePageDiagnosis.tsx", "utf8");
  assert.doesNotMatch(source, /fetch\(|startDebugSession|agent\.act|locator\.tap|device\.back|importTestReport/);
  assert.match(source, /pending\.current !== requestId/);
  assert.match(source, /if \(!active && pending\.current\)/);
  assert.match(source, /rows\.slice\(0, 50\)/);
});
