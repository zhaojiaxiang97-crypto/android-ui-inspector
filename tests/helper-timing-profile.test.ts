import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HelperTimingProfile, profileRegressionTimings } from "../scripts/helper-timing-profile";
import { createDebugTiming, measureDebugPhase, recordHelperServerTiming, runWithDebugTiming } from "../electron/device/debug-timing";
import { loadTestReport } from "../electron/desktop/test-report";
import type { DebugTimings } from "../shared/debug-timing";
import type { HelperObservationTiming, HelperServerTiming } from "../shared/helper-observation-timing";
import { makeDebugReportExportFixture } from "./fixtures/debug-report-export";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const device: HelperObservationTiming = { startedAtMs: 1000, hierarchyStartedAtMs: 1010, hierarchyCompletedAtMs: 1030,
  screenshotStartedAtMs: 1030, screenshotCompletedAtMs: 1035, completedAtMs: 1100,
  postProcessing: { windowValidationStartedAtMs: 1035, windowValidationCompletedAtMs: 1040,
    pngEncodingStartedAtMs: 1040, pngEncodingCompletedAtMs: 1060, base64EncodingStartedAtMs: 1060, base64EncodingCompletedAtMs: 1062 } };

const serverTiming: HelperServerTiming = { version: 1, queueMs: 2, preObservationMs: 5, observationMs: 101,
  jsonSerializationMs: 7, utf8EncodingMs: 1, cacheClearMs: 1, initialWindowReadMs: 4, getChildMs: 12.125, nodeLocalMs: 4.5 };

async function timings(reason: "explicit" | "recovery", fail = false, metadata = true, server?: HelperServerTiming): Promise<DebugTimings> {
  let now = 0;
  const timer = createDebugTiming({ now: () => now, date: () => "2026-10-17T00:00:00.000Z" });
  try {
    await runWithDebugTiming(timer, () => measureDebugPhase("observation", async () => {
      await measureDebugPhase("helper_request", async () => {
        await measureDebugPhase("helper_request_headers", () => { now += 80; if (server) recordHelperServerTiming(server); },
          { helperEndpoint: "snapshot" });
        await measureDebugPhase("helper_response_read", () => { now += 10; }, { helperEndpoint: "snapshot" });
      }, { helperEndpoint: "snapshot" });
      await measureDebugPhase("helper_json_parse", () => { now += 5; }, { helperEndpoint: "snapshot" });
      await measureDebugPhase("helper_tree", () => { now += 2; if (fail) throw Error("fixture-only"); },
        metadata ? { helperDeviceTiming: device, helperReportedComplete: !fail } : {});
      await measureDebugPhase("helper_png_validation", () => { now += 3; });
    }, { backend: "accessibility-helper", reason }));
  } catch { /* The failed read remains failed; this is only a timing fixture. */ }
  return timer.finish(fail ? "failed" : "success");
}

test("profile deduplicates frozen steps and captures without mixing device time into host totals", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const loaded = await loadTestReport(f.file), original = loaded.debug!;
    original.steps[0].step.timings = await timings("explicit");
    original.snapshots[0].snapshot = helperEvidenceSnapshot();
    original.snapshots[0].snapshot.helperObservation!.timing = structuredClone(device);
    const profile = new HelperTimingProfile(); profile.add(loaded); profile.add(loaded);
    const s = profile.summary();
    assert.equal(s.archives, 2); assert.equal(s.uniqueSteps, 3); assert.equal(s.measuredSteps, 1); assert.equal(s.unmeasuredSteps, 2);
    assert.equal(s.productMeasuredMs, 100);
    assert.equal(s.observationLedger.length, 1, "duplicate archives cannot inflate the ledger");
    assert.equal(s.observationLedger[0].durationMs, 100);
    assert.equal(s.observationLedger[0].measuredHostCoverageMs, 100);
    assert.equal(s.observationLedger[0].unmeasuredHostMs, 0);
    assert.equal(s.hostObservationGroups.normal.observations.totalMs, 100);
    assert.equal(s.hostObservationGroups.normal.requests.snapshot.requests.totalMs, 90);
    assert.equal(s.hostObservationGroups.normal.requests.snapshot.headers.totalMs, 80);
    assert.equal(s.deviceAttemptGroups.normal.phases.total.totalMs, 100);
    assert.equal(s.deviceAttemptGroups.normal.phases.unattributed.totalMs, 48);
    assert.equal(s.archivedDeviceCaptures.count, 1); assert.equal(s.archivedDeviceCaptures.total.totalMs, 100);
    const text = JSON.stringify(s);
    for (const secret of [f.report.session.id, f.report.session.packageName, f.report.session.serial, "fixture-private", "离线页面"])
      if (secret) assert.equal(text.includes(secret), false);
    s.deviceAttemptGroups.normal.phases.total.totalMs = 999;
    assert.equal(profile.summary().deviceAttemptGroups.normal.phases.total.totalMs, 100);
  } finally { f.cleanup(); }
});

test("automatic retry and independent resume use exact step and parent observation rather than device clock matching", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const loaded = await loadTestReport(f.file), steps = loaded.debug!.steps;
    steps[0].step.timings = await timings("explicit", true); steps[0].step.status = "failed";
    steps[1].step.timings = await timings("recovery");
    steps[2].step.timings = await timings("recovery"); steps[2].step.action = "resume_ui_step";
    const profile = new HelperTimingProfile(); profile.add(loaded); const s = profile.summary();
    assert.equal(s.hostObservationGroups.normal.failed, 1);
    assert.equal(s.deviceAttemptGroups.normal.reportedIncomplete, 1);
    assert.equal(s.deviceAttemptGroups.normal.hostObservationFailed, 1);
    assert.equal(s.hostObservationGroups.automaticRetry.observations.count, 1);
    assert.equal(s.hostObservationGroups.independentResume.observations.count, 1);
    assert.equal(s.deviceAttemptGroups.automaticRetry.phases.count, 1);
    assert.equal(s.deviceAttemptGroups.independentResume.phases.count, 1);
    assert.equal(s.productMeasuredMs, 297);
    assert.deepEqual(s.observationLedger.map(row => row.group), ["normal", "automaticRetry", "independentResume"]);
    assert.deepEqual(s.observationLedger.map(row => row.status), ["failed", "success", "success"]);
  } finally { f.cleanup(); }
});

test("old reports keep endpoint and device timing missing rather than measured zero", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const loaded = await loadTestReport(f.file), t = await timings("explicit", false, false);
    for (const span of t.spans) delete span.helperEndpoint;
    loaded.debug!.steps[0].step.timings = t;
    const snapshot = helperEvidenceSnapshot(); loaded.debug!.snapshots[0].snapshot = snapshot;
    const profile = new HelperTimingProfile(); profile.add(loaded); const s = profile.summary();
    assert.equal(s.hostObservationGroups.normal.missingDeviceTimingAttempts, 1);
    assert.equal(s.hostObservationGroups.normal.requests.unlabelled.headers.totalMs, 80);
    assert.equal(s.hostObservationGroups.normal.requests.snapshot.headers.count, 0);
    assert.equal(s.deviceAttemptGroups.normal.phases.total.meanMs, null);
    assert.equal(s.archivedDeviceCaptures.count, 1);
    assert.equal(s.archivedDeviceCaptures.pngEncoding.count, 0);
    assert.equal(s.archivedDeviceCaptures.pngEncoding.meanMs, null);
    assert.equal(s.observationLedger[0].deviceTiming, null);
    assert.equal(s.observationLedger[0].serverTiming, null);
    assert.equal(s.observationLedger[0].snapshotHeaderMs, null);
  } finally { f.cleanup(); }
});

test("observation ledger counts parallel host intervals once and keeps device/server time on separate clocks", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const loaded = await loadTestReport(f.file), t = await timings("explicit", false, true, serverTiming);
    t.spans.push({ id: 999, parentId: t.spans[0].id, phase: "target_after", startOffsetMs: 96, durationMs: 4, status: "success" });
    loaded.debug!.steps[0].step.timings = t;
    const profile = new HelperTimingProfile(); profile.add(loaded);
    const row = profile.summary().observationLedger[0];
    assert.equal(row.measuredHostCoverageMs, 100);
    assert.equal(row.hostPhases.target_after.totalMs, 4);
    assert.equal(row.hostPhases.helper_png_validation.totalMs, 3);
    assert.equal(row.deviceTiming!.totalMs, 100);
    assert.equal(row.serverTiming!.observationMs, 101);
    assert.equal(row.durationMs, 100, "independent clocks must not be added to observation duration");
    row.deviceTiming!.totalMs = 999;
    assert.equal(profile.summary().observationLedger[0].deviceTiming!.totalMs, 100);
  } finally { f.cleanup(); }
});

test("navigation ledger distinguishes input-to-read delay, failed reads and recovery spacing on the host clock", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    let now = 0;
    const timer = createDebugTiming({ now: () => now, date: () => "2026-10-22T00:00:00.000Z" });
    await runWithDebugTiming(timer, async () => {
      await measureDebugPhase("observation", () => { now = 4; }, { reason: "before_action" });
      now = 10;
      await measureDebugPhase("input", async () => {
        now = 11;
        await measureDebugPhase("input", () => { now = 13; });
        now = 14;
      });
      now = 16;
      await assert.rejects(measureDebugPhase("observation", () => measureDebugPhase("target_before", () => {
        now = 20; throw Error("private-foreground-output");
      }), { reason: "after_action" }));
      now = 270;
      await assert.rejects(measureDebugPhase("observation", async () => {
        await measureDebugPhase("helper_request_headers", () => { now = 272; }, { helperEndpoint: "snapshot" });
        await measureDebugPhase("helper_tree", () => { now = 280; throw Error("private-page-text"); },
          { helperDeviceTiming: device, helperReportedComplete: false });
      }, { reason: "recovery" }));
    });
    const loaded = await loadTestReport(f.file);
    loaded.debug!.steps[0].step.timings = timer.finish("failed");
    loaded.debug!.steps[0].step.action = "perform_ui_step";
    const profile = new HelperTimingProfile(); profile.add(loaded);
    const rows = profile.summary().observationLedger;
    assert.equal(rows[0].hostTimeline.sinceInputMs, null);
    assert.equal(rows[0].hostTimeline.sincePreviousObservationMs, null);
    assert.deepEqual(rows[1].hostTimeline, { complete: true, startOffsetMs: 16, endOffsetMs: 20,
      inputEndOffsetMs: 14, sinceInputMs: 2, previousObservationEndOffsetMs: 4, sincePreviousObservationMs: 12 });
    assert.equal(rows[1].durationMs, 4, "time since step start is not the failed read duration");
    assert.equal(rows[1].snapshotHeaders, 0);
    assert.deepEqual(rows[1].failedPhases, ["target_before"]);
    assert.equal(rows[1].helperReportedComplete, null);
    assert.equal(rows[2].hostTimeline.sinceInputMs, 256);
    assert.equal(rows[2].hostTimeline.sincePreviousObservationMs, 250);
    assert.deepEqual(rows[2].failedPhases, ["helper_tree"]);
    assert.equal(rows[2].helperReportedComplete, false);
    assert.equal(rows[2].snapshotHeaders, 1);
    assert(!/private-foreground-output|private-page-text/.test(JSON.stringify(rows)));
  } finally { f.cleanup(); }
});

test("navigation gaps stay unavailable for independent resume and incomplete span archives", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const loaded = await loadTestReport(f.file), first = await timings("explicit");
    first.spans.unshift({ id: 999, parentId: null, phase: "input", startOffsetMs: 0, durationMs: 0, status: "success" });
    first.droppedSpans = 1;
    loaded.debug!.steps[0].step.timings = first;
    loaded.debug!.steps[1].step.timings = await timings("recovery");
    loaded.debug!.steps[1].step.action = "resume_ui_step";
    const profile = new HelperTimingProfile(); profile.add(loaded);
    const [dropped, resumed] = profile.summary().observationLedger;
    assert.equal(dropped.hostTimeline.complete, false);
    assert.equal(dropped.hostTimeline.inputEndOffsetMs, null);
    assert.equal(dropped.hostTimeline.sinceInputMs, null);
    assert.equal(dropped.hostTimeline.sincePreviousObservationMs, null);
    assert.equal(resumed.hostTimeline.complete, true);
    assert.equal(resumed.hostTimeline.sinceInputMs, null, "resume cannot borrow another step's input offset");
    assert.equal(resumed.hostTimeline.sincePreviousObservationMs, null);
  } finally { f.cleanup(); }
});

test("conflicting duplicate measurements, mixed sessions and invalid attachments stop profiling", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const loaded = await loadTestReport(f.file); loaded.debug!.steps[0].step.timings = await timings("explicit");
    const profile = new HelperTimingProfile(); profile.add(loaded);
    const changed = structuredClone(loaded); changed.debug!.steps[0].step.timings!.durationMs++;
    assert.throws(() => profile.add(changed), /conflicting_step/);
    const foreign = structuredClone(loaded); foreign.debug!.session.id = "different-session";
    assert.throws(() => profile.add(foreign), /mixed_sessions/);
    const invalid = structuredClone(loaded); invalid.images[0].error = "invalid bytes";
    assert.throws(() => new HelperTimingProfile().add(invalid), /invalid_attachment/);
    const capture = structuredClone(loaded); capture.debug!.snapshots[0].snapshot = helperEvidenceSnapshot();
    const p2 = new HelperTimingProfile(); p2.add(capture); capture.debug!.snapshots[0].snapshot!.helperObservation!.timing.completedAtMs++;
    assert.throws(() => p2.add(capture), /conflicting_capture/);
  } finally { f.cleanup(); }
});

test("offline entry loads only unique frozen reports inside the chosen run and rejects unavailable archives", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const samples = join(f.root, "samples.jsonl");
    const result = { event: "result", archives: [{ reportPath: f.file }, { reportPath: f.file }] };
    writeFileSync(samples, `${JSON.stringify(result)}\n${JSON.stringify(result)}\n`);
    const s = await profileRegressionTimings(samples);
    assert.equal(s.archives, 1); assert.equal(s.uniqueSteps, 3); assert.equal(s.measuredSteps, 0);
    writeFileSync(samples, JSON.stringify({ event: "result", archives: [{ reportPath: null }] }));
    await assert.rejects(profileRegressionTimings(samples), /archive_path_required/);
    const outside = join(f.parent, "samples.jsonl");
    writeFileSync(outside, JSON.stringify(result));
    await assert.rejects(profileRegressionTimings(outside), /archive_outside_regression/);
  } finally { f.cleanup(); }
});

test("server timing separates nested tree work and signed header differences with exact attempt pairing", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const loaded = await loadTestReport(f.file);
    loaded.debug!.steps[0].step.timings = await timings("explicit", false, true, serverTiming);
    loaded.debug!.steps[1].step.timings = await timings("recovery", true, true, serverTiming);
    loaded.debug!.steps[2].step.action = "resume_ui_step";
    loaded.debug!.steps[2].step.timings = await timings("recovery", false, true, serverTiming);
    const profile = new HelperTimingProfile(); profile.add(loaded); profile.add(loaded);
    const s = profile.summary();
    for (const group of ["normal", "automaticRetry", "independentResume"] as const) {
      const b = s.serverAttemptGroups[group];
      assert.equal(b.snapshotHeaders, 1); assert.equal(b.timedHeaders, 1); assert.equal(b.missingTimingHeaders, 0);
      assert.equal(b.measuredBeforeHeaders.totalMs, 116, "nested tree work is not added twice");
      assert.equal(b.hostHeaderDifference.totalMs, -36, "negative clock differences are not clamped");
      assert.equal(b.matchedDeviceObservations, 1); assert.equal(b.observationOutsideBodyTiming.totalMs, 1);
      assert.equal(b.hierarchyOutsideNodeWork.totalMs, 3.375);
      assert.equal(b.phases.getChildMs.totalMs, 12.125);
    }
    assert.equal(s.deviceAttemptGroups.automaticRetry.hostObservationFailed, 1);
    s.serverAttemptGroups.normal.phases.getChildMs.totalMs = 999;
    assert.equal(profile.summary().serverAttemptGroups.normal.phases.getChildMs.totalMs, 12.125);
    const changed = structuredClone(loaded);
    changed.debug!.steps[0].step.timings!.spans.find(span => span.helperServerTiming)!.helperServerTiming!.queueMs++;
    assert.throws(() => profile.add(changed), /conflicting_step/);
  } finally { f.cleanup(); }
});

test("missing headers, optional server phases and body timings remain distinct unavailable populations", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const loaded = await loadTestReport(f.file), partial = { ...serverTiming };
    delete partial.cacheClearMs; delete partial.initialWindowReadMs; delete partial.getChildMs; delete partial.nodeLocalMs;
    loaded.debug!.steps[0].step.timings = await timings("explicit", false, false, partial);
    loaded.debug!.steps[1].step.timings = await timings("explicit", false, false);
    const profile = new HelperTimingProfile(); profile.add(loaded);
    const b = profile.summary().serverAttemptGroups.normal;
    assert.equal(b.snapshotHeaders, 2); assert.equal(b.timedHeaders, 1); assert.equal(b.missingTimingHeaders, 1);
    assert.equal(b.phases.getChildMs.count, 0); assert.equal(b.phases.getChildMs.meanMs, null);
    assert.equal(b.phases.cacheClearMs.count, 0); assert.equal(b.phases.cacheClearMs.meanMs, null);
    assert.equal(b.matchedDeviceObservations, 0); assert.equal(b.observationOutsideBodyTiming.meanMs, null);
    assert.equal(b.hierarchyOutsideNodeWork.meanMs, null);
  } finally { f.cleanup(); }
});

test("multiple server measurements for one observation are rejected instead of paired heuristically", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const loaded = await loadTestReport(f.file), t = await timings("explicit", false, true, serverTiming);
    const first = t.spans.find(span => span.helperServerTiming)!;
    t.spans.push({ ...structuredClone(first), id: t.spans.length + 1 });
    loaded.debug!.steps[0].step.timings = t;
    assert.throws(() => new HelperTimingProfile().add(loaded), /multiple_server_timings/);
  } finally { f.cleanup(); }
});
