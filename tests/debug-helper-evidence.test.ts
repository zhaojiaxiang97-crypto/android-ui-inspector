import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DebugRequestLedger } from "../electron/automation/debug-request-ledger";
import { debugEvidenceSnapshot } from "../electron/automation/debug-evidence";
import { loadTestReport } from "../electron/desktop/test-report";
import { exportDebugReportEvidence } from "../electron/desktop/debug-report-export";
import { isUiSnapshot } from "../shared/snapshot-validation";
import { evaluateDebugTaskConditions } from "../shared/debug-task-checker";
import type { DebugTaskEvidence } from "../shared/debug-task";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";
import { makeDebugReportExportFixture } from "./fixtures/debug-report-export";
import { hasCompleteHelperTree } from "../shared/helper-observation";
import { parseUiHierarchy } from "../electron/capture/xml-tree";

const evidence = (startedAt: number): DebugTaskEvidence => ({ snapshot: helperEvidenceSnapshot({ startedAt }),
  observation: { snapshotId: randomUUID(), capturedAt: new Date(1_700_000_000_000 + startedAt).toISOString(),
    component: "com.example.helper/.Main", windowId: "adb-window", activityRecordId: "activity" } });
const conditions = [{ id: "done", state: "visible" as const, selector: { text: "完成" } },
  { id: "absent", state: "absent" as const, selector: { text: "错误" } }];

test("hidden clipped Helper nodes retain inverted Android rectangles without becoming visible targets", () => {
  for (const raw of ["[1122,0][1080,2355]", "[14,0][377,-1798]"]) {
    const snapshot = helperEvidenceSnapshot();
    snapshot.rawXml = snapshot.rawXml!.replace('bounds="[0,0][100,200]"', 'bounds="[0,0][0,0]"')
      .replace('visible-bounds="[0,0][100,200]"', 'visible-bounds="[0,0][0,0]"')
      .replace('bounds-screen="[0,0][100,200]"', `bounds-screen="${raw}"`).replace('visible-to-user="true"', 'visible-to-user="false"');
    snapshot.root = parseUiHierarchy(snapshot.rawXml).root;
    assert.equal(hasCompleteHelperTree(snapshot), true);
    assert.equal(isUiSnapshot(snapshot), true);
    const a = evidence(100), b = evidence(500);
    a.snapshot.root = structuredClone(snapshot.root); b.snapshot.root = structuredClone(snapshot.root);
    assert.notEqual(evaluateDebugTaskConditions(conditions, a, b, "com.example.helper").status, "passed");
    for (const alter of [
      (v: typeof snapshot) => { v.root!.visibleToUser = true; v.root!.visibilityEvidence = "visible"; v.root!.attributes!["visible-to-user"] = "true"; },
      (v: typeof snapshot) => { v.root!.bounds = { left: 1, top: 1, right: 2, bottom: 2, raw: "[1,1][2,2]" }; v.root!.attributes!.bounds = "[1,1][2,2]"; v.root!.attributes!["visible-bounds"] = "[1,1][2,2]"; },
      (v: typeof snapshot) => { delete v.root!.attributes!["visible-to-user"]; },
      (v: typeof snapshot) => { v.root!.attributes!["bounds-screen"] = "invalid"; },
    ]) { const changed = structuredClone(snapshot); alter(changed); assert.equal(hasCompleteHelperTree(changed), false); }
  }
});

test("saved Helper trees prove declared conditions only with complete same-source evidence", () => {
  const a = evidence(100), b = evidence(500);
  assert.equal(isUiSnapshot(a.snapshot), true);
  assert.equal(evaluateDebugTaskConditions(conditions, a, b, "com.example.helper").status, "passed");
  for (const alter of [
    (v: DebugTaskEvidence) => { v.snapshot.helperObservation!.serviceInstanceId = randomUUID(); },
    (v: DebugTaskEvidence) => { v.snapshot.helperObservation!.captureId = a.snapshot.helperObservation!.captureId; },
    (v: DebugTaskEvidence) => { v.snapshot.helperObservation!.timing.startedAtMs = 99; },
    (v: DebugTaskEvidence) => { v.snapshot.inspectionSource = "uiautomator"; },
    (v: DebugTaskEvidence) => { delete v.snapshot.root!.attributes!["visible-to-user"]; },
    (v: DebugTaskEvidence) => { v.snapshot.root!.visibilityEvidence = "unknown"; },
    (v: DebugTaskEvidence) => { v.snapshot.helperObservation!.windowsAfter[0].focused = false; },
    (v: DebugTaskEvidence) => { delete v.snapshot.helperObservation; },
  ]) {
    const changed = structuredClone(b); alter(changed);
    assert.equal(evaluateDebugTaskConditions(conditions, a, changed, "com.example.helper").status, "insufficient_evidence");
  }
  const occluded = structuredClone(b);
  for (const key of ["windowsBefore", "windowsAfter"] as const) occluded.snapshot.helperObservation![key].push({
    id: "8", type: "accessibility_overlay", layer: 2, active: false, focused: false,
    bounds: { x: 0, y: 0, width: 100, height: 200 }, packageName: "com.example.overlay", rootAvailable: true });
  assert.equal(isUiSnapshot(occluded.snapshot), true, "overlays remain readable diagnostic evidence");
  assert.equal(evaluateDebugTaskConditions(conditions, a, occluded, "com.example.helper").status, "insufficient_evidence");
});

test("Helper service identity survives ledger reload and cannot be rewritten after input", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const ledger = new DebugRequestLedger({ sessionDirectory: f.directory, sessionId: "fixture-session" });
    const requestId = randomUUID(), source = helperEvidenceSnapshot().helperObservation!;
    ledger.reserve(requestId, { backend: "accessibility-helper", action: { kind: "tap" } });
    ledger.bindObservationSource(requestId, source);
    assert.deepEqual(JSON.parse(readFileSync(ledger.path, "utf8")).records[0].observationSource, source);
    ledger.markDispatch(requestId, "unknown", 1);
    const newer = helperEvidenceSnapshot({ startedAt: 500 }).helperObservation!;
    ledger.bindObservationSource(requestId, newer);
    assert.deepEqual(ledger.get(requestId)!.observationSource, source);
    assert.throws(() => ledger.bindObservationSource(requestId, { ...newer, serviceInstanceId: randomUUID() }), /重启/);
    const loaded = new DebugRequestLedger({ sessionDirectory: f.directory, sessionId: "fixture-session" });
    assert.equal(loaded.get(requestId)!.dispatchState, "unknown");
    assert.deepEqual(loaded.get(requestId)!.observationSource, source);
    const late = randomUUID(); loaded.reserve(late, { backend: "accessibility-helper" }); loaded.markDispatch(late, "unknown");
    assert.throws(() => loaded.bindObservationSource(late, source), /开始后/);
    const wrong = randomUUID(); loaded.reserve(wrong, { backend: "uiautomator" });
    assert.throws(() => loaded.bindObservationSource(wrong, source), /未选择/);
    const invalid = JSON.parse(readFileSync(ledger.path, "utf8")); invalid.records[0].observationSource.lossless = false;
    writeFileSync(ledger.path, JSON.stringify(invalid));
    assert.throws(() => loaded.get(requestId), /来源记录损坏/);
  } finally { f.cleanup(); }
});

test("Helper metadata and visibility roundtrip through report export without embedding screenshots in trees", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    for (const item of f.report.snapshots) {
      const tree = JSON.parse(readFileSync(join(f.directory, item.tree!.path), "utf8"));
      tree.snapshot = debugEvidenceSnapshot(helperEvidenceSnapshot({ packageName: f.report.session.packageName,
        serial: f.report.session.serial, width: 4, height: 6 }));
      item.tree = f.artifact(Buffer.from(JSON.stringify(tree)), "json"); item.source = "accessibility-helper";
    }
    f.save();
    const loaded = await loadTestReport(f.file);
    assert.equal(loaded.debug!.snapshots[0].treeError, null);
    const saved = loaded.debug!.snapshots[0].snapshot!;
    assert.equal(saved.root!.visibilityEvidence, "visible"); assert.equal(saved.screenshotDataUrl, null);
    const exported = await exportDebugReportEvidence(f.source(), f.request(), f.parent, { appVersion: "0.1.0" });
    assert.equal(exported.error, null);
    const imported = await loadTestReport(join(exported.directory!, "report.json"));
    assert.deepEqual(imported.debug!.snapshots[0].snapshot!.helperObservation, saved.helperObservation);
  } finally { f.cleanup(); }
});
