import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { helperWindowStateRequest, helperWindowStateReply, helperWindowReadiness, type HelperWindowStateRequest } from "../shared/helper-window-state";
import { readHelperWindowState } from "../electron/capture/helper-window-state";
import { helperToken, helperPackage, helperFrame, helperServiceId } from "./fixtures/helper-protocol";

const request = (): HelperWindowStateRequest => ({ version: 1, sessionId: randomUUID(), requestId: randomUUID(),
  serviceInstanceId: helperServiceId, packageName: helperPackage, display: helperFrame, timeoutMs: 500 });
const window = () => ({ id: 7, displayId: 0 as const, type: "application" as const, layer: 0, focused: true, active: true,
  hasParent: false, transitionTimeMs: 50, bounds: { left: 0, top: 0, right: helperFrame.width, bottom: helperFrame.height } });
const reply = (r = request()) => {
  const { timeoutMs: _, ...identity } = r;
  return { ...identity, readOnly: true as const, dispatchState: "not_sent" as const, startedAtMs: 100, finishedAtMs: 120,
    windowsBefore: [window()], windowsAfter: [window()], foregroundPackage: r.packageName, rootWindowId: 7,
    cacheCleared: true as const, rootReads: 1, childReads: 0 as const, screenshots: 0 as const };
};

test("window metadata rejects input claims, partial inventories and unknown fields", () => {
  const valid = reply(); assert(helperWindowStateReply.safeParse(valid).success);
  for (const patch of [{ action: { kind: "back" } }, { complete: true }, { captureId: randomUUID() }, { readOnly: false },
    { dispatchState: "sent" }, { childReads: 1 }, { screenshots: 1 }, { finishedAtMs: 601 },
    { windowsAfter: [window(), window()] }, { windowsAfter: [{ ...window(), displayId: 1 }] },
    { windowsAfter: [{ ...window(), bounds: { ...window().bounds, right: 0 } }] }])
    assert(!helperWindowStateReply.safeParse({ ...valid, ...patch }).success);
  assert(!helperWindowStateRequest.safeParse({ ...request(), timeoutMs: 501 }).success);
  assert(!helperWindowStateRequest.safeParse({ ...request(), action: { kind: "back" } }).success);
});

test("readiness requires unchanged complete metadata, unique active app focus and actual root identity", () => {
  const valid = helperWindowStateReply.parse(reply()), ready = helperWindowReadiness(valid); assert(ready.ready);
  for (const patch of [{ foregroundPackage: "other.app" }, { foregroundPackage: null }, { rootWindowId: 8 },
    { rootReads: 0, foregroundPackage: null, rootWindowId: null }, { windowsAfter: [] },
    { windowsAfter: [{ ...window(), transitionTimeMs: 51 }] },
    { windowsBefore: [{ ...window(), hasParent: true }], windowsAfter: [{ ...window(), hasParent: true }] },
    { windowsBefore: [{ ...window(), active: false }], windowsAfter: [{ ...window(), active: false }] }])
    assert(!helperWindowReadiness(helperWindowStateReply.parse({ ...valid, ...patch })).ready);
  const changed = { ...window(), bounds: { ...window().bounds, right: helperFrame.width - 1 } };
  assert.notEqual(helperWindowReadiness({ ...valid, windowsBefore: [changed], windowsAfter: [changed] }).signature, ready.signature);
});

test("window transport posts once, binds every identity and rejects unsupported or stale-budget responses", async () => {
  const input = request(); let calls = 0;
  const read = (value: unknown, status = 200) => readHelperWindowState(12345, helperToken, input, new AbortController().signal,
    (async (url, options) => {
      calls++; assert.match(String(url), /\/inspector\/window-state$/); assert.equal(options!.method, "POST");
      assert.equal(options!.redirect, "error"); assert.equal((options!.headers as any)["X-Artemis-Token"], helperToken);
      assert.deepEqual(JSON.parse(String(options!.body)), input);
      return new Response(typeof value === "string" ? value : JSON.stringify(value), { status });
    }) as typeof fetch);
  assert.deepEqual(await read(reply(input)), reply(input));
  for (const patch of [{ sessionId: randomUUID() }, { requestId: randomUUID() }, { serviceInstanceId: randomUUID() },
    { packageName: "other.app" }, { display: { ...helperFrame, rotation: 1 } }, { finishedAtMs: 601 }])
    await assert.rejects(read({ ...reply(input), ...patch }));
  await assert.rejects(read({ success: false, errorCode: "timeout" }), (error: any) => error.code === "helper-window-state-timeout");
  await assert.rejects(read({ success: false, errorCode: "private-untrusted-reason" }), (error: any) => error.code === "helper-window-state");
  const before = calls; await assert.rejects(read({}, 404)); assert.equal(calls, before + 1);
  await assert.rejects(read(" ".repeat(32769)));
  await assert.rejects(read("not JSON"));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(readHelperWindowState(12345, helperToken, input, aborted.signal, (async () => {
    calls++; throw Error("must not start");
  }) as typeof fetch));
  assert.equal(calls, before + 3);
});
