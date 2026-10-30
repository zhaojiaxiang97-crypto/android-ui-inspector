import assert from "node:assert/strict";
import { test } from "node:test";
import { outputFirstCases, validateBufferedOutput } from "../scripts/buffered-output-validation";

function fixture(kind = "buffered-output-comparison", reversed = false): any {
  const safety = kind === "buffered-output-safety";
  return { reversed, rounds: Array.from({ length: safety ? 4 : 6 }, (_, index) => {
    const buffered = safety || (index % 2 === 1) !== reversed;
    return { bufferedOutput: buffered, outputBufferBytes: buffered ? 65536 : 0,
      outputDescriptorClosed: true, encodedBytesVerified: true, outputInitFlushCloseIncluded: true,
      outputCloseNanos: 1, wallNanos: 100, images: 407, geometryRecords: 405,
      uiPosts: 407, uiBatchSize: 1, uiDispatch: "normal",
      boundaryBefore: { uptimeMs: index < 3 ? 1000 : 41000, processStartUptimeMs: 100 },
      boundaryAfterPipeline: { uptimeMs: index < 3 ? 2000 : 42000, processStartUptimeMs: 100 },
      ...(kind === "buffered-output-diagnostic" ? { outputTimings: { records: 407, recordWriteNanos: 10, geometryAppendNanos: 3 } } : {}) };
  }), ...(safety ? { outputFaults: ["write", "flush", "close"].map(phase => ({ phase, rejected: true, descriptorClosed: true, partialFilesRemoved: true })) } : {}) };
}
test("buffered output enforces bounded memory, reversed order and closed descriptors", () => {
  validateBufferedOutput(fixture(), "buffered-output-comparison");
  validateBufferedOutput(fixture("buffered-output-comparison", true), "buffered-output-comparison");
  const bad = fixture(); bad.rounds[1].outputBufferBytes *= 2; assert.throws(() => validateBufferedOutput(bad, "buffered-output-comparison"));
  const open = fixture(); open.rounds[0].outputDescriptorClosed = false; assert.throws(() => validateBufferedOutput(open, "buffered-output-comparison"));
});
test("performance runs reject diagnostic counters, late early rounds and invalid time", () => {
  for (const change of [(r: any) => r.rounds[0].outputTimings = {}, (r: any) => r.rounds[2].boundaryAfterPipeline.uptimeMs = 31000,
    (r: any) => r.rounds[0].outputCloseNanos = Infinity]) {
    const bad = fixture(); change(bad); assert.throws(() => validateBufferedOutput(bad, "buffered-output-comparison"));
  }
});
test("diagnostic runs account for all records and separate write from geometry", () => {
  validateBufferedOutput(fixture("buffered-output-diagnostic"), "buffered-output-diagnostic");
  const bad = fixture("buffered-output-diagnostic"); bad.rounds[0].outputTimings.records--; assert.throws(() => validateBufferedOutput(bad, "buffered-output-diagnostic"));
});
test("I/O fault validation requires all failures cleaned and four complete recovery rounds", () => {
  validateBufferedOutput(fixture("buffered-output-safety"), "buffered-output-safety");
  const bad = fixture("buffered-output-safety"); bad.outputFaults[1].partialFilesRemoved = false;
  assert.throws(() => validateBufferedOutput(bad, "buffered-output-safety"));
});
function firstFixture(buffered: boolean, idle: number): any {
  const row = fixture().rounds[0];
  return { reversed: false, firstCaptureBenchmark: true, requestedIdleMillis: idle, rounds: [{ ...row,
    bufferedOutput: buffered, outputBufferBytes: buffered ? 65536 : 0,
    outputSha256: "a".repeat(64), outputPublished: true, outputPendingRemoved: true, outputRootVerified: true,
    boundaryBefore: { uptimeMs: idle + 1000, processStartUptimeMs: 100 },
    boundaryAfterPipeline: { uptimeMs: idle + 2000, processStartUptimeMs: 100 } }] };
}
test("fresh first captures require matching output path, publication and digest", () => {
  for (const buffered of [false, true]) for (const idle of [0, 40000]) {
    const kind = outputFirstCases[Number(buffered)];
    validateBufferedOutput(firstFixture(buffered, idle), kind);
    for (const key of ["outputPublished", "outputPendingRemoved", "outputRootVerified"]) {
      const bad = firstFixture(buffered, idle); bad.rounds[0][key] = false;
      assert.throws(() => validateBufferedOutput(bad, kind));
    }
  }
});
test("first capture rejects warmup, malformed digest and wrong age", () => {
  for (const change of [(r: any) => r.firstCaptureBenchmark = false,
    (r: any) => r.rounds[0].outputSha256 = "bad", (r: any) => r.rounds[0].boundaryBefore.uptimeMs = 1000]) {
    const bad = firstFixture(true, 40000); change(bad);
    assert.throws(() => validateBufferedOutput(bad, outputFirstCases[1]));
  }
});
test("digest publication safety requires real rename failure and five recoveries", () => {
  const report = fixture("buffered-output-safety");
  report.rounds.push(structuredClone(report.rounds[0]));
  for (const row of report.rounds) Object.assign(row, {
    outputSha256: "b".repeat(64), outputDigestVerified: true, outputPublished: true,
    outputPendingRemoved: true, outputRootVerified: true });
  report.outputFaults.push({ phase: "publish", rejected: true, descriptorClosed: true, partialFilesRemoved: true });
  validateBufferedOutput(report, "buffered-output-chain-safety");
  const bad = structuredClone(report); bad.rounds[0].outputDigestVerified = false;
  assert.throws(() => validateBufferedOutput(bad, "buffered-output-chain-safety"));
  const missing = structuredClone(report); missing.outputFaults.pop();
  assert.throws(() => validateBufferedOutput(missing, "buffered-output-chain-safety"));
});
