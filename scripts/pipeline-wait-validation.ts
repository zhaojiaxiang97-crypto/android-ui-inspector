import assert from "node:assert/strict";

const sdkKeys = ["context", "contextCpu", "draw", "drawCpu", "verify", "verifyCpu", "snapshotPrepare", "snapshotInvoke"];
const groupKeys = ["captureWaitNanos", "uiQueueNanos", "uiTaskNanos", "encodeQueueNanos", "encodeWallNanos", "encodeCpuNanos",
  "jsonWallNanos", "jsonCpuNanos", "hashWallNanos", "futureGetNanos", "tailFutureGetNanos", "writeNanos"];
const bounded = (value: unknown) => assert.ok(Number.isSafeInteger(value) && (value as number) >= 0, "Invalid pipeline duration");

/** Verify accounting only; never turn parallel phase totals into end-to-end latency. */
export function validatePipelineWaits(round: any) {
  const probe = round.pipelineWaits;
  assert.ok(probe && Array.isArray(probe.groups));
  assert.equal(probe.first, 32); assert.equal(probe.end, 96);
  assert.equal(probe.perImageLogs, false); assert.equal(probe.extraCaptures, 0);
  assert.equal(probe.parallelCountersAreNotExclusive, true); assert.equal(probe.futureGetIncludesHandoff, true);
  bounded(probe.observerNanos);
  assert.deepEqual(probe.groups.map((row: any) => row.group), ["fixed64", "remaining343"]);
  for (const [index, group] of probe.groups.entries()) {
    for (const key of ["uiCalls", "encodeCalls", "drains"]) assert.equal(group[key], index === 0 ? 64 : 343);
    assert.equal(group.jsonCalls, index === 0 ? 64 : 341);
    for (const key of groupKeys) bounded(group[key]);
    for (const key of sdkKeys) bounded(group.sdkUi[`${key}Nanos`]);
    for (const phase of ["context", "draw", "verify"])
      assert.ok(group.sdkUi[`${phase}CpuNanos`] <= group.sdkUi[`${phase}Nanos`]);
    assert.ok(group.sdkUi.snapshotPrepareNanos + group.sdkUi.snapshotInvokeNanos <= group.sdkUi.drawNanos);
    assert.ok(group.tailFutureGetNanos <= group.futureGetNanos);
    assert.ok(group.uiQueueNanos + group.uiTaskNanos <= group.captureWaitNanos);
    for (const key of ["encode", "json"]) assert.ok(group[`${key}CpuNanos`] <= group[`${key}WallNanos`]);
  }
  const sum = (key: string) => probe.groups.reduce((total: number, group: any) => total + group[key], 0);
  assert.equal(sum("uiQueueNanos"), round.uiQueueNanos); assert.equal(sum("uiTaskNanos"), round.uiTaskNanos);
  for (const key of ["encodeWallNanos", "encodeCpuNanos", "jsonWallNanos", "jsonCpuNanos"])
    assert.ok(sum(key) <= round[key], `Grouped ${key} exceeds whole-phase timing`);
  assert.ok(sum("hashWallNanos") <= round.geometryCheckWallNanos);
  for (const key of sdkKeys) {
    const total = probe.groups.reduce((value: number, group: any) => value + group.sdkUi[`${key}Nanos`], 0);
    const sdkKey = key.startsWith("context") ? key.replace("context", "geometry") : key;
    assert.equal(Math.floor(total / 1_000_000), round.sdkPhases[`${sdkKey}Ms`], `SDK ${key} accounting differs`);
  }
  const exclusive = probe.mainExclusive;
  assert.deepEqual(Object.keys(exclusive).sort(), ["captureWaitNanos", "futureGetNanos", "writeNanos", "fileFinishNanos", "otherNanos"].sort());
  for (const value of Object.values(exclusive)) bounded(value);
  for (const key of ["captureWaitNanos", "futureGetNanos", "writeNanos"]) assert.equal(exclusive[key], sum(key));
  assert.equal(Object.values(exclusive).reduce((total: number, value: any) => total + value, 0), round.wallNanos);
}

/** Off-CPU is not a GPU timer. schedstat intervals include the two boundary reads. */
export function validateSnapshotWaits(report: any) {
  assert.equal(report.productionSdkChanged, false);
  assert.equal(report.rounds.length, 2);
  const summary = [];
  let previous: any;
  for (const [index, round] of report.rounds.entries()) {
    validatePipelineWaits(round);
    assert.equal(round.uiBatchGeometry, "sdk-immutable"); assert.equal(round.uiBatchSize, 1);
    assert.equal(round.uiPosts, 407); assert.equal(round.formatMode, "platform");
    assert.equal(round.cacheWorkers.length, 0); assert.equal(round.encodedBytesVerified, true);
    assert.equal(round.outputRootVerified, true); assert.equal(round.outputBufferBytes, 65536);
    assert.ok(round.wallNanos > 0 && round.wallNanos <= 15e9);
    assert.equal(typeof round.processInstance, "string"); assert.ok(round.processInstance.length > 0);
    assert.equal(typeof round.rootRef, "string"); assert.ok(round.rootRef.length > 0);
    assert.equal(round.processInstance, report.rounds[0].processInstance);
    assert.equal(round.rootRef, report.rounds[0].rootRef);
    for (const boundary of [round.boundaryBefore, round.boundaryAfterPipeline, round.boundaryAfterValidation]) {
      bounded(boundary.uptimeMs); bounded(boundary.processStartUptimeMs);
      assert.ok(Number.isSafeInteger(boundary.pid) && boundary.pid > 0);
      assert.ok(boundary.uptimeMs >= boundary.processStartUptimeMs);
      if (previous) {
        assert.equal(boundary.pid, previous.pid); assert.equal(boundary.processStartUptimeMs, previous.processStartUptimeMs);
        assert.ok(boundary.uptimeMs >= previous.uptimeMs);
      }
      previous = boundary;
    }
    const age = (b: any) => b.uptimeMs - b.processStartUptimeMs;
    if (!index) assert.ok(age(round.boundaryAfterPipeline) < 30000);
    else assert.ok(age(round.boundaryBefore) >= 40000);
    const sched = round.pipelineWaits.mainScheduler;
    assert.equal(sched.scope, "fixed64-ui-capture-including-boundary-reads");
    assert.equal(sched.tid, round.boundaryBefore.pid);
    assert.equal(sched.notGpuTime, true); assert.equal(sched.notExactSnapshotInvoke, true);
    for (const key of ["calls", "unavailableCalls", "wallNanos", "runtimeNanos", "runnableWaitNanos", "timeSlices", "unaccountedNanos", "readNanos"])
      bounded(sched[key]);
    assert.equal(sched.calls + sched.unavailableCalls, 64);
    assert.equal(sched.runtimeNanos + sched.runnableWaitNanos + sched.unaccountedNanos, sched.wallNanos);
    assert.ok(sched.readNanos <= round.wallNanos);
    if (sched.calls) assert.ok(sched.runtimeNanos > 0 && sched.wallNanos > 0);
    if (!sched.calls) for (const key of ["wallNanos", "runtimeNanos", "runnableWaitNanos", "timeSlices", "unaccountedNanos"])
      assert.equal(sched[key], 0);
    summary.push({ processAgeMs: age(round.boundaryBefore), wallNanos: round.wallNanos,
      groups: round.pipelineWaits.groups.map((group: any) => ({ group: group.group,
        drawWallNanos: group.sdkUi.drawNanos, drawCpuNanos: group.sdkUi.drawCpuNanos,
        drawOffCpuNanos: group.sdkUi.drawNanos - group.sdkUi.drawCpuNanos,
        snapshotInvokeWallNanos: group.sdkUi.snapshotInvokeNanos, uiQueueNanos: group.uiQueueNanos })),
      scheduler: sched, offCpuDoesNotProveGpuWait: true });
  }
  return summary;
}
