import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { readHelperObservation } from "../electron/capture/helper-observation";
import { createDebugTiming, measureDebugPhase, runWithDebugTiming } from "../electron/device/debug-timing";
import { helperObservationTimingSchema, type HelperObservationTiming } from "../shared/helper-observation-timing";
import { isDebugTimings, type DebugTimings } from "../shared/debug-timing";
import { isHelperObservationEvidence } from "../shared/helper-observation";
import { helperEvidence, helperFrame, helperPackage, helperPayload, helperToken } from "./fixtures/helper-protocol";

const extension = (): NonNullable<HelperObservationTiming["postProcessing"]> => ({
  windowValidationStartedAtMs: 105, windowValidationCompletedAtMs: 110,
  pngEncodingStartedAtMs: 111, pngEncodingCompletedAtMs: 125,
  base64EncodingStartedAtMs: 125, base64EncodingCompletedAtMs: 130,
});
const timing = (): HelperObservationTiming => ({ ...helperEvidence().timing, completedAtMs: 131, postProcessing: extension() });

test("old v1 Helper timing stays valid and does not invent post-processing duration", () => {
  const old = helperEvidence().timing;
  assert.deepEqual(helperObservationTimingSchema.parse(old), old);
  assert.equal(helperObservationTimingSchema.parse(old).postProcessing, undefined);
  assert.equal(helperObservationTimingSchema.safeParse(timing()).success, true);
  const zeroLength = timing();
  for (const key of Object.keys(zeroLength.postProcessing!) as (keyof NonNullable<HelperObservationTiming["postProcessing"]>)[])
    zeroLength.postProcessing![key] = zeroLength.screenshotCompletedAtMs;
  assert.equal(helperObservationTimingSchema.safeParse(zeroLength).success, true, "elapsedRealtime can report sub-ms work as zero");
});

test("post-processing timing rejects partial, unknown, unsafe and out-of-order measurements", () => {
  const invalid: unknown[] = [
    { ...timing(), inventedDuration: 1 },
    { ...timing(), postProcessing: null },
    { ...timing(), postProcessing: {} },
    { ...timing(), postProcessing: { ...extension(), unknown: 0 } },
    { ...timing(), postProcessing: { ...extension(), pngEncodingCompletedAtMs: -1 } },
    { ...timing(), postProcessing: { ...extension(), pngEncodingCompletedAtMs: Infinity } },
    { ...timing(), postProcessing: { ...extension(), pngEncodingCompletedAtMs: 125.5 } },
    { ...timing(), postProcessing: { ...extension(), pngEncodingCompletedAtMs: Number.MAX_SAFE_INTEGER + 1 } },
    { ...timing(), postProcessing: { ...extension(), windowValidationStartedAtMs: 103 } },
    { ...timing(), postProcessing: { ...extension(), windowValidationCompletedAtMs: 112 } },
    { ...timing(), postProcessing: { ...extension(), pngEncodingCompletedAtMs: 126 } },
    { ...timing(), postProcessing: { ...extension(), base64EncodingCompletedAtMs: 132 } },
    { ...timing(), screenshotStartedAtMs: 99 },
    { ...timing(), completedAtMs: 30_101 },
  ];
  for (const candidate of invalid) assert.equal(helperObservationTimingSchema.safeParse(candidate).success, false);
});

async function payload() {
  const png = await sharp({ create: { width: helperFrame.width, height: helperFrame.height, channels: 4,
    background: { r: 12, g: 34, b: 56, alpha: 1 } } }).png().toBuffer();
  return helperPayload(png.toString("base64"));
}

async function timedRead(fetcher: typeof fetch, signal = new AbortController().signal, clock?: () => number) {
  const collector = createDebugTiming(clock ? { now: clock, date: () => "2026-10-16T00:00:00.000Z" } : undefined);
  let timings: DebugTimings;
  try {
    const result = await runWithDebugTiming(collector, () => measureDebugPhase("observation",
      () => readHelperObservation(12345, helperToken, helperPackage, helperFrame, signal, fetcher),
      { backend: "accessibility-helper", reason: "explicit" }));
    timings = collector.finish("success");
    assert.equal(isDebugTimings(timings), true);
    return { result, timings };
  } catch (error) {
    timings = collector.finish(signal.aborted ? "cancelled" : "failed");
    assert.equal(isDebugTimings(timings), true);
    return { error, timings };
  }
}

test("host timing separates header wait, streamed body, JSON, tree and full PNG verification", async () => {
  const original = await payload();
  let now = 0;
  const measured = await timedRead((async () => {
    now = 20;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { now = 45; controller.enqueue(Buffer.from(JSON.stringify(original))); controller.close(); },
    }, { highWaterMark: 0 }));
  }) as typeof fetch, undefined, () => now);
  assert.ok(measured.result);
  assert.deepEqual(measured.result.helperObservation, original.helperObservation);
  const phase = (name: string) => measured.timings.spans.find(span => span.phase === name)!;
  assert.equal(phase("helper_request_headers").durationMs, 20);
  assert.equal(phase("helper_response_read").durationMs, 25);
  assert.equal(phase("helper_request").durationMs, 45);
  assert.equal(phase("helper_request_headers").parentId, phase("helper_request").id);
  assert.equal(phase("helper_response_read").parentId, phase("helper_request").id);
  for (const name of ["helper_json_parse", "helper_tree", "helper_png_validation"])
    assert.equal(phase(name).status, "success");
  assert.equal(measured.timings.observationCount, 1);
  assert.equal(measured.timings.commandCount, 0);
  assert.equal(measured.result.screenshotDataUrl, `data:image/png;base64,${original.screenshot_base64}`);
  assert.ok(!JSON.stringify(measured.timings).includes(helperToken), "timing never includes authentication material");
});

test("optional device timings survive transport without changing capture evidence", async () => {
  const original = await payload();
  Object.assign(original.helperObservation.timing, timing());
  const measured = await timedRead((async () => new Response(JSON.stringify(original))) as typeof fetch);
  assert.ok(measured.result);
  assert.equal(isHelperObservationEvidence(measured.result.helperObservation), true);
  assert.deepEqual(measured.result.helperObservation.timing, timing());
  assert.equal(measured.result.screenshotDataUrl, `data:image/png;base64,${original.screenshot_base64}`);
  // Device clock offsets remain in evidence; host spans never pretend to start at device uptime.
  assert.ok(measured.timings.spans.every(span => span.startOffsetMs <= measured.timings.durationMs));
});

test("invalid timing remains a protocol failure and cannot repair incomplete capture evidence", async () => {
  for (const change of ["invalid-timing", "incomplete-capture"] as const) {
    const original = await payload();
    Object.assign(original.helperObservation.timing, timing());
    if (change === "invalid-timing") Object.assign(original.helperObservation.timing,
      { postProcessing: { ...extension(), base64EncodingCompletedAtMs: 140 } });
    else Object.assign(original.helperObservation, { complete: false });
    const measured = await timedRead((async () => new Response(JSON.stringify(original))) as typeof fetch);
    assert.ok(measured.error);
    assert.equal(measured.timings.spans.find(span => span.phase === "helper_tree")?.status, "failed");
    assert.ok(!measured.timings.spans.some(span => span.phase === "helper_png_validation"));
  }
});

test("failed JSON and corrupt PNG identify the failing phase without a successful observation", async () => {
  const malformed = await timedRead((async () => new Response("{bad json")) as typeof fetch);
  assert.ok(malformed.error);
  assert.equal(malformed.timings.spans.find(span => span.phase === "helper_json_parse")?.status, "failed");
  assert.ok(!malformed.timings.spans.some(span => span.phase === "helper_tree"));
  const original = await payload(); original.screenshot_base64 = Buffer.from("not PNG").toString("base64");
  const corrupt = await timedRead((async () => new Response(JSON.stringify(original))) as typeof fetch);
  assert.ok(corrupt.error);
  assert.equal(corrupt.timings.spans.find(span => span.phase === "helper_tree")?.status, "success");
  assert.equal(corrupt.timings.spans.find(span => span.phase === "helper_png_validation")?.status, "failed");
});

test("cancellation during body read records cancellation and never enters parsing", async () => {
  const controller = new AbortController();
  const measured = await timedRead((async () => new Response(new ReadableStream<Uint8Array>({
    pull() { controller.abort(new DOMException("cancelled", "AbortError")); },
  }, { highWaterMark: 0 }))) as typeof fetch, controller.signal);
  assert.ok(measured.error);
  assert.equal(measured.timings.spans.find(span => span.phase === "helper_response_read")?.status, "cancelled");
  assert.equal(measured.timings.spans.find(span => span.phase === "helper_request")?.status, "cancelled");
  assert.ok(!measured.timings.spans.some(span => span.phase === "helper_json_parse"));
});
