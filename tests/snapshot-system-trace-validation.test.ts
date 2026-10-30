import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSystemTraceEvidence } from "../scripts/snapshot-system-trace-validation";

function fixture(): any {
  return { round: { traceMarkers: true, traceCaptureCount: 407, schedulerFileReads: 0, extraCaptures: 0,
    uiBatchGeometry: "sdk-immutable", encodedBytesVerified: true, pixelsVerified: true,
    images: 407, geometryRecords: 405, wallNanos: 1000000, boundaryBefore: { pid: 123 } },
    evidence: { pipelines: [{ pid: 123, tid: 124, ts: 1000, dur: 999000, processName: "com.androiduiinspector.sample" }],
      captures: { count: 407, tidMin: 123, tidMax: 123, totalNanos: 900000, firstTs: 2000, lastTs: 999000 },
      overlappingCapturePairs: 0, states: [{ state: "Running", nanos: 300000 }, { state: "S", nanos: 600000 }], errors: [] } };
}
test("trace validation preserves parser errors and does not invent GPU or blocking-call evidence", () => {
  const { evidence, round } = fixture();
  assert.equal(validateSystemTraceEvidence(evidence, round).traceHealthPassed, true);
  evidence.errors.push({ name: "systrace_parse_failure", severity: "error", value: 1260 });
  const result = validateSystemTraceEvidence(evidence, round);
  assert.equal(result.traceHealthPassed, false); assert.equal(result.exactBlockingCall, "unknown");
  assert.equal(result.gpuDurationNanos, null); assert.equal(result.errors.length, 1);
});
test("trace validation rejects missing, overlapping, unbound and truncated intervals", () => {
  for (const mutate of [
    (f: any) => f.evidence.captures.count--,
    (f: any) => f.evidence.pipelines[0].pid++,
    (f: any) => f.evidence.pipelines.push(f.evidence.pipelines[0]),
    (f: any) => f.evidence.overlappingCapturePairs++,
    (f: any) => f.evidence.states[0].nanos--,
    (f: any) => f.evidence.states.push(f.evidence.states[0]),
    (f: any) => f.evidence.captures.lastTs = 1e9,
    (f: any) => f.round.schedulerFileReads++,
  ]) { const f = fixture(); mutate(f); assert.throws(() => validateSystemTraceEvidence(f.evidence, f.round)); }
});
