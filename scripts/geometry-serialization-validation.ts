import assert from "node:assert/strict";

/** Original-only immutable microprofile; never a full-capture speed admission. */
export function validateGeometrySplit(report: any, cache = false) {
  assert.equal(report.passed, true, report.error);
  assert.equal(report.splitOnly, true);
  assert.equal(report.candidate, cache);
  assert.equal(report.formatCache === true, cache);
  if (cache) {
    assert.equal(report.cacheSelfTestPassed, true);
    assert.equal(report.maxEntriesPerWorker, 1024); assert.equal(report.maxBytesPerWorker, 262144);
  }
  assert.equal(report.capturedOnce, true);
  assert.equal(report.workers, 2); assert.equal(report.queueDepth, 4);
  assert.equal(report.byteEqualityPassed, true);
  const bounded = (v: unknown, maximum = 120_000_000_000) => assert.ok(Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= maximum);
  bounded(report.records, 1200); assert.ok(report.records >= 400);
  bounded(report.captureNanos, 60_000_000_000);
  assert.equal(report.rounds?.length, cache ? 6 : 2);
  if (!cache) assert.equal(report.scalarProfiles?.length, 2);
  for (const [index, round] of report.rounds.entries()) {
    assert.equal(round.round, index);
    if (cache) {
      const mode = ["platform", "uncached", "cached", "cached", "uncached", "platform"][index];
      assert.equal(round.mode, mode);
      assert.ok(Array.isArray(round.cacheWorkers));
      assert.equal(round.cacheWorkers.length, mode === "platform" ? 0 : 2);
      for (const worker of round.cacheWorkers) {
        bounded(worker.entries, 1024); bounded(worker.retainedBytes, 262144);
        bounded(worker.hits, 10_000_000); bounded(worker.misses, 10_000_000);
        if (mode === "uncached") { assert.equal(worker.entries, 0); assert.equal(worker.retainedBytes, 0); assert.equal(worker.hits, 0); }
      }
      if (mode === "cached") assert.ok(round.cacheWorkers.reduce((n: number, w: any) => n + w.hits, 0) > 0);
    }
    for (const key of ["wallNanos", "buildNanos", "stringifyNanos"]) bounded(round[key]);
    for (const key of ["buildCpuNanos", "stringifyCpuNanos"]) if (round[key] !== undefined) bounded(round[key]);
    bounded(round.recordBytes, 4_000_000); assert.ok(round.recordBytes > 0);
    assert.match(round.sha256, /^[a-f0-9]{64}$/);
    assert.equal(round.sha256, report.rounds[0].sha256);
    assert.equal(round.recordBytes, report.rounds[0].recordBytes);
    for (const kind of cache ? [] : ["numbers", "strings"]) {
      const scalar = report.scalarProfiles[index][kind];
      bounded(scalar.count, 1_000_000); assert.ok(scalar.count > 0);
      bounded(scalar.characters, 8_000_000);
      bounded(scalar.wallNanos);
      if (scalar.cpuNanos !== undefined) bounded(scalar.cpuNanos);
      assert.equal(scalar.count, report.scalarProfiles[0][kind].count);
      assert.equal(scalar.characters, report.scalarProfiles[0][kind].characters);
    }
  }
}
