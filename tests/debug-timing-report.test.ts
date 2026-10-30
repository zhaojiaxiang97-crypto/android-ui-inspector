import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createDebugTiming, measureDebugPhase, runWithDebugTiming } from "../electron/automation/debug-timing";
import { exportDebugReportEvidence } from "../electron/desktop/debug-report-export";
import { loadTestReport } from "../electron/desktop/test-report";
import type { DebugSessionReport } from "../shared/debug-report";
import { makeDebugReportExportFixture } from "./fixtures/debug-report-export";
import { helperEvidence } from "./fixtures/helper-protocol";

test("timings survive selected export and import while old steps remain unmeasured", async () => {
  const fixture = await makeDebugReportExportFixture();
  try {
    let now = 0;
    const timing = createDebugTiming({ now: () => now, date: () => fixture.report.steps[2].step.time });
    await runWithDebugTiming(timing, () => measureDebugPhase("observation", async () => {
      await measureDebugPhase("target_before", () => { now += 10; });
      await measureDebugPhase("hierarchy", () => { now += 20; });
      await measureDebugPhase("target_after", () => { now += 10; });
    }, { backend: "uiautomator", reason: "explicit" }));
    const expected = timing.finish("success");
    fixture.report.steps[2].step.timings = expected; fixture.save();
    const loaded = await loadTestReport(fixture.file);
    assert.equal(loaded.debug!.steps[0].step.timings, undefined);
    assert.deepEqual(loaded.debug!.steps[2].step.timings, expected);
    const exported = await exportDebugReportEvidence(fixture.source(), { ...fixture.request(), stepIds: [3] }, fixture.parent, { appVersion: "0.1.0" });
    assert.equal(exported.error, null);
    const path = join(exported.directory!, "report.json"), raw = JSON.parse(readFileSync(path, "utf8")) as DebugSessionReport;
    assert.deepEqual(raw.steps[0].step.timings, expected);
    assert.deepEqual((await loadTestReport(path)).debug!.steps[0].step.timings, expected);
    fixture.report.steps[2].step.timings!.spans[0].durationMs = 1000; fixture.save();
    await assert.rejects(loadTestReport(fixture.file));
  } finally { fixture.cleanup(); }
});

test("fixed endpoints and device-clock diagnostics roundtrip even for failed or cancelled tree spans", async () => {
  for (const status of ["success", "failed", "cancelled"] as const) {
    const fixture = await makeDebugReportExportFixture();
    try {
      let now = 0;
      const timing = createDebugTiming({ now: () => now, date: () => fixture.report.steps[2].step.time });
      const device = helperEvidence(1_000_000).timing;
      try {
        await runWithDebugTiming(timing, () => measureDebugPhase("observation", async () => {
          await measureDebugPhase("helper_request", () => { now += 2; }, { helperEndpoint: "snapshot" });
          await measureDebugPhase("helper_tree", () => {
            now += 1;
            if (status !== "success") throw status === "cancelled" ? new DOMException("private-cancel", "AbortError") : new Error("private-failure");
          }, { helperDeviceTiming: device, helperReportedComplete: status !== "failed" });
        }, { backend: "accessibility-helper", reason: "recovery" }));
      } catch { assert.notEqual(status, "success"); }
      const expected = timing.finish(status);
      fixture.report.steps[2].step.timings = expected; fixture.save();
      const loaded = await loadTestReport(fixture.file);
      assert.deepEqual(loaded.debug!.steps[2].step.timings, expected);
      assert.equal(loaded.debug!.steps[0].step.timings, undefined);
      const exported = await exportDebugReportEvidence(fixture.source(), { ...fixture.request(), stepIds: [3] }, fixture.parent, { appVersion: "test" });
      assert.equal(exported.error, null);
      const imported = await loadTestReport(join(exported.directory!, "report.json"));
      assert.deepEqual(imported.debug!.steps[0].step.timings, expected);
      assert.doesNotMatch(JSON.stringify(expected), /private-cancel|private-failure|127\.0\.0\.1|X-Artemis/);
      // Independent device uptime remains outside host offsets, not an invalid parent/child range.
      assert.ok(expected.spans.find(span => span.phase === "helper_tree")!.helperDeviceTiming!.startedAtMs > expected.durationMs);
      const valid = structuredClone(expected);
      for (const kind of ["missing-pair", "wrong-phase", "invalid-device-range", "unknown-endpoint"] as const) {
        fixture.report.steps[2].step.timings = structuredClone(valid);
        const spans = fixture.report.steps[2].step.timings!.spans, tree = spans.find(span => span.phase === "helper_tree")!;
        if (kind === "missing-pair") delete tree.helperReportedComplete;
        if (kind === "wrong-phase") tree.phase = "hierarchy";
        if (kind === "invalid-device-range") tree.helperDeviceTiming!.completedAtMs = 0;
        if (kind === "unknown-endpoint") Object.assign(spans[1], { helperEndpoint: "http://private.invalid/secret" });
        fixture.save(); await assert.rejects(loadTestReport(fixture.file), kind);
      }
    } finally { fixture.cleanup(); }
  }
});
