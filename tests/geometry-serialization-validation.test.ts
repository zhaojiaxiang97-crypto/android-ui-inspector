import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGeometrySplit } from "../scripts/geometry-serialization-validation";
function fixture() {
  const scalar = { count: 100, characters: 200, wallNanos: 1000, cpuNanos: 800 };
  return { passed: true, splitOnly: true, candidate: false, capturedOnce: true, workers: 2, queueDepth: 4,
    byteEqualityPassed: true, records: 405, captureNanos: 1e9,
    rounds: [0, 1].map(round => ({ round, wallNanos: 1000, buildNanos: 600, stringifyNanos: 900,
      buildCpuNanos: 500, stringifyCpuNanos: 800, recordBytes: 10000, sha256: "a".repeat(64) })),
    scalarProfiles: [0, 1].map(() => ({ numbers: { ...scalar }, strings: { ...scalar } })) };
}
test("split validates fixed original input without summing parallel timings", () => {
  const r = fixture(); validateGeometrySplit(r);
  r.rounds[0].stringifyNanos = 2000; validateGeometrySplit(r);
});
test("split rejects failed, incomplete, mismatched or candidate results", () => {
  for (const mutate of [
    (r: ReturnType<typeof fixture>) => { r.passed = false; },
    (r: ReturnType<typeof fixture>) => { r.candidate = true; },
    (r: ReturnType<typeof fixture>) => { r.rounds.pop(); },
    (r: ReturnType<typeof fixture>) => { r.rounds[1].sha256 = "b".repeat(64); },
    (r: ReturnType<typeof fixture>) => { r.rounds[1].recordBytes++; },
    (r: ReturnType<typeof fixture>) => { r.scalarProfiles[1].numbers.count++; },
    (r: ReturnType<typeof fixture>) => { r.rounds[0].buildNanos = NaN; },
  ]) { const r = fixture(); mutate(r); assert.throws(() => validateGeometrySplit(r)); }
});

test("cache comparison verifies reversed controls, output equality and per-worker budgets", () => {
  const r: any = fixture();
  Object.assign(r, { candidate: true, formatCache: true, cacheSelfTestPassed: true, maxEntriesPerWorker: 1024, maxBytesPerWorker: 262144 });
  r.rounds = ["platform", "uncached", "cached", "cached", "uncached", "platform"].map((mode, round) => ({
    ...fixture().rounds[0], mode, round, cacheWorkers: mode === "platform" ? [] : [0, 1].map(() => ({
      entries: mode === "cached" ? 100 : 0, retainedBytes: mode === "cached" ? 10000 : 0,
      hits: mode === "cached" ? 1000 : 0, misses: 200,
    })),
  }));
  validateGeometrySplit(r, true);
  assert.throws(() => validateGeometrySplit(r));
  for (const mutate of [
    (v: any) => { v.rounds[2].cacheWorkers[0].entries = 1025; },
    (v: any) => { v.rounds[2].cacheWorkers[0].retainedBytes = 262145; },
    (v: any) => { v.rounds[1].cacheWorkers[0].hits = 1; },
    (v: any) => { v.rounds[5].mode = "cached"; },
    (v: any) => { v.cacheSelfTestPassed = false; },
  ]) { const v = structuredClone(r); mutate(v); assert.throws(() => validateGeometrySplit(v, true)); }
});
