import assert from "node:assert/strict";

// Retained text/key accounting, not a process RSS guarantee.
export function validateFormatCachePipeline(report: any) {
  assert.equal(report.productionSdkChanged, false);
  assert.equal(typeof report.reversed, "boolean");
  const order = report.reversed ? ["cached", "uncached", "platform", "platform", "uncached", "cached"]
    : ["platform", "uncached", "cached", "cached", "uncached", "platform"];
  assert.deepEqual(report.rounds.map((row: any) => row.formatMode), order);
  let previous: any;
  for (const [index, row] of report.rounds.entries()) {
    assert.equal(typeof row.processInstance, "string"); assert.ok(row.processInstance.length > 0);
    assert.equal(typeof row.rootRef, "string"); assert.ok(row.rootRef.length > 0);
    assert.equal(row.processInstance, report.rounds[0].processInstance);
    assert.equal(row.rootRef, report.rounds[0].rootRef);
    assert.equal(row.uiBatchGeometry, "sdk-immutable");
    for (const flag of ["requestLocalCache", "encodedBytesVerified", "outputRootVerified", "timedGeometryDigest"])
      assert.equal(row[flag], true);
    assert.equal(row.outputBufferBytes, 65536);
    assert.equal(row.cacheMaxEntries, 1024); assert.equal(row.cacheMaxBytes, 262144);
    assert.ok(Number.isSafeInteger(row.wallNanos) && row.wallNanos > 0 && row.wallNanos <= 15e9);
    assert.equal(row.cacheWorkers.length, row.formatMode === "platform" ? 0 : 2);
    for (const cache of row.cacheWorkers) {
      for (const key of ["entries", "retainedBytes", "hits", "misses"])
        assert.ok(Number.isSafeInteger(cache[key]) && cache[key] >= 0);
      assert.ok(cache.entries <= 1024 && cache.retainedBytes <= 262144 && cache.misses > 0);
      if (row.formatMode === "uncached") {
        assert.equal(cache.entries, 0); assert.equal(cache.retainedBytes, 0); assert.equal(cache.hits, 0);
      }
    }
    for (const boundary of [row.boundaryBefore, row.boundaryAfterPipeline, row.boundaryAfterValidation]) {
      assert.ok(Number.isSafeInteger(boundary.pid) && boundary.pid > 0);
      assert.ok(Number.isSafeInteger(boundary.processStartUptimeMs) && boundary.processStartUptimeMs >= 0);
      assert.ok(Number.isSafeInteger(boundary.uptimeMs) && boundary.uptimeMs >= boundary.processStartUptimeMs);
      if (previous) {
        assert.equal(boundary.pid, previous.pid);
        assert.equal(boundary.processStartUptimeMs, previous.processStartUptimeMs);
        assert.ok(boundary.uptimeMs >= previous.uptimeMs);
      }
      previous = boundary;
    }
    const age = (boundary: any) => boundary.uptimeMs - boundary.processStartUptimeMs;
    if (index < 3) assert.ok(age(row.boundaryAfterPipeline) < 30000);
    else assert.ok(age(row.boundaryBefore) >= 40000);
  }
}
