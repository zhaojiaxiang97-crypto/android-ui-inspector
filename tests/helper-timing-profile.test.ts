import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HelperTimingProfile, profileRegressionTimings } from "../scripts/helper-timing-profile";
import { createDebugTiming, measureDebugPhase, runWithDebugTiming } from "../electron/device/debug-timing";
import { loadTestReport } from "../electron/desktop/test-report";
import type { DebugTimings } from "../shared/debug-timing";
import type { HelperObservationTiming } from "../shared/helper-observation-timing";
import { makeDebugReportExportFixture } from "./fixtures/debug-report-export";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const device: HelperObservationTiming = { startedAtMs: 1000, hierarchyStartedAtMs: 1010, hierarchyCompletedAtMs: 1030,
  screenshotStartedAtMs: 1030, screenshotCompletedAtMs: 1035, completedAtMs: 1100,
  postProcessing: { windowValidationStartedAtMs: 1035, windowValidationCompletedAtMs: 1040,
    pngEncodingStartedAtMs: 1040, pngEncodingCompletedAtMs: 1060, base64EncodingStartedAtMs: 1060, base64EncodingCompletedAtMs: 1062 } };

async function timings(reason: "explicit" | "recovery", fail = false, metadata = true): Promise<DebugTimings> {
  let now = 0;
  const timer = createDebugTiming({ now: () => now, date: () => "2026-10-17T00:00:00.000Z" });
  try {
    await runWithDebugTiming(timer, () => measureDebugPhase("observation", async () => {
      await measureDebugPhase("helper_request", async () => {
        await measureDebugPhase("helper_request_headers", () => { now += 80; }, { helperEndpoint: "snapshot" });
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
