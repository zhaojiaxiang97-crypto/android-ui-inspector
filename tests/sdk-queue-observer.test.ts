import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { bindQueueNotice, createQueueObserver, parseQueueEvent, parseQueueStateReply, readQueueState, type QueueEvent } from "../scripts/diagnostics/sdk/sdk-queue-observer";

const identity = { apkSha256: "a".repeat(64), sdkVersion: "verified-build", pid: 42, startTicks: "12345",
  processInstance: "22222222-2222-2222-2222-222222222222", requestId: "11111111-1111-1111-1111-111111111111" };
const target = { serial: "fixture", packageName: "example.app", identity };
const event = (patch: Partial<QueueEvent> = {}): QueueEvent => ({ event: "tree-queue", protocol: "tree-queue-v1",
  phase: "queued", requestId: identity.requestId, kind: "classic", pid: 42, processInstance: identity.processInstance,
  postedMs: 100000, enteredMs: -1, endedMs: -1, settledMs: -1, observedMs: 100600, ...patch });
const reply = (state = event({ phase: "state" })) => `Result: Bundle[{diagnostic=${JSON.stringify(state)}, result=ok}]`;
const active = () => true;

test("strict JSON/bundle parsing accepts classic and merged scalar states", () => {
  assert.deepEqual(parseQueueEvent(JSON.stringify(event())), event());
  const merged = event({ kind: "merged", requestId: "0123456789abcdef" });
  assert.deepEqual(parseQueueEvent(JSON.stringify(merged)), merged);
  assert.deepEqual(parseQueueStateReply(reply()), event({ phase: "state" }));
  assert.deepEqual(parseQueueStateReply(`Result: Bundle[{result=ok, diagnostic=${JSON.stringify(event({ phase: "state" }))}}]`), event({ phase: "state" }));
  const bound = bindQueueNotice(event(), identity, 20);
  assert.equal(bound.identity.sdkVersion, "verified-build"); assert.equal(bound.receivedHostMs, 20);
});

test("malformed, oversized, unsupported, contradictory or augmented events never authorize work", () => {
  for (const value of [null, [], {}, { ...event(), extra: true }, event({ protocol: "unknown" as never }),
    event({ kind: "merged" }), event({ pid: -1 }), event({ enteredMs: 100700 }), event({ endedMs: 100500 }),
    event({ phase: "settled" }), event({ postedMs: -1 }), event({ enteredMs: 100100 }),
    event({ phase: "entered", enteredMs: 100100, settledMs: 100200 }), event({ processInstance: "bad" })]) {
    assert.throws(() => parseQueueEvent(JSON.stringify(value)));
  }
  assert.throws(() => parseQueueEvent("x".repeat(2049)), /size/);
  assert.throws(() => parseQueueEvent("{broken"));
  for (const value of [reply(event()), "Result: Bundle[{error=Unauthorized}]", "Result: Bundle[{result=ok}]",
    reply() + "\n" + reply(), "x".repeat(4097)]) assert.throws(() => parseQueueStateReply(value));
  assert.throws(() => bindQueueNotice(event({ pid: 99 }), identity, 0), /identity/);
});

test("independent query issues one bounded content call and never uses the capture socket", async () => {
  let calls = 0;
  const state = await readQueueState(target, new AbortController().signal, async (args, timeout, signal) => {
    calls++; assert.equal(timeout, 750); assert.equal(signal.aborted, false);
    assert.deepEqual(args, ["-s", "fixture", "shell", "content", "call", "--uri", "content://example.app.inspector",
      "--method", "read-tree-task", "--arg", identity.requestId, "--extra", `processInstance:s:${identity.processInstance}`]);
    return reply();
  });
  assert.equal(calls, 1); assert.equal(state.phase, "state");
  const controller = new AbortController(); controller.abort(Error("cancelled"));
  await assert.rejects(readQueueState(target, controller.signal, async () => { calls++; return reply(); }), /cancelled/);
  assert.equal(calls, 1);
  await assert.rejects(readQueueState({ ...target, serial: "bad; command" }, new AbortController().signal,
    async () => { calls++; return reply(); }), /Invalid/);
  assert.equal(calls, 1);
});

test("query failure, late cancelled reply and wrong identity have no retry", async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(readQueueState(target, controller.signal, async () => {
    calls++; controller.abort(Error("cancel query")); return reply();
  }), /cancel query/);
  await assert.rejects(readQueueState(target, new AbortController().signal, async () => {
    calls++; throw Error("transport timeout");
  }), /transport timeout/);
  await assert.rejects(readQueueState(target, new AbortController().signal, async () => {
    calls++; return reply(event({ phase: "state", requestId: "33333333-3333-3333-3333-333333333333" }));
  }), /identity/);
  assert.equal(calls, 3);
});

function fixture(patch: Partial<Parameters<typeof createQueueObserver>[1]> = {}) {
  let ms = 0, reads = 0, verifies = 0;
  const observer = createQueueObserver(target, { now: () => ms,
    verify: async () => { verifies++; ms += 10; return { ...identity }; },
    read: async () => { reads++; ms += 10; return event({ phase: "state", observedMs: 100620 }); }, ...patch });
  return { observer, count: () => ({ reads, verifies }), advance: (n: number) => { ms += n; } };
}
test("preparation rechecks fresh state and reserves only once without taking a stack", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const result = await f.observer.prepare(JSON.stringify(event()), signal, active);
  assert.equal(result.status, "sample-reserved");
  assert.ok("notice" in result); assert.equal(result.notice?.receivedHostMs, 10);
  assert.deepEqual(f.count(), { reads: 1, verifies: 1 });
  assert.equal((await f.observer.prepare(JSON.stringify(event()), signal, active)).status, "already-attempted");
  assert.deepEqual(f.count(), { reads: 1, verifies: 1 });
});
test("ended, early and mismatched notices do not trigger identity or device reads", async () => {
  const signal = new AbortController().signal;
  for (const [notice, status] of [[event({ phase: "state" }), "not-queued"], [event({ observedMs: 100499 }), "too-early"]] as const) {
    const f = fixture(); assert.equal((await f.observer.prepare(JSON.stringify(notice), signal, active)).status, status);
    assert.deepEqual(f.count(), { reads: 0, verifies: 0 });
  }
  const f = fixture();
  assert.equal((await f.observer.prepare(JSON.stringify(event()), signal, () => false)).status, "request-ended");
  await assert.rejects(f.observer.prepare(JSON.stringify(event({ pid: 99 })), signal, active), /identity/);
  assert.deepEqual(f.count(), { reads: 0, verifies: 0 });
});
test("changed, finished, stale or slow state cannot authorize a stack", async () => {
  for (const patch of [{ postedMs: 100001 }, { observedMs: 100599 }, { kind: "merged", requestId: "0123456789abcdef" }] as const) {
    const f = fixture({ read: async () => event({ phase: "state", ...patch }) });
    await assert.rejects(f.observer.prepare(JSON.stringify(event()), new AbortController().signal, active));
  }
  const ended = fixture({ read: async () => event({ phase: "state", settledMs: 100600 }) });
  assert.equal((await ended.observer.prepare(JSON.stringify(event()), new AbortController().signal, active)).status, "task-not-queued");
  const slow = fixture({ read: async () => { slow.advance(251); return event({ phase: "state" }); } });
  assert.equal((await slow.observer.prepare(JSON.stringify(event()), new AbortController().signal, active)).status, "stale-notice");
  const stale = fixture({ verify: async () => { stale.advance(251); return identity; } });
  assert.equal((await stale.observer.prepare(JSON.stringify(event()), new AbortController().signal, active)).status, "stale-notice");
});
test("failed or cancelled verification consumes preparation and rejects late results", async () => {
  const signal = new AbortController().signal;
  const f = fixture({ verify: async () => { throw Error("verify failed"); } });
  await assert.rejects(f.observer.prepare(JSON.stringify(event()), signal, active), /verify failed/);
  assert.equal((await f.observer.prepare(JSON.stringify(event()), signal, active)).status, "already-attempted");
  const changed = fixture({ verify: async () => ({ ...identity, startTicks: "9999" }) });
  await assert.rejects(changed.observer.prepare(JSON.stringify(event()), signal, active), /identity changed/);
  assert.equal(changed.count().reads, 0);
  const controller = new AbortController();
  const cancelled = fixture({ verify: async () => { controller.abort(Error("user cancel")); return identity; } });
  await assert.rejects(cancelled.observer.prepare(JSON.stringify(event()), controller.signal, active), /user cancel/);
  assert.equal(cancelled.count().reads, 0);
});

test("hanging verification times out once; late completion never starts a query", async () => {
  let complete!: (value: typeof identity) => void;
  const controller = new AbortController();
  const f = fixture({ verify: () => new Promise(resolve => { complete = resolve; }) });
  await assert.rejects(f.observer.prepare(JSON.stringify(event()), controller.signal, active), /exceeded 1000ms/);
  complete(identity); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.count().reads, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal((await f.observer.prepare(JSON.stringify(event()), controller.signal, active)).status, "already-attempted");
});

test("cancel during a hung query returns immediately and ignores its late reply", async () => {
  let complete!: (value: QueueEvent) => void;
  const controller = new AbortController();
  const f = fixture({ read: () => new Promise(resolve => { complete = resolve; }) });
  const pending = f.observer.prepare(JSON.stringify(event()), controller.signal, active);
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort(Error("cancel hung read"));
  await assert.rejects(pending, /cancel hung read/);
  complete(event({ phase: "state" })); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
