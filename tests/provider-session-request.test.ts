import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { receiveProviderSessionLine, requestProviderSession, type ProviderWaiter } from "../electron/sdk/provider-session-request";

const fixture = () => ({ pending: [] as ProviderWaiter[], lastUsedAt: 0, socket: { write: (_line: string) => {} } });
const payload = { method: "capture-refs", arg: "TextView@a", extras: { debugCanvas: true } };
test("successful repeated replies remove timers, queue entries and abort listeners", async () => {
  const controller = new AbortController(), session = fixture();
  for (let i = 0; i < 24; i++) {
    const request = requestProviderSession(session, payload, 1000, controller.signal);
    session.pending[0].resolve("ok");
    assert.equal(await request, "ok");
    assert.equal(session.pending.length, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

const eventPayload = { method: "capture-visible", arg: "0123456789abcdef", extras: { withTree: true, treeReadyEvents: true } };
const event = { event: "tree-ready", nonce: eventPayload.arg, processInstance: "11111111-1111-1111-1111-111111111111", pid: 42 };
const eventLine = (value: unknown) => `Event: ${JSON.stringify(value)}`;
test("tree-ready is optional progress, not a final reply; duplicates and stale events are ignored", async () => {
  const session = fixture(), events: unknown[] = [];
  const request = requestProviderSession(session, eventPayload, 1000, undefined, value => events.push(value));
  receiveProviderSessionLine(session, eventLine({ ...event, nonce: "fedcba9876543210" }));
  receiveProviderSessionLine(session, "Event: {broken");
  receiveProviderSessionLine(session, eventLine({ ...event, pid: -1 }));
  receiveProviderSessionLine(session, eventLine({ ...event, processInstance: "bad" }));
  receiveProviderSessionLine(session, eventLine(event));
  receiveProviderSessionLine(session, eventLine(event));
  assert.deepEqual(events, [event]); assert.equal(session.pending.length, 1);
  receiveProviderSessionLine(session, "Result: Bundle[{result=ok}]");
  assert.equal(await request, "Result: Bundle[{result=ok}]"); assert.equal(session.pending.length, 0);
  receiveProviderSessionLine(session, eventLine(event)); assert.equal(events.length, 1);
});

test("old replies, unsupported calls and invalid event floods never authorize progress", async () => {
  for (const data of [payload, { ...eventPayload, extras: { withTree: true } }, eventPayload]) {
    const session = fixture(); let notifications = 0;
    const request = requestProviderSession(session, data, 1000, undefined, () => notifications++);
    for (let i = 0; i < 9; i++) receiveProviderSessionLine(session, "Event: {invalid");
    receiveProviderSessionLine(session, eventLine(event));
    assert.equal(notifications, 0); assert.equal(session.pending.length, 1);
    receiveProviderSessionLine(session, "legacy final"); assert.equal(await request, "legacy final");
  }
});

test("late event after cancellation is ignored and progress does not extend timeout", async () => {
  const controller = new AbortController(), session = fixture(); let notifications = 0;
  const request = requestProviderSession(session, eventPayload, 1000, controller.signal, () => notifications++);
  const late = session.pending[0]; const checked = assert.rejects(request, /event cancelled/);
  controller.abort(new Error("event cancelled")); late.event!(eventLine(event)); await checked;
  assert.equal(notifications, 0);
  const timed = fixture();
  const next = requestProviderSession(timed, eventPayload, 15, undefined, () => notifications++);
  receiveProviderSessionLine(timed, eventLine(event)); await assert.rejects(next, /会话调用超时/);
  assert.equal(notifications, 1); assert.equal(timed.pending.length, 0);
});
test("abort rejects once and late replies cannot resolve the aborted request", async () => {
  const controller = new AbortController(), session = fixture();
  const request = requestProviderSession(session, payload, 1000, controller.signal);
  const late = session.pending[0];
  const rejected = assert.rejects(request, /cancelled/);
  controller.abort(new Error("cancelled"));
  late.resolve("late");
  await rejected;
  assert.equal(session.pending.length, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const replacement = fixture();
  const next = requestProviderSession(replacement, payload, 1000);
  late.resolve("wrong generation");
  assert.equal(replacement.pending.length, 1);
  replacement.pending[0].resolve("new");
  assert.equal(await next, "new");
});
test("timeout drains its waiter and permits a fresh session to recover", async () => {
  const controller = new AbortController(), session = fixture();
  const request = requestProviderSession(session, payload, 10, controller.signal);
  const late = session.pending[0];
  await assert.rejects(request, /会话调用超时/);
  late.resolve("late");
  assert.equal(session.pending.length, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const replacement = fixture();
  const next = requestProviderSession(replacement, payload, 1000);
  late.resolve("wrong generation");
  replacement.pending[0].resolve("recovered");
  assert.equal(await next, "recovered");
});
test("pre-abort sends nothing; disconnect and write errors clean listeners", async () => {
  const controller = new AbortController(), session = fixture();
  controller.abort(new Error("pre-abort"));
  session.socket.write = () => { throw new Error("must not send"); };
  await assert.rejects(requestProviderSession(session, payload, 1000, controller.signal), /pre-abort/);
  assert.equal(session.pending.length, 0);
  for (const disconnect of [true, false]) {
    const current = fixture(), signal = new AbortController().signal;
    if (!disconnect) current.socket.write = () => { throw new Error("write failed"); };
    const request = requestProviderSession(current, payload, 1000, signal);
    if (disconnect) current.pending.splice(0)[0].reject(new Error("disconnected"));
    await assert.rejects(request, disconnect ? /disconnected/ : /write failed/);
    assert.equal(current.pending.length, 0);
    assert.equal(getEventListeners(signal, "abort").length, 0);
  }
});
