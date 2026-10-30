import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { HelperCaptureError } from "../electron/capture/accessibility-helper";
import { readHelperObservation } from "../electron/capture/helper-observation";
import { helperFrame, helperPackage, helperPayload, helperToken } from "./fixtures/helper-protocol";

const privateError = "Incomplete fields: private-page-title token=never-show-this-value";
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
