import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readHelperConditionWait } from "../electron/capture/helper-condition-wait";
import type { HelperConditionWaitRequest } from "../shared/helper-condition-wait";
import { helperFrame, helperPackage, helperServiceId, helperToken } from "./fixtures/helper-protocol";

const request = (): HelperConditionWaitRequest => ({ version: 1, sessionId: randomUUID(), requestId: randomUUID(),
  serviceInstanceId: helperServiceId, packageName: helperPackage, selector: { text: "END" }, state: "visible", display: helperFrame, timeoutMs: 1000 });
function hint(input: HelperConditionWaitRequest) { return { success: true, protocolVersion: 1, sessionId: input.sessionId,
  requestId: input.requestId, serviceInstanceId: input.serviceInstanceId, packageName: input.packageName, windowId: "7", display: input.display,
  status: "ready", matchCount: 1, attempts: 1, startedAtMs: 200, finishedAtMs: 201 }; }
const read = (input: HelperConditionWaitRequest, value: unknown, status = 200) => readHelperConditionWait(12345, helperToken,
  input, new AbortController().signal, (async () => new Response(JSON.stringify(value), { status })) as typeof fetch);

test("device wait sends one bounded authenticated read-only POST and returns a hint only", async () => {
  const input = request(); let calls = 0;
  const result = await readHelperConditionWait(12345, helperToken, input, new AbortController().signal,
    (async (url, options) => {
      calls++; assert.equal(url, "http://127.0.0.1:12345/inspector/wait"); assert.equal(options!.method, "POST");
      assert.equal(options!.redirect, "error"); assert.equal((options!.headers as Record<string, string>)["X-Artemis-Token"], helperToken);
      assert.deepEqual(JSON.parse(String(options!.body)), input); assert.ok(Buffer.byteLength(String(options!.body)) <= 4096);
      return new Response(JSON.stringify(hint(input)));
    }) as typeof fetch);
  assert.equal(result!.status, "ready"); assert.equal(calls, 1);
  assert.equal("screenshotDataUrl" in result!, false); assert.equal("root" in result!, false);
});

test("only HTTP 404 or the exact unsupported envelope permits legacy Helper polling", async () => {
  const input = request();
  assert.equal(await read(input, {}, 404), null);
  assert.equal(await read(input, { errorCode: "unsupported", success: false }), null);
  for (const [body, status] of [[{}, 401], [{ success: false, errorCode: "unsupported" }, 500],
    [{ success: false, errorCode: "unsupported", extra: true }, 200], [{ success: false, errorCode: "failed" }, 200]] as const)
    await assert.rejects(read(input, body, status));
});

test("foreign identities, invalid ready counts and unknown fields never become evidence", async () => {
  for (const mutate of [
    (h: any) => { h.sessionId = randomUUID(); }, (h: any) => { h.requestId = randomUUID(); },
    (h: any) => { h.serviceInstanceId = randomUUID(); }, (h: any) => { h.packageName = "com.foreign.app"; },
    (h: any) => { h.display = { ...helperFrame, width: 99 }; }, (h: any) => { h.matchCount = 0; },
    (h: any) => { h.matchCount = 2; }, (h: any) => { h.root = {}; },
    (h: any) => { h.finishedAtMs = 100; }, (h: any) => { h.finishedAtMs = 9000; },
  ]) { const input = request(), body = hint(input); mutate(body); await assert.rejects(read(input, body)); }
  const absent = { ...request(), state: "absent" as const };
  await assert.rejects(read(absent, hint(absent)));
  assert.equal((await read(absent, { ...hint(absent), matchCount: 0 }))!.status, "ready");
  assert.equal((await read(absent, { ...hint(absent), status: "pending", matchCount: 2 }))!.status, "pending");
});

test("oversized, malformed and cancelled wait bodies are rejected", async () => {
  const input = request();
  await assert.rejects(read(input, { extra: "x".repeat(17 * 1024) }), /16 KiB/);
  await assert.rejects(readHelperConditionWait(12345, helperToken, input, new AbortController().signal,
    (async () => new Response("{")) as typeof fetch), /JSON/);
  const controller = new AbortController(); let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("{")); }, cancel() { cancelled = true; } });
  const pending = readHelperConditionWait(12345, helperToken, input, controller.signal, (async () => new Response(stream)) as typeof fetch);
  await new Promise(resolve => setTimeout(resolve, 10)); controller.abort(Error("cancel gate"));
  await assert.rejects(pending, /cancel gate/); assert.equal(cancelled, true);
});
