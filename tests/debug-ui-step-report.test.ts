import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { exportDebugReportEvidence } from "../electron/desktop/debug-report-export";
import { loadTestReport } from "../electron/desktop/test-report";
import { debugToolSchemas } from "../shared/debug-protocol";
import { debugVerificationState } from "../src/features/reports/debug-report-view";
import { exportDigest, makeDebugReportExportFixture } from "./fixtures/debug-report-export";

async function compoundFixture() {
  const f = await makeDebugReportExportFixture();
  const original = f.report.steps[1], resume = f.report.steps[2], requestId = "abcdef00-0000-4000-8000-000000000099";
  const referenceSnapshotId = f.report.snapshots[0].snapshotId, currentSnapshotId = f.report.snapshots[1].snapshotId;
  original.step.action = "perform_ui_step"; original.step.status = "done"; delete original.step.error;
  original.step.input = debugToolSchemas.perform_ui_step.parse({ sessionId: f.report.session.id, requestId,
    action: { kind: "tap" }, target: { selector: { text: "离线页面2" } }, expect: { selector: { text: "离线页面3" } },
    visualConfirmation: { snapshotId: referenceSnapshotId, description: "离线目标位于屏幕中央" } });
  original.step.beforeId = currentSnapshotId; original.before = { snapshotId: currentSnapshotId, freshness: "current", reason: null };
  original.step.dispatchState = "sent"; original.verified = false;
  original.step.resolvedInput = { action: { kind: "tap", x: 2, y: 3 }, frame: { width: 4, height: 6, rotation: 0 }, targetNodeId: "0", anchorNodeId: "0",
    visualConfirmation: { referenceSnapshotId, currentSnapshotId, description: "离线目标位于屏幕中央",
      region: { left: 0, top: 1, width: 4, height: 5 }, sha256: exportDigest("offline-visual-region"), overlapNodeIds: [] } };
  resume.step.action = "resume_ui_step";
  resume.step.input = debugToolSchemas.resume_ui_step.parse({ sessionId: f.report.session.id, requestId: requestId.toUpperCase() });
  resume.step.dispatchState = "sent"; resume.step.verified = resume.verified = true;
  f.save(); return f;
}

test("compound visual evidence and read-only resume roundtrip with original expectations", async () => {
  const f = await compoundFixture();
  try {
    const loaded = await loadTestReport(f.file);
    assert.equal(loaded.debug!.steps[2].verified, true);
    assert.equal(debugVerificationState(loaded.debug!.steps[2]), "passed");
    assert.equal(loaded.debug!.steps[2].step.inputEvidence, undefined);
    assert.equal(loaded.debug!.steps[2].step.resolvedInput, undefined);
    const exported = await exportDebugReportEvidence(f.source(), f.request(), f.parent, { appVersion: "0.1.0" });
    assert.equal(exported.error, null);
    const imported = await loadTestReport(join(exported.directory!, "report.json"));
    assert.deepEqual(imported.debug!.steps[1].step.resolvedInput, f.report.steps[1].step.resolvedInput);
    assert.equal(imported.debug!.steps[2].verified, true);
  } finally { f.cleanup(); }
});

test("a selected resume without its original request stays readable but cannot claim verified", async () => {
  const f = await compoundFixture();
  try {
    const exported = await exportDebugReportEvidence(f.source(), { ...f.request(), stepIds: [3] }, f.parent, { appVersion: "0.1.0" });
    assert.equal(exported.error, null);
    const imported = await loadTestReport(join(exported.directory!, "report.json"));
    assert.equal(imported.debug!.steps[0].verified, null);
    assert.equal(imported.debug!.steps[0].step.dispatchState, "sent");
    assert.equal(debugVerificationState(imported.debug!.steps[0]), "unverified");
    assert.equal(imported.index.cases[0].attempts[0].steps[0].status, "completed");
    assert.ok(imported.index.run.errors.some(error => error?.code === "original-ui-step-unavailable"));
  } finally { f.cleanup(); }
});

test("compound report validation rejects altered references, missing expectations and input during resume", async () => {
  const f = await compoundFixture();
  try {
    const valid = structuredClone(f.report);
    const changes = [
      () => { delete f.report.steps[1].step.input.expect; },
      () => { f.report.steps[1].verified = true; delete f.report.steps[1].step.input.expect; },
      () => { f.report.steps[1].step.resolvedInput!.visualConfirmation!.referenceSnapshotId = f.report.session.id; },
      () => { f.report.steps[1].step.resolvedInput!.action = { kind: "back" }; },
      () => { f.report.steps[2].step.resolvedInput = structuredClone(f.report.steps[1].step.resolvedInput); },
      () => { f.report.steps[2].step.dispatchState = "unknown"; },
      () => { f.report.steps[2].step.action = "get_ui_step"; },
    ];
    for (const change of changes) {
      Object.assign(f.report, structuredClone(valid)); change(); f.save(); await assert.rejects(loadTestReport(f.file));
    }
  } finally { f.cleanup(); }
});

test("compound scroll maps to a swipe receipt and does not require a top-level snapshotId", async () => {
  const f = await compoundFixture();
  try {
    const original = f.report.steps[1];
    original.step.input = debugToolSchemas.perform_ui_step.parse({ ...original.step.input, action: { kind: "scroll", direction: "down" } });
    original.step.resolvedInput!.action = { kind: "swipe", fromX: 2, fromY: 5, toX: 2, toY: 2, durationMs: 350 };
    f.save();
    const loaded = await loadTestReport(f.file);
    assert.equal(loaded.debug!.steps[1].step.input.snapshotId, undefined);
    assert.equal(loaded.debug!.steps[1].step.resolvedInput!.action.kind, "swipe");
  } finally { f.cleanup(); }
});
