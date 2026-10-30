import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateFormatCachePipeline } from "../scripts/format-cache-pipeline-validation";

function fixture() {
  const modes = ["platform", "uncached", "cached", "cached", "uncached", "platform"];
  return { productionSdkChanged: false, reversed: false, rounds: modes.map((formatMode, index) => {
    const uptimeMs = 1000 + (index < 3 ? index * 5000 + 100 : 40000 + (index - 3) * 5000);
    const boundary = { pid: 123, processStartUptimeMs: 1000, uptimeMs };
    return { formatMode, processInstance: "test-instance", rootRef: "DecorView@1", uiBatchGeometry: "sdk-immutable", requestLocalCache: true, encodedBytesVerified: true,
      outputRootVerified: true, timedGeometryDigest: true, outputBufferBytes: 65536,
      cacheMaxEntries: 1024, cacheMaxBytes: 262144, wallNanos: 1e9,
      cacheWorkers: formatMode === "platform" ? [] : Array.from({ length: 2 }, () => ({
        entries: formatMode === "cached" ? 100 : 0, retainedBytes: formatMode === "cached" ? 10000 : 0,
        hits: formatMode === "cached" ? 1000 : 0, misses: 100 })),
      boundaryBefore: { ...boundary }, boundaryAfterPipeline: { ...boundary, uptimeMs: uptimeMs + 1000 },
      boundaryAfterValidation: { ...boundary, uptimeMs: uptimeMs + 2000 } };
  }) };
}
describe("full pipeline format-cache evidence", () => {
  it("accepts bounded immutable six-round evidence", () => assert.doesNotThrow(() => validateFormatCachePipeline(fixture())));
  it("rejects wrong output, cache ownership, bounds, health and identity", () => {
    const mutations = [
      (r: any) => r.rounds[2].cacheWorkers[0].entries = 1025,
      (r: any) => r.rounds[2].cacheWorkers[0].retainedBytes = 262145,
      (r: any) => r.rounds[1].cacheWorkers[0].hits = 1,
      (r: any) => r.rounds[2].requestLocalCache = false,
      (r: any) => r.rounds[2].uiBatchGeometry = "unchanged",
      (r: any) => r.rounds[2].encodedBytesVerified = false,
      (r: any) => r.rounds[2].wallNanos = 15e9 + 1,
      (r: any) => r.rounds[2].boundaryAfterPipeline.pid++,
      (r: any) => r.rounds[2].processInstance = "replaced",
      (r: any) => r.rounds[2].rootRef = "DecorView@2",
      (r: any) => r.rounds[3].boundaryBefore.uptimeMs = 39999,
      (r: any) => r.rounds.reverse(),
    ];
    for (const mutate of mutations) { const r = fixture(); mutate(r); assert.throws(() => validateFormatCachePipeline(r)); }
  });
});
