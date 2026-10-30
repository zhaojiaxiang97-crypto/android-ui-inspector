import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { HelperCaptureError } from "../electron/capture/accessibility-helper";
import { readHelperObservation } from "../electron/capture/helper-observation";
import { helperEvidence, helperFrame, helperPackage, helperPayload, helperToken } from "./fixtures/helper-protocol";

const privateError = "Incomplete fields: private-page-title token=never-show-this-value";
function rejectedEncoding() {
  return { success: false, has_screenshot: false, failureStage: "before-image-encoding", error: "Observation failed",
    truncated: false, ...helperFrame, node_count: 2, window_count: 1,
    helperObservation: { ...helperEvidence(), complete: false, diagnostics: { version: 1, reasons: [{ code: "child_unavailable", count: 1 }] } } };
}

test("explicit rejected-image response is never a snapshot and only strict metadata can request bounded recovery", async () => {
  const result = await read(rejectedEncoding());
  assert.equal(result.result, undefined); assert.equal(result.error?.code, "helper-incomplete");
  assert(result.error.recoveryEvidence); assert.equal(result.error.recoveryDiagnostics?.transport, "accepted");
  assert.doesNotMatch(JSON.stringify(result.error), /screenshot_base64|<hierarchy/);
  for (const mutate of [
    (p: any) => { p.success = true; }, (p: any) => { p.has_screenshot = true; },
    (p: any) => { p.screenshot_base64 = "png"; }, (p: any) => { p.xml = "tree"; },
    (p: any) => { p.extra = privateError; }, (p: any) => { p.failureStage = "unknown"; },
    (p: any) => { p.truncated = true; }, (p: any) => { p.width++; },
    (p: any) => { p.window_count++; }, (p: any) => { p.helperObservation.complete = true; },
    (p: any) => { p.helperObservation.timing.completedAtMs = 0; },
    (p: any) => { p.helperObservation.windowsAfter[0].packageName = "other.app"; },
    (p: any) => { p.helperObservation.diagnostics.reasons = [{ code: "node_read_failed", count: 1 }]; },
  ]) {
    const next = structuredClone(rejectedEncoding()); mutate(next);
    const failed = await read(next); assert.equal(failed.result, undefined); assert.equal(failed.error?.recoveryEvidence, undefined);
  }
});
async function payload() {
  const image = await sharp({ create: { ...helperFrame, channels: 4, background: "#123456" } }).png().toBuffer();
  return helperPayload(image.toString("base64"));
}
async function read(value: unknown) {
  let requests = 0;
  try {
    return { result: await readHelperObservation(12345, helperToken, helperPackage, helperFrame, new AbortController().signal,
      (async () => { requests++; return Response.json(value); }) as typeof fetch) };
  } catch (error) {
    assert.ok(error instanceof HelperCaptureError);
    assert.doesNotMatch(error.message, /private-page-title|never-show-this-value|Incomplete fields/);
    return { error };
  } finally { assert.equal(requests, 1, "diagnostics must not introduce retries"); }
}

test("incomplete and truncated Helper replies keep rejecting complete XML and PNG with fixed reasons", async () => {
  const original = await payload();
  for (const withError of [false, true]) {
    const incomplete = { ...original, helperObservation: { ...original.helperObservation, complete: false },
      ...(withError ? { error: privateError } : {}) };
    const rejected = await read(incomplete);
    assert.equal(rejected.error?.code, "helper-incomplete"); assert.match(rejected.error!.message, /完整性检查未通过/);
    const truncated = await read({ ...incomplete, truncated: true });
    assert.equal(truncated.error?.code, "helper-truncated"); assert.match(truncated.error!.message, /控件树被截断/);
  }
});

test("Helper failure envelopes without image or tree fields are classified without exposing service text", async () => {
  const result = await read({ success: false, has_screenshot: false, error: privateError, helperObservation: { complete: false } });
  assert.equal(result.error?.code, "helper-capture-failed"); assert.match(result.error!.message, /采集失败/);
  const original = await payload();
  assert.equal((await read({ ...original, success: false, error: privateError })).error?.code, "helper-capture-failed");
});

test("even an otherwise complete Helper payload cannot ignore its explicit error marker", async () => {
  const original = await payload();
  for (const error of [privateError, "", "x".repeat(1024)])
    assert.equal((await read({ ...original, error })).error?.code, "helper-service-error");
});

test("unbounded or malformed service errors and unknown success fields remain strict protocol failures", async () => {
  const original = await payload();
  for (const error of ["x".repeat(1025), null, { message: privateError }, [privateError]])
    assert.equal((await read({ ...original, error })).error?.code, "helper-invalid");
  assert.equal((await read({ ...original, extraPageText: privateError })).error?.code, "helper-invalid");
  assert.ok((await read(original)).result, "valid old and current v1 payloads stay accepted");
});

test("failure diagnostics do not relax complete evidence, timing or PNG validation", async () => {
  const original = await payload();
  const evidence = { ...original.helperObservation, timing: { ...original.helperObservation.timing, completedAtMs: 99 } };
  assert.equal((await read({ ...original, helperObservation: evidence })).error?.code, "helper-evidence");
  assert.equal((await read({ ...original, screenshot_base64: Buffer.from("not PNG").toString("base64") })).error?.code, "helper-image");
  assert.equal((await read({ ...original, helperObservation: { ...original.helperObservation, complete: "false" } })).error?.code, "helper-evidence");
});

test("only strict failure metadata exposes diagnostic counts and a read-only recovery candidate", async () => {
  const original = await payload(), diagnostics = { version: 1, reasons: [{ code: "child_unavailable", count: 2 }] };
  const incomplete = { ...original, error: privateError, helperObservation: { ...original.helperObservation, complete: false, diagnostics } };
  const result = await read(incomplete);
  assert.equal(result.error?.code, "helper-incomplete");
  assert.deepEqual(result.error?.diagnostics, diagnostics);
  assert.ok(result.error?.recoveryEvidence);
  assert.ok(Object.isFrozen(result.error.diagnostics));
  assert.ok(Object.isFrozen(result.error.diagnostics!.reasons));
  assert.ok(Object.isFrozen(result.error.diagnostics!.reasons[0]));
  assert.ok(Object.isFrozen(result.error.recoveryEvidence.windowsAfter[0].bounds));
  assert.equal(Object.getOwnPropertyDescriptor(result.error, "diagnostics")?.writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(result.error, "recoveryEvidence")?.writable, false);
  assert.doesNotMatch(JSON.stringify(result.error), /private-page-title|never-show-this-value|screenshot_base64|<hierarchy/);
  for (const mutate of [
    (p: Record<string, any>) => { p.truncated = true; },
    (p: Record<string, any>) => { p.success = false; },
    (p: Record<string, any>) => { p.width++; },
    (p: Record<string, any>) => { p.window_count++; },
    (p: Record<string, any>) => { delete p.xml; },
    (p: Record<string, any>) => { p.extra = "secret"; },
    (p: Record<string, any>) => { delete p.helperObservation.diagnostics; },
    (p: Record<string, any>) => { p.helperObservation.extra = "secret"; },
    (p: Record<string, any>) => { p.helperObservation.diagnostics.reasons.push({ code: "node_read_failed", count: 1 }); },
  ]) {
    const next = structuredClone(incomplete); mutate(next);
    assert.equal((await read(next)).error?.recoveryEvidence, undefined);
  }
  for (const malformed of [{ ...diagnostics, arbitrary: privateError }, { version: 1, reasons: [{ code: privateError, count: 1 }] }]) {
    const result = await read({ ...incomplete, helperObservation: { ...incomplete.helperObservation, diagnostics: malformed } });
    assert.equal(result.error?.diagnostics, undefined); assert.equal(result.error?.recoveryEvidence, undefined);
    assert.doesNotMatch(JSON.stringify(result.error), /private-page-title|never-show-this-value/);
  }
});

test("HelperCaptureError drops unsafe constructor details and clones diagnostics before freezing", () => {
  const diagnostic = { version: 1 as const, reasons: [{ code: "child_unavailable" as const, count: 1 }] };
  const error = new HelperCaptureError("helper-incomplete", "Fixed message", { diagnostics: diagnostic });
  diagnostic.reasons[0].count = 9;
  assert.equal(error.diagnostics!.reasons[0].count, 1);
  const invalid = new HelperCaptureError("helper-incomplete", "Fixed message", {
    diagnostics: { ...diagnostic, message: privateError } as typeof diagnostic,
  });
  assert.equal(invalid.diagnostics, undefined);
  assert.doesNotMatch(JSON.stringify(invalid), /private-page-title|never-show-this-value/);
});

test("successful transport accepts an empty diagnostic extension and rejects malformed or contradictory reasons", async () => {
  const original = await payload();
  const withDiagnostics = (diagnostics: unknown) => ({ ...original, helperObservation: { ...original.helperObservation, diagnostics } });
  assert.ok((await read(withDiagnostics({ version: 1, reasons: [] }))).result);
  for (const diagnostic of [{ version: 2, reasons: [] }, { version: 1, reasons: [], text: privateError },
    { version: 1, reasons: [{ code: "child_unavailable", count: 1 }] }])
    assert.equal((await read(withDiagnostics(diagnostic))).error?.code, "helper-evidence");
});
