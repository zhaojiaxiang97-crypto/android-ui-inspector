import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePipelineWaits, validateSnapshotWaits } from "../scripts/pipeline-wait-validation";

function fixture() {
  const keys = ["context", "contextCpu", "draw", "drawCpu", "verify", "verifyCpu", "snapshotPrepare", "snapshotInvoke"];
  const groups = [64, 343].map((count, index) => ({
    group: index === 0 ? "fixed64" : "remaining343", uiCalls: count, encodeCalls: count, drains: count,
    jsonCalls: index === 0 ? 64 : 341, sdkUi: Object.fromEntries(keys.map(key => [`${key}Nanos`, 0])),
    captureWaitNanos: 100, uiQueueNanos: 10, uiTaskNanos: 60, encodeQueueNanos: 20,
    encodeWallNanos: 50, encodeCpuNanos: 30, jsonWallNanos: 20, jsonCpuNanos: 10, hashWallNanos: 10,
    futureGetNanos: 10, tailFutureGetNanos: 2, writeNanos: 5,
  }));
  return {
    wallNanos: 232, uiQueueNanos: 20, uiTaskNanos: 120, encodeWallNanos: 100, encodeCpuNanos: 60,
    jsonWallNanos: 40, jsonCpuNanos: 20, geometryCheckWallNanos: 20,
    sdkPhases: Object.fromEntries(keys.map(key => [`${key.replace("context", "geometry")}Ms`, 0])),
    pipelineWaits: { groups, first: 32, end: 96, perImageLogs: false, extraCaptures: 0,
      parallelCountersAreNotExclusive: true, futureGetIncludesHandoff: true, observerNanos: 3,
      mainExclusive: { captureWaitNanos: 200, futureGetNanos: 20, writeNanos: 10, fileFinishNanos: 1, otherNanos: 1 } },
  };
}

test("pipeline accounting conserves exclusive wall time without adding parallel queues", () => {
  const round = fixture(); validatePipelineWaits(round);
  round.pipelineWaits.groups[0].encodeQueueNanos = 1000; // Overlapping cumulative queue time need not fit main wall.
  validatePipelineWaits(round);
});
test("pipeline accounting rejects missing targets, extra captures and SDK phase mismatch", () => {
  const badCount = fixture(); badCount.pipelineWaits.groups[1].uiCalls--; assert.throws(() => validatePipelineWaits(badCount));
  const extra = fixture(); extra.pipelineWaits.extraCaptures = 1; assert.throws(() => validatePipelineWaits(extra));
  const sdk = fixture(); sdk.pipelineWaits.groups[0].sdkUi.drawNanos = 1_000_000; assert.throws(() => validatePipelineWaits(sdk));
});
test("pipeline accounting rejects overlap, invalid counters and tail double counting", () => {
  const overlap = fixture(); overlap.pipelineWaits.mainExclusive.otherNanos++; assert.throws(() => validatePipelineWaits(overlap));
  const invalid = fixture(); invalid.pipelineWaits.groups[0].encodeQueueNanos = NaN; assert.throws(() => validatePipelineWaits(invalid));
  const tail = fixture(); tail.pipelineWaits.groups[0].tailFutureGetNanos = 11; assert.throws(() => validatePipelineWaits(tail));
});
test("pipeline accounting rejects UI time outside its enclosing wait and missing fields", () => {
  const ui = fixture(); ui.pipelineWaits.groups[0].uiTaskNanos = 100; assert.throws(() => validatePipelineWaits(ui));
  const missing: any = fixture(); delete missing.pipelineWaits.mainExclusive.fileFinishNanos;
  assert.throws(() => validatePipelineWaits(missing));
});

function snapshotFixture(): any {
  return { productionSdkChanged: false, rounds: [0, 1].map(index => ({ ...fixture(),
    uiBatchGeometry: "sdk-immutable", uiBatchSize: 1, uiPosts: 407, formatMode: "platform", cacheWorkers: [],
    encodedBytesVerified: true, outputRootVerified: true, outputBufferBytes: 65536,
    processInstance: "test-instance", rootRef: "DecorView@1",
    boundaryBefore: { pid: 123, uptimeMs: index ? 41000 : 1100, processStartUptimeMs: 1000 },
    boundaryAfterPipeline: { pid: 123, uptimeMs: index ? 41010 : 1110, processStartUptimeMs: 1000 },
    boundaryAfterValidation: { pid: 123, uptimeMs: index ? 41020 : 1120, processStartUptimeMs: 1000 },
    pipelineWaits: { ...fixture().pipelineWaits, mainScheduler: {
      scope: "fixed64-ui-capture-including-boundary-reads", tid: 123, calls: 64, unavailableCalls: 0,
      wallNanos: 100, runtimeNanos: 20, runnableWaitNanos: 5, unaccountedNanos: 75,
      timeSlices: 10, readNanos: 2, notGpuTime: true, notExactSnapshotInvoke: true } },
  })) };
}
test("snapshot wait diagnosis preserves unknown scheduler data and does not label off-CPU as GPU", () => {
  const report = snapshotFixture(); const summary = validateSnapshotWaits(report);
  assert.equal(summary[0].offCpuDoesNotProveGpuWait, true);
  const sched = report.rounds[0].pipelineWaits.mainScheduler;
  Object.assign(sched, { calls: 0, unavailableCalls: 64, wallNanos: 0, runtimeNanos: 0,
    runnableWaitNanos: 0, unaccountedNanos: 0, timeSlices: 0 });
  validateSnapshotWaits(report);
});
test("snapshot wait diagnosis rejects false scheduler attribution, identity and counts", () => {
  for (const mutate of [
    (r: any) => r.rounds[0].pipelineWaits.mainScheduler.notGpuTime = false,
    (r: any) => r.rounds[0].pipelineWaits.mainScheduler.calls--,
    (r: any) => r.rounds[0].pipelineWaits.mainScheduler.runtimeNanos++,
    (r: any) => r.rounds[0].pipelineWaits.mainScheduler.tid++,
    (r: any) => r.rounds[1].processInstance = "replaced",
    (r: any) => r.rounds[1].boundaryBefore.uptimeMs = 39999,
    (r: any) => r.rounds[0].pipelineWaits.groups[0].sdkUi.drawCpuNanos = 1,
    (r: any) => r.rounds[0].pipelineWaits.groups[0].sdkUi.snapshotInvokeNanos = 1,
  ]) { const report = snapshotFixture(); mutate(report); assert.throws(() => validateSnapshotWaits(report)); }
});
