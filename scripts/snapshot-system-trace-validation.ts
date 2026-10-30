import assert from "node:assert/strict";

const nonnegative = (value: unknown) => assert.ok(Number.isSafeInteger(value) && (value as number) >= 0);

/** Marker/state coverage does not prove error-free GPU tracing or an exact blocking call. */
export function validateSystemTraceEvidence(evidence: any, round: any) {
  assert.equal(round.traceMarkers, true); assert.equal(round.traceCaptureCount, 407);
  assert.equal(round.schedulerFileReads, 0); assert.equal(round.extraCaptures, 0);
  assert.equal(round.uiBatchGeometry, "sdk-immutable"); assert.equal(round.encodedBytesVerified, true);
  assert.equal(round.pixelsVerified, true); assert.equal(round.images, 407); assert.equal(round.geometryRecords, 405);
  assert.ok(round.wallNanos > 0 && round.wallNanos <= 15e9);
  assert.equal(evidence.pipelines.length, 1);
  const pipeline = evidence.pipelines[0], captures = evidence.captures;
  assert.equal(pipeline.pid, round.boundaryBefore.pid);
  assert.equal(pipeline.processName, "com.androiduiinspector.sample");
  for (const key of ["pid", "tid", "ts", "dur"]) nonnegative(pipeline[key]);
  assert.ok(pipeline.dur > 0 && pipeline.dur <= round.wallNanos && round.wallNanos - pipeline.dur < 1e7);
  assert.equal(captures.count, 407); assert.equal(evidence.overlappingCapturePairs, 0);
  assert.equal(captures.tidMin, pipeline.pid); assert.equal(captures.tidMax, pipeline.pid);
  for (const key of ["totalNanos", "firstTs", "lastTs"]) nonnegative(captures[key]);
  assert.ok(captures.totalNanos > 0 && captures.totalNanos <= pipeline.dur);
  assert.ok(captures.firstTs >= pipeline.ts && captures.lastTs <= pipeline.ts + pipeline.dur);
  assert.ok(Array.isArray(evidence.states) && evidence.states.length > 0);
  const states = new Set<string>(); let accounted = 0;
  for (const state of evidence.states) {
    assert.equal(typeof state.state, "string"); assert.ok(state.state.length > 0 && !states.has(state.state));
    states.add(state.state); nonnegative(state.nanos); accounted += state.nanos;
  }
  assert.equal(accounted, captures.totalNanos, "Scheduler coverage is incomplete or double-counted");
  assert.ok(Array.isArray(evidence.errors));
  for (const error of evidence.errors) {
    assert.equal(typeof error.name, "string"); assert.ok(error.name.length > 0);
    assert.ok(["error", "data_loss"].includes(error.severity)); nonnegative(error.value); assert.ok(error.value > 0);
  }
  return { markerCoveragePassed: true, captureStateCoveragePassed: true,
    traceHealthPassed: evidence.errors.length === 0, errors: evidence.errors,
    exactBlockingCall: "unknown", gpuDurationNanos: null, nestedSlicesAreNotExclusive: true };
}
