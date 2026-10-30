import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createDebugTiming, measureDebugPhase, runWithDebugTiming } from "../electron/automation/debug-timing";
import { exportDebugReportEvidence } from "../electron/desktop/debug-report-export";
import { loadTestReport } from "../electron/desktop/test-report";
import type { DebugSessionReport } from "../shared/debug-report";
import { makeDebugReportExportFixture } from "./fixtures/debug-report-export";

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
