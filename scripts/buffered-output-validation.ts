import assert from "node:assert/strict";

export const outputFirstCases = ["buffered-output-first-original", "buffered-output-first-buffered"];
export const outputCases = ["buffered-output-comparison", "buffered-output-diagnostic", "buffered-output-safety", ...outputFirstCases, "buffered-output-chain-safety"];
const duration = (value: unknown) => assert.ok(Number.isSafeInteger(value) && (value as number) >= 0);

export function validateBufferedOutput(report: any, pipelineCase: string) {
  assert.ok(outputCases.includes(pipelineCase));
  assert.equal(typeof report.reversed, "boolean");
  const chainSafety = pipelineCase === "buffered-output-chain-safety";
  const safety = pipelineCase === "buffered-output-safety" || chainSafety;
  const first = outputFirstCases.includes(pipelineCase);
  assert.equal(report.rounds.length, first ? 1 : chainSafety ? 5 : safety ? 4 : 6);
  for (const [index, round] of report.rounds.entries()) {
    const buffered = first ? pipelineCase.endsWith("buffered") : safety || (index % 2 === 1) !== report.reversed;
    assert.equal(round.bufferedOutput, buffered);
    assert.equal(round.outputBufferBytes, buffered ? 65536 : 0);
    assert.equal(round.outputDescriptorClosed, true); assert.equal(round.encodedBytesVerified, true);
    assert.equal(round.outputInitFlushCloseIncluded, true);
    duration(round.wallNanos); duration(round.outputCloseNanos);
    assert.ok(round.outputCloseNanos > 0 && round.outputCloseNanos < round.wallNanos);
    assert.equal(round.pipelineWaits, undefined);
    assert.equal(round.images, 407); assert.equal(round.geometryRecords, 405);
    assert.equal(round.uiPosts, 407); assert.equal(round.uiBatchSize, 1); assert.equal(round.uiDispatch, "normal");
    if (chainSafety) {
      assert.match(round.outputSha256, /^[a-f0-9]{64}$/);
      for (const key of ["outputPublished", "outputPendingRemoved", "outputRootVerified", "outputDigestVerified"]) assert.equal(round[key], true);
    }
    if (pipelineCase === "buffered-output-diagnostic") {
      assert.equal(round.outputTimings.records, 407);
      for (const key of ["recordWriteNanos", "geometryAppendNanos"]) duration(round.outputTimings[key]);
      assert.ok(round.outputTimings.recordWriteNanos + round.outputTimings.geometryAppendNanos < round.wallNanos);
    } else assert.equal(round.outputTimings, undefined);
    if (!safety) {
      const age = round.boundaryBefore.uptimeMs - round.boundaryBefore.processStartUptimeMs;
      const endAge = round.boundaryAfterPipeline.uptimeMs - round.boundaryAfterPipeline.processStartUptimeMs;
      duration(age); duration(endAge); assert.ok(endAge >= age);
      if (first) {
        assert.equal(report.firstCaptureBenchmark, true);
        assert.ok([0, 40000].includes(report.requestedIdleMillis));
        if (report.requestedIdleMillis === 40000) assert.ok(age >= 40_000); else assert.ok(endAge < 30_000);
        assert.match(round.outputSha256, /^[a-f0-9]{64}$/);
        for (const key of ["outputPublished", "outputPendingRemoved", "outputRootVerified"]) assert.equal(round[key], true);
      } else if (index < 3) assert.ok(endAge < 30_000); else assert.ok(age >= 40_000);
    }
  }
  if (safety) {
    assert.deepEqual(report.outputFaults.map((row: any) => row.phase), chainSafety ? ["write", "flush", "close", "publish"] : ["write", "flush", "close"]);
    assert.ok(report.outputFaults.every((row: any) => row.rejected === true && row.descriptorClosed === true && row.partialFilesRemoved === true));
  } else assert.equal(report.outputFaults, undefined);
}
