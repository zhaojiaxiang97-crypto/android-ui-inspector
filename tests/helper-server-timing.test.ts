import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import sharp from "sharp";
import { HELPER_SNAPSHOT_TIMING_HEADER, helperServerTimingSchema, parseHelperServerTimingHeader, type HelperServerTiming } from "../shared/helper-observation-timing";
import { debugTimingsSchema } from "../shared/debug-timing";
import { createDebugTiming, getDebugTimings, measureDebugPhase, recordHelperServerTiming, runWithDebugTiming } from "../electron/device/debug-timing";
import { readHelperCapabilities, readHelperObservation } from "../electron/capture/helper-observation";
import { loadTestReport } from "../electron/desktop/test-report";
import { exportDebugReportEvidence } from "../electron/desktop/debug-report-export";
import { helperCapabilities, helperFrame, helperPackage, helperPayload, helperToken } from "./fixtures/helper-protocol";
import { makeDebugReportExportFixture } from "./fixtures/debug-report-export";

const server = (): HelperServerTiming => ({ version: 1, queueMs: 1.125, preObservationMs: 2.25,
  observationMs: 1000.5, jsonSerializationMs: 3.375, utf8EncodingMs: 4.5,
  cacheClearMs: 1, initialWindowReadMs: 2, getChildMs: 400, nodeLocalMs: 500 });
const wire = (value = server()) => Object.entries(value).map(([key, value]) => key === "version" ? `v=${value}` : `${key}=${value.toFixed(3)}`).join(";");
async function payload() {
  const png = await sharp({ create: { width: helperFrame.width, height: helperFrame.height, channels: 4,
    background: { r: 20, g: 40, b: 60, alpha: 1 } } }).png().toBuffer();
  return helperPayload(png.toString("base64"));
}
async function read(fetcher: typeof fetch, signal = new AbortController().signal) {
  const timer = createDebugTiming();
  try {
    const result = await runWithDebugTiming(timer, () => measureDebugPhase("observation",
      () => readHelperObservation(12345, helperToken, helperPackage, helperFrame, signal, fetcher),
      { backend: "accessibility-helper", reason: "explicit" }));
    return { result, error: undefined, timings: timer.finish("success") };
  } catch (error) { return { result: undefined, error, timings: timer.finish(signal.aborted ? "cancelled" : "failed") }; }
}

test("snapshot timing header has fixed numeric fields, optional measured stages and a rounding allowance", () => {
  assert.deepEqual(parseHelperServerTimingHeader(wire()), server());
  assert.deepEqual(parseHelperServerTimingHeader(wire().split(";").reverse().join(";")), server());
  const { cacheClearMs, initialWindowReadMs, getChildMs, nodeLocalMs, ...old } = server();
  assert.deepEqual(parseHelperServerTimingHeader(wire(old)), old);
  assert.equal(parseHelperServerTimingHeader(wire(old))!.getChildMs, undefined, "unknown work is not measured zero");
  const zero = { ...old, queueMs: 0, preObservationMs: 0, observationMs: 0, jsonSerializationMs: 0, utf8EncodingMs: 0 };
  assert.deepEqual(parseHelperServerTimingHeader(wire(zero)), zero, "explicit sub-ms zero remains a measurement");
  assert.equal(helperServerTimingSchema.safeParse({ ...old, observationMs: 1, getChildMs: 1.009 }).success, true);
  assert.equal(helperServerTimingSchema.safeParse({ ...old, observationMs: 1, getChildMs: 1.011 }).success, false);
  assert.equal(helperServerTimingSchema.safeParse({ ...old, queueMs: 60_000, preObservationMs: 60_000 }).success, true,
    "the contract bounds each duration; queue and request reading are outside the snapshot's 30s budget");
});

test("malformed diagnostic headers are ignored atomically and never expose their contents", () => {
  const valid = wire();
  for (const invalid of [null, undefined, "", "x".repeat(513), valid + ";secret=private-page-data", valid + ";v=1",
    valid + ";queueMs=0.000", valid + ";getChildMs=0.000", valid + ";", valid + ", " + valid,
    valid.replace("v=1;", ""), valid.replace("queueMs=1.125;", ""), valid.replace("v=1", "v=2"),
    valid.replace("queueMs", "QueueMs"), valid + ";非ASCII=0.000", valid + "\n", valid + "\t",
    ...["-1.000", "-0.000", "+1.000", "1e3", "NaN", "Infinity", ".125", "1.12", "1.1234", "01.000", "60000.001"]
      .map(value => valid.replace("queueMs=1.125", `queueMs=${value}`)),
    valid.replace("observationMs=1000.500", "observationMs=1.000"),
  ]) assert.equal(parseHelperServerTimingHeader(invalid), undefined);
  for (const value of [NaN, Infinity, -1, 60_000.001, 0.0005])
    assert.equal(helperServerTimingSchema.safeParse({ ...server(), queueMs: value }).success, false);
  assert.equal(helperServerTimingSchema.safeParse({ ...server(), privateText: "private-page-data" }).success, false);
  assert.equal(helperServerTimingSchema.safeParse({ ...server(), version: "1" }).success, false);
});

test("only an active snapshot headers span accepts one deep-copied server measurement", async () => {
  const timer = createDebugTiming(), original = server();
  recordHelperServerTiming(original);
  await runWithDebugTiming(timer, async () => {
    await measureDebugPhase("helper_request", () => recordHelperServerTiming(original), { helperEndpoint: "snapshot" });
    await measureDebugPhase("helper_request_headers", () => recordHelperServerTiming(original), { helperEndpoint: "capabilities" });
    await measureDebugPhase("helper_request_headers", () => {
      recordHelperServerTiming({ ...original, queueMs: -1 });
      recordHelperServerTiming(original); original.queueMs = 999;
      recordHelperServerTiming(original);
      const peek = getDebugTimings()!; peek.spans[2].helperServerTiming!.queueMs = 888;
      assert.equal(getDebugTimings()!.spans[2].helperServerTiming!.queueMs, 1.125);
    }, { helperEndpoint: "snapshot" });
  });
  const first = timer.finish("success"); assert.equal(debugTimingsSchema.safeParse(first).success, true);
  assert.equal(first.spans[0].helperServerTiming, undefined); assert.equal(first.spans[1].helperServerTiming, undefined);
  assert.deepEqual(first.spans[2].helperServerTiming, server());
  first.spans[2].helperServerTiming!.getChildMs = 999;
  timer.recordHelperServerTiming(3, original);
  assert.deepEqual(timer.finish("failed").spans[2].helperServerTiming, server());
  for (const change of ["phase", "endpoint", "missing-endpoint", "range", "unknown-field"] as const) {
    const corrupt = timer.peek(), span = corrupt.spans[2];
    if (change === "phase") span.phase = "helper_request";
    if (change === "endpoint") span.helperEndpoint = "capabilities";
    if (change === "missing-endpoint") delete span.helperEndpoint;
    if (change === "range") span.helperServerTiming!.getChildMs = 60_000;
    if (change === "unknown-field") Object.assign(span.helperServerTiming!, { url: "private-page-data" });
    assert.equal(debugTimingsSchema.safeParse(corrupt).success, false);
  }
});

test("valid, bad, missing and unreadable headers never change the successful capture", async () => {
  const original = await payload();
  for (const kind of ["valid", "bad", "missing", "unreadable"] as const) {
    const measured = await read((async () => {
      const response = new Response(JSON.stringify(original), { headers: kind === "missing" ? {} : {
        [HELPER_SNAPSHOT_TIMING_HEADER]: kind === "bad" ? wire() + ";private=secret" : wire(),
      } });
      if (kind === "unreadable") Object.defineProperty(response, "headers", { get() { throw Error("private-header-failure"); } });
      return response;
    }) as typeof fetch);
    assert.ok(measured.result, kind); assert.equal(measured.error, undefined);
    assert.deepEqual(measured.result.helperObservation, original.helperObservation);
    assert.equal(measured.result.screenshotDataUrl, `data:image/png;base64,${original.screenshot_base64}`);
    assert.equal(debugTimingsSchema.safeParse(measured.timings).success, true);
    const headers = measured.timings.spans.find(span => span.phase === "helper_request_headers")!;
    assert.deepEqual(headers.helperServerTiming, kind === "valid" ? server() : undefined);
    assert.ok(measured.timings.spans.every(span => span === headers || span.helperServerTiming === undefined));
    assert.doesNotMatch(JSON.stringify(measured.timings), /private|secret|test_session_token|X-Inspector|screenshot_base64|127\.0\.0\.1/);
  }
});

test("a header cannot repair incomplete or malformed captures and survives HTTP/body failure without fabricating a tree", async () => {
  const original = await payload();
  const incomplete = { ...original, helperObservation: { ...original.helperObservation, complete: false } };
  for (const header of [undefined, wire(), wire() + ";private=secret"]) {
    const measured = await read((async () => new Response(JSON.stringify(incomplete), {
      headers: header ? { [HELPER_SNAPSHOT_TIMING_HEADER]: header } : {},
    })) as typeof fetch);
    assert.ok(measured.error); assert.equal((measured.error as { code: string }).code, "helper-incomplete");
    assert.equal(measured.result, undefined);
    assert.equal(measured.timings.spans.find(span => span.phase === "helper_tree")?.status, "failed");
    assert.equal(measured.timings.spans.some(span => span.phase === "helper_png_validation"), false);
  }
  for (const [body, status, code] of [["unavailable", 503, "helper-http"], ["{invalid", 200, "helper-format"]] as const) {
    const measured = await read((async () => new Response(body, { status, headers: { [HELPER_SNAPSHOT_TIMING_HEADER]: wire() } })) as typeof fetch);
    assert.equal((measured.error as { code: string }).code, code);
    assert.deepEqual(measured.timings.spans.find(span => span.phase === "helper_request_headers")?.helperServerTiming, server());
    assert.equal(measured.timings.spans.some(span => span.phase === "helper_tree"), false);
  }
});

test("body cancellation preserves only the measured header and capabilities never acquire snapshot diagnostics", async () => {
  const controller = new AbortController();
  const measured = await read((async () => new Response(new ReadableStream({
    pull() { controller.abort(new DOMException("private-cancel", "AbortError")); },
  }, { highWaterMark: 0 }), { headers: { [HELPER_SNAPSHOT_TIMING_HEADER]: wire() } })) as typeof fetch, controller.signal);
  assert.ok(measured.error); assert.equal(measured.timings.status, "cancelled");
  const headers = measured.timings.spans.find(span => span.phase === "helper_request_headers")!;
  assert.equal(headers.status, "success"); assert.deepEqual(headers.helperServerTiming, server());
  assert.equal(measured.timings.spans.some(span => span.phase === "helper_tree"), false);
  const timer = createDebugTiming();
  await runWithDebugTiming(timer, () => readHelperCapabilities(12345, helperToken, new AbortController().signal,
    (async () => new Response(JSON.stringify(helperCapabilities), { headers: { [HELPER_SNAPSHOT_TIMING_HEADER]: wire() } })) as typeof fetch));
  assert.ok(timer.finish("success").spans.every(span => span.helperServerTiming === undefined));
});

test("server timing survives selected report export and strict independent reread", async () => {
  const fixture = await makeDebugReportExportFixture();
  try {
    const original = await payload(), measured = await read((async () => new Response(JSON.stringify(original), {
      headers: { [HELPER_SNAPSHOT_TIMING_HEADER]: wire() },
    })) as typeof fetch);
    assert.ok(measured.result);
    fixture.report.steps[2].step.timings = measured.timings; fixture.save();
    assert.deepEqual((await loadTestReport(fixture.file)).debug!.steps[2].step.timings, measured.timings);
    const exported = await exportDebugReportEvidence(fixture.source(), { ...fixture.request(), stepIds: [3] }, fixture.parent, { appVersion: "test" });
    assert.equal(exported.error, null);
    const loaded = await loadTestReport(join(exported.directory!, "report.json"));
    assert.deepEqual(loaded.debug!.steps[0].step.timings, measured.timings);
    const bad = fixture.report.steps[2].step.timings!.spans.find(span => span.phase === "helper_request_headers")!;
    bad.helperEndpoint = "capabilities"; fixture.save();
    await assert.rejects(loadTestReport(fixture.file));
  } finally { fixture.cleanup(); }
});
