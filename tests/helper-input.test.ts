import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { HelperInputError, readHelperInput } from "../electron/capture/helper-input";
import { helperInputRequest, helperInputReply, type HelperInputRequest, type HelperInputReply } from "../shared/helper-input";
import { helperFrame, helperPackage, helperServiceId, helperToken } from "./fixtures/helper-protocol";

const request = (): HelperInputRequest => ({ version: 1, sessionId: randomUUID(), requestId: randomUUID(), serviceInstanceId: helperServiceId,
  captureId: randomUUID(), packageName: helperPackage, windowId: "7", display: helperFrame, action: { kind: "tap", x: 1, y: 2 } });
const reply = (input: HelperInputRequest): HelperInputReply => {
  const { action: _, target: _target, ...identity } = input;
  return { ...identity, status: "completed", dispatchState: "sent", startedAtMs: 150, finishedAtMs: 160,
    method: input.target ? "accessibility-click" : input.action.kind === "back" ? "global-back" : "gesture" };
};
const read = (input: HelperInputRequest, value: unknown, status = 200) => readHelperInput(12345, helperToken, input,
  new AbortController().signal, (async () => new Response(JSON.stringify(value), { status })) as typeof fetch);

test("Helper input sends exactly one bounded authenticated POST with fixed action and complete identity", async () => {
  const input = request(); let calls = 0;
  const result = await readHelperInput(12345, helperToken, input, new AbortController().signal, (async (url, options) => {
    calls++; assert.equal(url, "http://127.0.0.1:12345/inspector/input"); assert.equal(options!.method, "POST");
    assert.equal(options!.redirect, "error"); assert.equal((options!.headers as Record<string, string>)["X-Artemis-Token"], helperToken);
    assert.deepEqual(JSON.parse(String(options!.body)), input); assert.ok(Buffer.byteLength(String(options!.body)) <= 4096);
    return new Response(JSON.stringify(reply(input)));
  }) as typeof fetch);
  assert.deepEqual(result, reply(input)); assert.equal(calls, 1);
});

test("request schema rejects arbitrary commands, offscreen coordinates and invalid swipe durations", () => {
  for (const action of [{ kind: "home" }, { kind: "tap", x: 10, y: 2 }, { kind: "tap", x: -1, y: 2 },
    { kind: "tap", x: 1.5, y: 2 }, { kind: "back", command: "arbitrary" },
    { kind: "swipe", fromX: 1, fromY: 2, toX: 1, toY: 2, durationMs: 300 },
    { kind: "swipe", fromX: 1, fromY: 2, toX: 2, toY: 3, durationMs: 1001 }])
    assert.equal(helperInputRequest.safeParse({ ...request(), action }).success, false);
  assert.equal(helperInputRequest.safeParse({ ...request(), action: { kind: "back" } }).success, true);
  for (const patch of [{ windowId: "07" }, { windowId: "7\n" }, { packageName: "com.example.app\n" }])
    assert.equal(helperInputRequest.safeParse({ ...request(), ...patch }).success, false);
});

const exactTarget = (): NonNullable<HelperInputRequest["target"]> => ({ resourceId: helperPackage + ":id/button", className: "android.widget.Button",
  text: "", contentDesc: "", bounds: { left: 0, top: 0, right: 10, bottom: 20 } });
test("semantic descriptors are bounded, exact and only allowed on taps", () => {
  const input = { ...request(), target: exactTarget() };
  assert.equal(helperInputRequest.safeParse(input).success, true);
  for (const patch of [{ resourceId: "" }, { className: "" }, { resourceId: "x".repeat(513) }, { className: "x".repeat(513) },
    { text: "x".repeat(513) }, { contentDesc: "x".repeat(513) }, { unexpected: "field" },
    { bounds: { left: -1, top: 0, right: 10, bottom: 20 } }, { bounds: { left: 0.5, top: 0, right: 10, bottom: 20 } },
    { bounds: { left: 1, top: 0, right: 1, bottom: 20 } }, { bounds: { left: 0, top: 5, right: 10, bottom: 4 } },
    { bounds: { left: 2, top: 0, right: 10, bottom: 20 } }, { bounds: { left: 0, top: 3, right: 10, bottom: 20 } },
    { bounds: { left: 0, top: 0, right: 1, bottom: 20 } }, { bounds: { left: 0, top: 0, right: 10, bottom: 2 } },
    { bounds: { left: 0, top: 0, right: 11, bottom: 20 } }, { bounds: { left: 0, top: 0, right: 10, bottom: 21 } }])
    assert.equal(helperInputRequest.safeParse({ ...input, target: { ...exactTarget(), ...patch } }).success, false);
  for (const action of [{ kind: "back" }, { kind: "swipe", fromX: 1, fromY: 2, toX: 2, toY: 3, durationMs: 300 }])
    assert.equal(helperInputRequest.safeParse({ ...input, action }).success, false);
});

test("new HTTP receipts must identify exactly the method chosen before sending", async () => {
  const tap = request();
  const semantic: HelperInputRequest = { ...request(), target: exactTarget() };
  const back: HelperInputRequest = { ...request(), action: { kind: "back" } };
  const swipe: HelperInputRequest = { ...request(), action: { kind: "swipe", fromX: 1, fromY: 2, toX: 2, toY: 3, durationMs: 300 } };
  for (const input of [tap, semantic, back, swipe]) {
    assert.deepEqual(await read(input, reply(input)), reply(input));
    for (const method of [undefined, "accessibility-click", "gesture", "global-back"].filter(method => method !== reply(input).method))
      await assert.rejects(read(input, { ...reply(input), method }), unknownInput);
  }
  const { method: _, ...historical } = reply(tap);
  assert.equal(helperInputReply.safeParse(historical).success, true, "historical reports may omit the method");
  assert.equal(helperInputReply.safeParse({ ...reply(tap), mainStartedAtMs: 151 }).success, true);
  const timeout = { ...reply(semantic), status: "timeout", dispatchState: "not_sent", errorCode: "timeout",
    mainStartedAtMs: 151, preflightStage: "target_scan", preflightStageStartedAtMs: 153 };
  assert.deepEqual(await read(semantic, timeout), timeout);
});
test("named semantic tap requires a nonblank exact description when resource ID is absent", async () => {
  const { resourceId: _, ...target } = exactTarget();
  const input: HelperInputRequest = { ...request(), target: { ...target, contentDesc: "我" } };
  assert.deepEqual(helperInputRequest.parse(input), input);
  let calls = 0;
  const result = await readHelperInput(12345, helperToken, input, new AbortController().signal, (async (_url, options) => {
    calls++;
    const sent = JSON.parse(String(options!.body));
    assert.equal(Object.prototype.hasOwnProperty.call(sent.target, "resourceId"), false);
    assert.deepEqual(sent, input);
    return new Response(JSON.stringify(reply(input)));
  }) as typeof fetch);
  assert.equal(calls, 1);
  assert.equal(result.method, "accessibility-click");
  for (const bad of [
    { ...target }, { ...target, text: "我" }, { ...target, contentDesc: "" },
    { ...target, contentDesc: " \n\t" }, { ...target, contentDesc: "我", resourceId: "" },
    { ...target, contentDesc: "我", resourceId: null }, { ...target, contentDesc: "我", className: "" },
    { ...target, contentDesc: "x".repeat(513) },
  ]) assert.equal(helperInputRequest.safeParse({ ...request(), target: bad }).success, false);
  assert.equal(helperInputRequest.safeParse({ ...input, action: { kind: "scroll", direction: "down" } }).success, false);
  await assert.rejects(read(input, { ...reply(input), method: "gesture" }), unknownInput);
});
const unknownInput = (error: unknown) => error instanceof HelperInputError && error.dispatchState === "unknown";
test("semantic scroll requires its chosen method after exactly one exact-target POST", async () => {
  const input: HelperInputRequest = { ...request(), action: { kind: "scroll", direction: "down" }, target: exactTarget() };
  for (const method of ["accessibility-scroll", "gesture", "accessibility-click", undefined] as const) {
    let calls = 0;
    const expected = { ...reply(input), method };
    const pending = readHelperInput(12345, helperToken, input, new AbortController().signal, (async (_url, options) => {
      calls++; assert.deepEqual(JSON.parse(String(options!.body)), input); return new Response(JSON.stringify(expected));
    }) as typeof fetch);
    if (method === "accessibility-scroll") assert.deepEqual(await pending, expected);
    else await assert.rejects(pending, unknownInput);
    assert.equal(calls, 1);
  }
});

test("all foreign reply identities, impossible states, timing and unknown fields remain unknown dispatch", async () => {
  for (const patch of [
    { sessionId: randomUUID() }, { requestId: randomUUID() }, { serviceInstanceId: randomUUID() }, { captureId: randomUUID() },
    { packageName: "com.other.app" }, { windowId: "8" }, { display: { ...helperFrame, rotation: 1 } },
    { status: "completed", dispatchState: "not_sent" }, { status: "rejected", dispatchState: "sent" },
    { status: "cancelled", dispatchState: "not_sent" }, { status: "timeout", dispatchState: "sent" },
    { finishedAtMs: 149 }, { finishedAtMs: 8000 }, { mainStartedAtMs: 149 }, { mainStartedAtMs: 161 },
    { preflightStage: "target_scan" }, { preflightStageStartedAtMs: 153 }, { preflightStage: "private page title" },
    { preflightStage: "target_scan", preflightStageStartedAtMs: 153 },
    { errorCode: "untrusted business text" }, { errorCode: "dispatch_error" }, { extra: "unexpected" },
  ]) {
    const input = request();
    await assert.rejects(read(input, { ...reply(input), ...patch }), (error: unknown) =>
      error instanceof HelperInputError && error.dispatchState === "unknown" && error.requestId === input.requestId);
  }
  const input = request();
  for (const [status, dispatchState] of [["rejected", "not_sent"], ["cancelled", "unknown"], ["timeout", "not_sent"], ["timeout", "unknown"]] as const)
    assert.equal(helperInputReply.safeParse({ ...reply(input), status, dispatchState,
      errorCode: status === "rejected" ? "dispatch_rejected" : status }).success, true);
  for (const status of ["cancelled", "timeout"])
    for (const errorCode of [undefined, "window_changed"])
      assert.equal(helperInputReply.safeParse({ ...reply(input), status, dispatchState: "unknown", errorCode }).success, false);
  assert.equal(helperInputReply.safeParse({ ...reply(input), status: "cancelled", dispatchState: "unknown", errorCode: "dispatch_error" }).success, true);
  assert.equal(helperInputReply.safeParse({ ...reply(input), status: "timeout", dispatchState: "unknown", errorCode: "dispatch_error" }).success, false);
  const timeout = { ...reply(input), status: "timeout", dispatchState: "not_sent", errorCode: "timeout", mainStartedAtMs: 151,
    preflightStage: "window_inventory", preflightStageStartedAtMs: 152 };
  for (const patch of [{ preflightStageStartedAtMs: 149 }, { preflightStageStartedAtMs: 161 },
    { mainStartedAtMs: undefined }, { preflightStage: undefined }, { dispatchState: "unknown" }, { status: "rejected" }])
    assert.equal(helperInputReply.safeParse({ ...timeout, ...patch }).success, false);
});

test("404, unsupported, malformed, network and oversized replies never retry or fallback", async () => {
  for (const scenario of ["404", "unsupported", "malformed", "network", "oversized"]) {
    const input = request(); let calls = 0;
    await assert.rejects(readHelperInput(12345, helperToken, input, new AbortController().signal, (async () => {
      calls++;
      if (scenario === "network") throw Error("Helper 输入 secret token or page text");
      return new Response(scenario === "malformed" ? "{" : JSON.stringify(scenario === "oversized" ? { extra: "x".repeat(17000) }
        : { success: false, errorCode: "unsupported" }), { status: scenario === "404" ? 404 : 200 });
    }) as typeof fetch), (error: unknown) => error instanceof HelperInputError && error.dispatchState === "unknown"
      && error.requestId === input.requestId && !error.message.includes("secret"));
    assert.equal(calls, 1);
  }
});

test("preflight cancellation sends no request while body cancellation retains unknown and joins reader cleanup", async () => {
  const input = request(), before = new AbortController(); before.abort(); let calls = 0;
  await assert.rejects(readHelperInput(12345, helperToken, input, before.signal, (async () => { calls++; return new Response(); }) as typeof fetch),
    (error: unknown) => error instanceof HelperInputError && error.dispatchState === "not_sent" && !error.requestId);
  assert.equal(calls, 0);
  const controller = new AbortController(); let cancelled = false, reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const pending = readHelperInput(12345, helperToken, input, controller.signal, (async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode("{")); reached(); }, cancel() { cancelled = true; },
  }))) as typeof fetch);
  await entered; controller.abort(Error("stop"));
  await assert.rejects(pending, (error: unknown) => error instanceof HelperInputError && error.dispatchState === "unknown");
  assert.equal(cancelled, true);
});
