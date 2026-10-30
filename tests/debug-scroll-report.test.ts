import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { exportDebugReportEvidence } from "../electron/desktop/debug-report-export";
import { loadTestReport } from "../electron/desktop/test-report";
import { debugToolSchemas } from "../shared/debug-protocol";
import { isDebugScrollProgress } from "../shared/debug-scroll-validation";
import type { DebugInputEvidence } from "../shared/types";
import { DebugReportScrollProgress } from "../src/features/reports/DebugReportScrollProgress";
import { debugDispatchLabel, debugScrollInputCounts, debugScrollStopLabel, debugVerificationState } from "../src/features/reports/debug-report-view";
import { makeDebugReportExportFixture } from "./fixtures/debug-report-export";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const receipt: DebugInputEvidence = { classification: "accepted", spawned: true, closed: true, exitCode: 0, signal: null,
  durationMs: 20, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
async function fixture() {
  const f = await makeDebugReportExportFixture();
  const entry = f.report.steps[2], ids = f.report.snapshots.map(item => item.snapshotId);
  entry.step.action = "scroll_until";
  entry.step.time = f.report.session.startedAt;
  entry.step.input = debugToolSchemas.scroll_until.parse({ sessionId: f.report.session.id,
    requestId: "abcdef00-0000-4000-8000-000000000099", target: { selector: { className: "List" } },
    direction: "down", until: { selector: { text: "目标" }, kind: "target" } });
  entry.step.beforeId = ids[0]; entry.before = { snapshotId: ids[0], freshness: "current", reason: null };
  entry.step.dispatchState = "sent"; entry.step.verified = entry.verified = true;
  entry.step.scrollTask = { stopReason: "target_found", observationIds: ids,
    iterations: [{ index: 1, startedAt: entry.step.time, durationMs: 1000, beforeId: ids[0], afterId: ids[1],
      dispatchState: "sent", progress: "changed", inputEvidence: receipt,
      resolvedInput: { action: { kind: "swipe", fromX: 2, fromY: 5, toX: 2, toY: 2, durationMs: 350 },
        frame: { width: 4, height: 6, rotation: 0 }, targetNodeId: "0" } }],
    confirmation: { firstSnapshotId: ids[1], secondSnapshotId: ids[2], kind: "target" } };
  f.report.steps = [entry]; f.report.session.droppedSteps = 2; f.save();
  return { ...f, entry, ids };
}

test("scroll report preserves every iteration and confirmation through selected export without creating steps", async () => {
  const f = await fixture();
  try {
    const loaded = await loadTestReport(f.file);
    assert.equal(loaded.debug!.steps.length, 1);
    assert.equal(debugVerificationState(loaded.debug!.steps[0]), "passed");
    const exported = await exportDebugReportEvidence(f.source(), { ...f.request(), stepIds: [3] }, f.parent, { appVersion: "0.1.0" });
    assert.equal(exported.error, null);
    const result = await loadTestReport(join(exported.directory!, "report.json"));
    assert.equal(result.debug!.snapshots.length, 3, "intermediate confirmation survives selected export");
    assert.deepEqual(result.debug!.steps[0].step.scrollTask, f.entry.step.scrollTask);
    assert.equal(result.debug!.session.totalSteps, 3);
    assert.equal(result.debug!.session.droppedSteps, 2);
    assert.equal(result.debug!.steps[0].step.inputEvidence, undefined);
  } finally { f.cleanup(); }
});

test("missing confirmation trees downgrade a scroll assertion without dropping its traces", async () => {
  const f = await fixture();
  try {
    const exported = await exportDebugReportEvidence(f.source(), { ...f.request(), includeTrees: false }, f.parent, { appVersion: "0.1.0" });
    assert.equal(exported.error, null);
    const result = await loadTestReport(join(exported.directory!, "report.json"));
    assert.equal(result.debug!.steps[0].verified, null);
    assert.equal(result.debug!.steps[0].step.scrollTask!.iterations.length, 1);
    assert.equal(result.index.cases[0].attempts[0].steps[0].status, "completed");
    assert.ok(result.index.run.errors.some(error => error?.code === "scroll-confirmation-unavailable"));
  } finally { f.cleanup(); }
});

test("scroll confirmation must match its requested backend and original Helper service", async () => {
  const f = await fixture();
  try {
    f.entry.step.input.backend = "accessibility-helper"; f.save();
    assert.equal((await loadTestReport(f.file)).debug!.steps[0].verified, null, "UIAutomator cannot prove a Helper request");
    for (const [index, item] of f.report.snapshots.entries()) {
      const tree = JSON.parse(readFileSync(join(f.directory, item.tree!.path), "utf8"));
      tree.snapshot = helperEvidenceSnapshot({ packageName: f.report.session.packageName, serial: f.report.session.serial,
        width: 4, height: 6, startedAt: 100 + index * 400 });
      const root = tree.snapshot.root, marker = structuredClone(root);
      marker.id = "0/0"; marker.text = "目标"; marker.attributes.text = "目标";
      root.className = root.attributes.class = "List"; root.scrollable = true; root.attributes.scrollable = "true";
      root.text = null; root.attributes.text = ""; root.children = [marker]; tree.snapshot.nodeCount = 2;
      item.tree = f.artifact(Buffer.from(JSON.stringify(tree)), "json"); item.source = "accessibility-helper";
    }
    f.save();
    assert.equal((await loadTestReport(f.file)).debug!.steps[0].verified, true);
    const start = f.report.snapshots[0];
    const tree = JSON.parse(readFileSync(join(f.directory, start.tree!.path), "utf8"));
    tree.snapshot.helperObservation.serviceInstanceId = "10000000-0000-4000-8000-000000000099";
    start.tree = f.artifact(Buffer.from(JSON.stringify(tree)), "json"); f.save();
    const changed = await loadTestReport(f.file);
    assert.equal(changed.debug!.steps[0].verified, null, "another service cannot confirm the original request");
    assert.equal(changed.debug!.steps[0].step.dispatchState, "sent");
  } finally { f.cleanup(); }
});

test("scroll progress rejects malformed or conflicting bounded records", async () => {
  const f = await fixture();
  try {
    const source = f.entry.step.scrollTask!;
    assert.equal(isDebugScrollProgress(source), true);
    const changes = [
      (p: typeof source) => { p.iterations[0].index = 2; },
      (p: typeof source) => { p.iterations[0].durationMs = Infinity; },
      (p: typeof source) => { p.observationIds.push(p.observationIds[0]); },
      (p: typeof source) => { p.confirmation!.secondSnapshotId = p.confirmation!.firstSnapshotId; },
      (p: typeof source) => { p.stopReason = "no_progress"; },
      (p: typeof source) => { p.iterations[0].beforeId = f.report.session.id; },
      (p: typeof source) => { p.iterations[0].resolvedInput!.action = { kind: "tap", x: 2, y: 2 }; },
      (p: typeof source) => { p.iterations[0].resolvedInput!.frame.width = 1; },
      (p: typeof source) => { p.iterations[0].dispatchState = "not_sent"; },
      (p: typeof source) => { delete p.iterations[0].resolvedInput; },
      (p: typeof source) => { p.iterations = Array.from({ length: 13 }, (_, i) => ({ ...p.iterations[0], index: i + 1 })); },
    ];
    for (const mutate of changes) { const candidate = structuredClone(source); mutate(candidate); assert.equal(isDebugScrollProgress(candidate), false); }
    const interrupted = structuredClone(source); interrupted.stopReason = "interrupted"; delete interrupted.confirmation;
    interrupted.iterations[0].dispatchState = "unknown"; delete interrupted.iterations[0].inputEvidence;
    assert.equal(isDebugScrollProgress(interrupted), true);
  } finally { f.cleanup(); }
});

test("scroll failures never promote no-progress, empty or uncertain dispatch into success", async () => {
  const f = await fixture();
  try {
    const source = structuredClone(f.report);
    for (const reason of ["no_progress", "scroll_limit", "empty"] as const) {
      Object.assign(f.report, structuredClone(source));
      const entry = f.report.steps[0]; entry.step.scrollTask!.stopReason = reason;
      if (reason === "empty") { entry.step.input.empty = { text: "空" }; entry.step.scrollTask!.confirmation!.kind = "empty"; }
      else delete entry.step.scrollTask!.confirmation;
      f.save(); await assert.rejects(loadTestReport(f.file));
      entry.verified = entry.step.verified = false; f.save();
      const loaded = await loadTestReport(f.file);
      assert.equal(debugVerificationState(loaded.debug!.steps[0]), "unverified");
    }
    const progress = structuredClone(source.steps[0].step.scrollTask!);
    progress.iterations[0].dispatchState = "unknown";
    assert.deepEqual(debugScrollInputCounts(progress), { confirmed: 0, notSent: 0, unknown: 1 });
    assert.match(debugScrollStopLabel("no_progress"), /未确认到底/);
    const html = renderToStaticMarkup(createElement(DebugReportScrollProgress, { progress,
      data: { session: f.report.session, steps: [], snapshots: [] }, resumed: true }));
    assert.match(html, /本次恢复只重新观察/); assert.match(html, /派发未确认/); assert.match(html, /树证据未保留/);
    assert.match(debugDispatchLabel({ ...source.steps[0].step, action: "resume_ui_step", scrollTask: progress }), /本次只读恢复/);
  } finally { f.cleanup(); }
});

test("read-only scroll resume restores original traces and rejects mutated gestures", async () => {
  const f = await fixture();
  try {
    const previous = f.report.snapshots[2];
    const ids = ["00000000-0000-4000-8000-000000000005", "00000000-0000-4000-8000-000000000006"];
    for (let i = 0; i < ids.length; i++) {
      const tree = JSON.parse(readFileSync(join(f.directory, previous.tree!.path), "utf8"));
      tree.snapshotId = ids[i]; tree.capturedAt = `2026-10-12T09:00:0${3 + i}.000Z`;
      f.report.snapshots.push({ ...previous, snapshotId: ids[i], capturedAt: tree.capturedAt,
        tree: f.artifact(Buffer.from(JSON.stringify(tree)), "json") });
    }
    const resumed = structuredClone(f.entry);
    resumed.step.id = 4; resumed.step.time = "2026-10-12T09:00:03.000Z"; resumed.finishedAt = "2026-10-12T09:00:05.000Z";
    resumed.step.action = "resume_ui_step";
    resumed.step.input = debugToolSchemas.resume_ui_step.parse({ sessionId: f.report.session.id, requestId: f.entry.step.input.requestId });
    resumed.step.beforeId = ids[0]; resumed.before.snapshotId = ids[0]; resumed.step.afterId = ids[1]; resumed.after.snapshotId = ids[1];
    resumed.step.scrollTask!.observationIds.push(...ids);
    resumed.step.scrollTask!.confirmation = { firstSnapshotId: ids[0], secondSnapshotId: ids[1], kind: "target" };
    f.report.steps.push(resumed); f.report.session.totalSteps = 4; f.report.session.updatedAt = resumed.finishedAt; f.save();
    assert.equal((await loadTestReport(f.file)).debug!.steps[1].verified, true);
    const exported = await exportDebugReportEvidence(f.source(), { ...f.request(), stepIds: [4] }, f.parent, { appVersion: "0.1.0" });
    assert.equal(exported.error, null);
    const imported = await loadTestReport(join(exported.directory!, "report.json"));
    assert.equal(imported.debug!.steps[0].verified, null);
    assert.equal(imported.debug!.steps[0].step.scrollTask!.iterations.length, 1);
    // Crash recovery keeps whole-request uncertainty even with an earlier sent receipt.
    f.entry.step.status = "failed"; f.entry.verified = f.entry.step.verified = false;
    f.entry.step.scrollTask!.stopReason = "interrupted"; delete f.entry.step.scrollTask!.confirmation;
    f.entry.step.dispatchState = resumed.step.dispatchState = "unknown";
    f.save();
    const uncertain = await loadTestReport(f.file);
    assert.equal(uncertain.debug!.steps[1].step.dispatchState, "unknown");
    assert.equal(uncertain.debug!.steps[1].verified, true, "fresh target confirmation does not imply input dispatch confirmation");
    assert.match(debugDispatchLabel(uncertain.debug!.steps[1].step), /请求派发仍未确认/);
    resumed.step.dispatchState = "sent"; f.save(); await assert.rejects(loadTestReport(f.file));
    resumed.step.dispatchState = "unknown";
    f.entry.step.dispatchState = "sent"; f.save();
    assert.equal((await loadTestReport(f.file)).debug!.steps[1].step.dispatchState, "unknown", "restarted ledger may conservatively downgrade the report's earlier dispatch");
    f.entry.step.dispatchState = "unknown"; f.save();
    const subset = await exportDebugReportEvidence(f.source(), { ...f.request(), stepIds: [4] }, f.parent, { appVersion: "0.1.0" });
    assert.equal(subset.error, null);
    const uncertainSubset = await loadTestReport(join(subset.directory!, "report.json"));
    assert.equal(uncertainSubset.debug!.steps[0].verified, null);
    assert.equal(uncertainSubset.debug!.steps[0].step.dispatchState, "unknown");
    f.entry.step.scrollTask!.iterations[0].dispatchState = resumed.step.scrollTask!.iterations[0].dispatchState = "unknown";
    f.entry.step.dispatchState = resumed.step.dispatchState = "sent"; f.save(); await assert.rejects(loadTestReport(f.file));
    f.entry.step.scrollTask!.iterations[0].dispatchState = resumed.step.scrollTask!.iterations[0].dispatchState = "sent";
    f.entry.step.dispatchState = resumed.step.dispatchState = "unknown";
    resumed.step.scrollTask!.iterations[0].durationMs += 1; f.save(); await assert.rejects(loadTestReport(f.file));
    resumed.step.scrollTask!.iterations[0].durationMs -= 1;
    resumed.step.inputEvidence = receipt; f.save(); await assert.rejects(loadTestReport(f.file));
  } finally { f.cleanup(); }
});
