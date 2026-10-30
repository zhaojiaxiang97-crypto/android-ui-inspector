// Sample-only profiler; does not capture a business app or save images on the host.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { parseCaptureGeometryFile } from "../../../electron/capture/layer-images";
import { parseCapturedViewLayers } from "../../../electron/capture/view-protocol";

const serial = process.argv[2];
if (!serial || !/^[\w.:-]+$/.test(serial)) throw new Error("Usage: bun scripts/diagnostics/sdk/sdk-snapshot-phases-probe.ts SERIAL");
const pkg = "com.androiduiinspector.sample";
const batch = process.argv.includes("--batch");
const transformed = process.argv.includes("--transformed");
const conservative = process.argv.includes("--conservative");
const fullPipeline = process.argv.includes("--pipeline");
const optimized = process.argv.includes("--optimized");
const hashComparison = process.argv.includes("--hash-comparison");
const chunkedHash = process.argv.includes("--chunked-hash");
const strategyComparison = process.argv.find(value => value.startsWith("--strategy-comparison="))?.split("=")[1];
const cadenceComparison = process.argv.find(value => value.startsWith("--cadence-comparison="))?.split("=")[1];
if (cadenceComparison !== undefined && (!fullPipeline || !chunkedHash || optimized || hashComparison || strategyComparison
    || !["batch2", "yield1"].includes(cadenceComparison)))
  throw new Error("Cadence comparison requires --pipeline --chunked-hash and batch2 or yield1; other comparison modes must stay off");
if (strategyComparison !== undefined && (!fullPipeline || !chunkedHash || optimized || hashComparison || !["fill", "transfer"].includes(strategyComparison)))
  throw new Error("Strategy comparison requires --pipeline --chunked-hash and fill or transfer; do not combine with --optimized/--hash-comparison");
if ((hashComparison || chunkedHash) && !fullPipeline) throw new Error("Hash experiments require --pipeline");
if (hashComparison && (optimized || chunkedHash)) throw new Error("Hash-only comparison must keep rendering and ownership unchanged");
if (optimized && !fullPipeline) throw new Error("Optimized ownership requires --pipeline");
const cancel = process.argv.includes("--cancel");
if (cancel && !fullPipeline) throw new Error("Cancellation requires --pipeline");
if (fullPipeline && (!conservative || !batch)) throw new Error("Pipeline comparison requires conservative batch mode");
if (conservative && !batch) throw new Error("Conservative routing requires --batch");
const expectPixelDifference = process.argv.includes("--expect-pixel-difference");
if (expectPixelDifference && (!batch || !transformed || conservative)) throw new Error("Known pixel-difference check requires unrestricted transformed batch mode");
const mutation = process.argv.find(value => value.startsWith("--mutation="))?.slice("--mutation=".length);
if (hashComparison && mutation) throw new Error("Hash-only comparison does not execute deferred recording mutations");
if (mutation && (!batch || !["record-alpha", "after-clip", "after-position"].includes(mutation))) throw new Error("Mutation requires --batch and a known sample fault");
const token = randomBytes(8).toString("hex");
type StageTiming = { calls: number; totalMs: number; maxMs: number; tailMs: number;
  slowest: { ref: string; width: number; height: number; layers: number } | null };
type PhaseRound = { instrumented: boolean; batch: boolean; fillBatch: boolean; transferBitmap: boolean;
  cadence: { batchLimit: number; workDelayMs: number; workPosts: number; scheduledWorkDelayMs: number; slice: StageTiming; originalSlice: StageTiming; batchSlice: StageTiming };
  operations: Record<"originalSnapshot" | "originalReadback" | "batchRecord" | "atlasBitmap" | "atlasReadback" | "rawPixelHash", StageTiming>;
  waiting: { capacityMs: number; fillMs: number; drainMs: number; episodes: number; longestMs: number; uiDelayMs: number; maxUiDelayMs: number };
  count: number; originalFallbacks: number; hardwareBitmaps: number; prepareMs: number; canvasMs: number; recordMs: number; bitmapMs: number; invokeMs: number; cpuCopyMs: number; wallMs: number;
  batchSizes: number[]; memory?: { intervalMs: number; samples: number; baselinePssKb: number; peakPssKb: number; peakNativeBytes: number; peakJavaBytes: number };
  pixelHash: { chunked: boolean; calls: number; maxScratchBytes: number; allocatedScratchBytes: number; hashMs: number };
  pipeline?: { encodedCount: number; peakDepth: number; encodeMs: number; geometryBytes: number; decodedChanges: number; imageSha256: string; geometrySha256: string; refs: string[]; ownershipCopies: number; ownershipCopyMs: number; peakOwnedBytes: number; envelopeVerified: boolean;
    stages: Record<"queue" | "encodeCall" | "decode" | "verify" | "geometry", StageTiming> & {
      writeMs: number; tailWriteMs: number; finalizeMs: number; outputHashMs: number; tailPending: number; tailWallMs: number } } };
type PhaseReport = { passed: boolean; probeToken: string; count: number; stableImages: number; rounds: PhaseRound[]; strategyComparison: string; cadenceComparison: string; error?: string; failedRound?: number; mutation?: string; mutationRestored?: boolean; transformedFixture?: boolean; conservative?: boolean; fullPipeline?: boolean; pipelineReleased?: boolean; optimized?: boolean; hashComparison?: boolean; chunkedHash?: boolean; hashSelfTestPassed?: boolean; timingSelfTestPassed?: boolean; envelopeSelfTestPassed?: boolean;
  pixelMismatch?: { referenceStillMatches: boolean; differentPixels: number; renderVariants: { variant: string; differentPixels: number; maxChannelDelta: number }[] } };
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 15_000, maxBuffer: 65_000_000 });
const assertOutputsGone = () => {
  // exec-out can return exit 0 for a failed remote cat; inspect the directory explicitly.
  const names = adb("exec-out", "run-as", pkg, "ls", "files/isolation-probe").toString().trim().split(/\s+/);
  assert(!names.includes("pipeline.bin") && !names.includes("pipeline-geometry.json"), "Failed output must be removed");
};
adb("shell", "am", "start", "-S", "-W", "-n", `${pkg}/.MainActivity`, "--es", "mode", "stress-rectangle", "--ez", batch ? "snapshotBatchProbe" : "snapshotPhaseProbe", "true", "--es", "probeToken", token,
  ...(mutation ? ["--es", "snapshotBatchMutation", mutation] : []),
  ...(transformed ? ["--ez", "snapshotBatchTransforms", "true"] : []),
  ...(conservative ? ["--ez", "snapshotBatchConservative", "true"] : []),
  ...(fullPipeline ? ["--ez", "snapshotFullPipeline", "true"] : []),
  ...(optimized ? ["--ez", "snapshotPipelineOptimized", "true"] : []),
  ...(hashComparison ? ["--ez", "snapshotHashComparison", "true"] : []),
  ...(chunkedHash ? ["--ez", "snapshotChunkedHash", "true"] : []),
  ...(strategyComparison ? ["--es", "snapshotStrategyComparison", strategyComparison] : []),
  ...(cadenceComparison ? ["--es", "snapshotCadenceComparison", cadenceComparison] : []),
  ...(cancel ? ["--ez", "snapshotPipelineCancel", "true"] : []));
const deadline = performance.now() + 160_000;
let report: PhaseReport | undefined;
while (performance.now() < deadline) {
  try {
    const candidate = JSON.parse(adb("exec-out", "run-as", pkg, "cat", `files/isolation-probe/${batch ? "snapshot-batches" : "snapshot-phases"}.json`).toString());
    if (candidate.probeToken === token) { report = candidate; break; }
  } catch { /* A fresh report is not ready yet. */ }
  await wait(1000);
}
assert(report, "No fresh snapshot phase report");
assert.equal(report.transformedFixture, transformed);
assert.equal(report.conservative, conservative);
assert.equal(report.fullPipeline, fullPipeline);
assert.equal(report.optimized, optimized);
assert.equal(report.hashComparison, hashComparison);
assert.equal(report.chunkedHash, chunkedHash);
assert.equal(report.strategyComparison, strategyComparison ?? "none");
assert.equal(report.cadenceComparison, cadenceComparison ?? "none");
assert.equal(report.hashSelfTestPassed, true);
assert.equal(report.timingSelfTestPassed, true);
if (fullPipeline) assert.equal(report.envelopeSelfTestPassed, true);
assert.equal(report.pipelineReleased, true);
if (cancel) {
  assert.equal(report.passed, false); assert.match(report.error ?? "", /Sample pipeline canceled/);
  if (strategyComparison || cadenceComparison) assert.equal(report.failedRound, 1, "Cancellation must exercise the treatment, not its control");
  assertOutputsGone();
  console.log(JSON.stringify({ expectedCancellation: true, ...report, rounds: report.rounds.map(({ pipeline, ...round }) => ({ ...round, pipeline: pipeline && { ...pipeline, refs: undefined } })) }, null, 2));
  process.exit(0);
}
if (expectPixelDifference) {
  assert.equal(report.passed, false);
  assert.match(report.error ?? "", /Measured and original pixels differ/);
  assert.equal(report.pixelMismatch?.referenceStillMatches, true);
  assert(report.pixelMismatch!.differentPixels > 0);
  assert.deepEqual(report.pixelMismatch!.renderVariants.map(value => value.variant), ["same-size-origin", "padded-origin", "shifted-unclipped", "shifted-clipped"]);
  console.log(JSON.stringify({ expectedPixelDifference: true, ...report }, null, 2));
  process.exit(0);
}
if (mutation) {
  assert.equal(report.passed, false);
  assert.equal(report.mutation, mutation);
  assert.equal(report.mutationRestored, true);
  if (strategyComparison || cadenceComparison) assert.equal(report.failedRound, 1, "Mutation must exercise the treatment, not its control");
  if (fullPipeline) assertOutputsGone();
  assert.match(report.error ?? "", mutation === "record-alpha" ? /Recording changed geometry/ : /Geometry changed before batch readback/);
  console.log(JSON.stringify({ expectedRejection: true, ...report, rounds: report.rounds.map(({ pipeline, ...round }) => ({ ...round, pipeline: pipeline && { ...pipeline, refs: undefined } })) }, null, 2));
  process.exit(0);
}
assert.equal(report.passed, true, JSON.stringify(report));
assert(report.count >= 400 && report.count <= 500);
assert.equal(report.stableImages, report.count);
assert.equal(report.rounds.length, 6);
assert.deepEqual(report.rounds.map(round => round.instrumented), [false, true, true, false, false, true]);
const checkStage = (stage: StageTiming, calls: number, refs?: string[]) => {
  assert.equal(stage.calls, calls);
  for (const value of [stage.totalMs, stage.maxMs, stage.tailMs]) assert(Number.isFinite(value) && value >= 0);
  assert(stage.maxMs <= stage.totalMs + 0.000001 && stage.tailMs <= stage.totalMs + 0.000001);
  if (!calls) { assert.equal(stage.slowest, null); assert.equal(stage.totalMs, 0); }
  else {
    assert(stage.slowest && stage.slowest.width > 0 && stage.slowest.height > 0 && stage.slowest.layers > 0);
    assert(stage.slowest.layers <= 8 && stage.slowest.width * stage.slowest.height <= 4_000_000);
    if (refs) assert(refs.includes(stage.slowest.ref));
  }
};
for (const round of report.rounds) {
  assert.equal(round.count, report.count);
  assert.equal(round.batch, batch && (round.instrumented || !!strategyComparison || !!cadenceComparison) && !hashComparison);
  assert.equal(round.fillBatch, !!cadenceComparison || round.instrumented && (optimized || strategyComparison === "fill"));
  assert.equal(round.transferBitmap, !!cadenceComparison || round.instrumented && (optimized || strategyComparison === "transfer"));
  assert.equal(round.cadence.batchLimit, !fullPipeline ? 8 : cadenceComparison === "batch2" && round.instrumented ? 2 : 4);
  assert.equal(round.cadence.workDelayMs, cadenceComparison === "yield1" && round.instrumented ? 1 : 0);
  for (const value of Object.values(round.waiting)) assert(Number.isFinite(value) && value >= 0);
  assert(round.waiting.capacityMs + round.waiting.fillMs + round.waiting.drainMs <= round.wallMs + 2);
  // UI delay overlaps queue waiting; worker encode/hash totals can overlap both. Never add them together.
  assert(round.waiting.maxUiDelayMs <= round.waiting.uiDelayMs);
  const originalCount: number = round.batch ? round.originalFallbacks : report.count;
  const batchCount: number = round.batchSizes.reduce((sum, count) => sum + count, 0);
  const refs = round.pipeline?.refs;
  checkStage(round.operations.originalSnapshot, originalCount, refs);
  checkStage(round.operations.originalReadback, originalCount, refs);
  checkStage(round.operations.batchRecord, round.batch ? report.count - originalCount : 0, refs);
  checkStage(round.operations.atlasBitmap, batchCount, refs);
  checkStage(round.operations.atlasReadback, batchCount, refs);
  checkStage(round.operations.rawPixelHash, report.count, refs);
  checkStage(round.cadence.slice, originalCount + batchCount, refs);
  checkStage(round.cadence.originalSlice, originalCount, refs);
  checkStage(round.cadence.batchSlice, batchCount, refs);
  assert(Math.abs(round.cadence.originalSlice.totalMs + round.cadence.batchSlice.totalMs - round.cadence.slice.totalMs) < 0.000001);
  assert.equal(round.cadence.slice.maxMs, Math.max(round.cadence.originalSlice.maxMs, round.cadence.batchSlice.maxMs));
  assert.equal(round.cadence.workPosts, originalCount + batchCount - 1);
  assert.equal(round.cadence.scheduledWorkDelayMs, round.cadence.workPosts * round.cadence.workDelayMs);
  assert(Math.abs(round.operations.originalReadback.totalMs + round.operations.atlasReadback.totalMs - round.cpuCopyMs) < 0.000001);
  assert(Math.abs(round.operations.originalSnapshot.totalMs + round.operations.batchRecord.totalMs + round.operations.atlasBitmap.totalMs - round.invokeMs) < 0.000001);
  if (fullPipeline) {
    assert.equal(round.pipeline?.encodedCount, report.count);
    assert.equal(round.pipeline!.envelopeVerified, false, "Legacy full-envelope verification belongs only to warmup");
    assert(round.pipeline!.peakDepth > 0 && round.pipeline!.peakDepth <= 4);
    const stages = round.pipeline!.stages;
    for (const key of ["queue", "encodeCall", "decode", "verify", "geometry"] as const) checkStage(stages[key], report.count, refs);
    for (const key of ["writeMs", "tailWriteMs", "finalizeMs", "outputHashMs", "tailWallMs"] as const)
      assert(Number.isFinite(stages[key]) && stages[key] >= 0);
    assert(Number.isInteger(stages.tailPending) && stages.tailPending >= 0 && stages.tailPending <= 4);
    assert(stages.tailWriteMs <= stages.writeMs);
    assert(stages.tailWallMs <= round.wallMs + 2);
    assert(round.pipeline!.geometryBytes > 0 && round.pipeline!.geometryBytes <= 4_000_000);
    assert.equal(new Set(round.pipeline!.refs).size, report.count);
    assert.deepEqual(round.pipeline!.refs, report.rounds[0].pipeline!.refs);
    assert.equal(round.pipeline!.decodedChanges, report.rounds[0].pipeline!.decodedChanges);
    assert.equal(round.pipeline!.imageSha256, report.rounds[0].pipeline!.imageSha256);
    assert.equal(round.pixelHash.calls, report.count * 2);
    assert.equal(round.pixelHash.chunked, chunkedHash || hashComparison && round.instrumented);
    assert(round.pixelHash.hashMs >= 0 && round.pixelHash.allocatedScratchBytes >= round.pixelHash.maxScratchBytes);
    if (round.pixelHash.chunked) assert(round.pixelHash.maxScratchBytes > 0 && round.pixelHash.maxScratchBytes <= 131072);
    else assert(round.pixelHash.maxScratchBytes > 131072, "Full-array control must exercise a large bitmap");
    assert.equal(round.pipeline!.ownershipCopies, round.transferBitmap ? 0 : report.count);
    assert(round.pipeline!.peakOwnedBytes > 0 && round.pipeline!.peakOwnedBytes <= 64_000_000);
    assert.equal(round.memory!.intervalMs, 250);
    assert(round.memory!.samples > 0 && round.memory!.baselinePssKb > 0);
    assert(round.memory!.peakPssKb >= round.memory!.baselinePssKb);
    assert(round.memory!.peakNativeBytes > 0 && round.memory!.peakJavaBytes > 0);
    assert.equal(round.batchSizes.reduce((sum, count, size) => sum + count * size, 0), round.batch ? 400 : 0);
    if (round.fillBatch && round.batch) {
      const size = round.cadence.batchLimit;
      assert.equal(round.batchSizes[size], 400 / size, "Fixture must produce full bounded batches");
      assert.equal(round.hardwareBitmaps, 400 / size + 7);
    }
  }
  if (conservative && round.batch) assert.equal(round.originalFallbacks, 7, "Complex nodes must use the original path before drawing");
  else assert.equal(round.originalFallbacks, 0);
  if (round.batch) assert(round.hardwareBitmaps >= Math.ceil(round.count / 8) && round.hardwareBitmaps < round.count);
  else assert.equal(round.hardwareBitmaps, round.count, "This fixture must exercise hardware bitmap readback");
  for (const key of ["prepareMs", "canvasMs", "recordMs", "bitmapMs", "invokeMs", "cpuCopyMs", "wallMs"] as const)
    assert(Number.isFinite(round[key]) && round[key] >= 0, key);
  if ((round.instrumented || round.batch) && !hashComparison) {
    assert(round.canvasMs + round.recordMs + round.bitmapMs <= round.invokeMs + 0.1);
    assert(round.recordMs > 0 && round.bitmapMs > 0);
  }
}
if (fullPipeline) {
  const images = adb("exec-out", "run-as", pkg, "cat", "files/isolation-probe/pipeline.bin");
  const layers = parseCapturedViewLayers(images);
  assert.equal(images.readBigUInt64BE(0), BigInt(`0x${token}`));
  const geometry = adb("exec-out", "run-as", pkg, "cat", "files/isolation-probe/pipeline-geometry.json");
  const envelope = JSON.parse(geometry.toString());
  assert.equal(envelope.rootRef, report.rounds[0].pipeline!.refs[0]);
  assert.equal(createHash("sha256").update(images).digest("hex"), report.rounds.at(-1)!.pipeline!.imageSha256);
  assert.equal(createHash("sha256").update(geometry).digest("hex"), report.rounds.at(-1)!.pipeline!.geometrySha256);
  assert.equal(envelope.processInstance, `sample-${adb("shell", "pidof", pkg).toString().trim()}`);
  assert.deepEqual(layers.map(layer => layer.name), report.rounds[0].pipeline!.refs);
  assert.equal(parseCaptureGeometryFile(geometry, token, envelope.processInstance, envelope.rootRef, layers).size, layers.length);
  assert.throws(() => parseCaptureGeometryFile(geometry, "0000000000000000", envelope.processInstance, envelope.rootRef, layers));
  assert.throws(() => parseCaptureGeometryFile(geometry, token, "wrong-process", envelope.rootRef, layers));
  assert.throws(() => parseCaptureGeometryFile(geometry, token, envelope.processInstance, "wrong-root", layers));
  assert.throws(() => parseCaptureGeometryFile(geometry, token, envelope.processInstance, envelope.rootRef,
    layers.map((layer, index) => index === 0 ? { ...layer, x: layer.x + 1 } : layer)));
}
console.log(JSON.stringify({ ...report, rounds: report.rounds.map(({ pipeline, ...round }) => ({ ...round, pipeline: pipeline && { ...pipeline, refs: undefined } })) }, null, 2));
