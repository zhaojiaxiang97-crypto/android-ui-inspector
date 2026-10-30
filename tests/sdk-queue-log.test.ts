import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { waitForQueueLog } from "../scripts/diagnostics/sdk/sdk-queue-log";
import { createQueueObserver } from "../scripts/diagnostics/sdk/sdk-queue-observer";

const identity = { apkSha256: "a".repeat(64), sdkVersion: "verified-build", pid: 42, startTicks: "12345",
  processInstance: "22222222-2222-2222-2222-222222222222", requestId: "11111111-1111-1111-1111-111111111111" };
const target = { serial: "fixture", packageName: "example.app", identity };
const event = (patch = {}) => ({ event: "tree-queue", protocol: "tree-queue-v1", phase: "queued",
  requestId: identity.requestId, kind: "classic", pid: 42, processInstance: identity.processInstance,
  postedMs: 100000, enteredMs: -1, endedMs: -1, settledMs: -1, observedMs: 100600, ...patch });
class FakeLog extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); kills: string[] = [];
  closeOnKill = true;
  kill(signal = "SIGTERM") {
    this.kills.push(signal);
    if (this.closeOnKill) queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}
function fixture(options: Partial<Parameters<typeof waitForQueueLog>[2]> = {}) {
  const child = new FakeLog(), controller = new AbortController();
  let starts = 0;
  const promise = waitForQueueLog(target, controller.signal, { ...options, start: args => {
    starts++;
    assert.deepEqual(args, ["-s", "fixture", "logcat", "-v", "raw", "--pid=42", "-s", "InspectorTreeQueue:D"]);
    return child as never;
  } });
  return { child, controller, promise, starts: () => starts };
}
function clean(f: ReturnType<typeof fixture>) {
  assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  assert.equal(f.child.listenerCount("close"), 0);
  assert.equal(f.child.stdout.listenerCount("data"), 0);
  assert.equal(f.child.stderr.listenerCount("data"), 0);
  assert.equal(f.starts(), 1);
}

test("chunked raw log subscription ignores foreign events and closes its own child before resolving", async () => {
  const f = fixture({ now: () => 100 });
  f.child.stdout.write("--------- beginning of main\n");
  f.child.stdout.write(JSON.stringify(event({ pid: 99 })) + "\n");
  f.child.stdout.write(JSON.stringify(event({ requestId: "33333333-3333-3333-3333-333333333333" })) + "\n");
  const json = JSON.stringify(event());
  f.child.stdout.write(json.slice(0, 30)); f.child.stdout.write(json.slice(30) + "\r\n");
  assert.deepEqual(await f.promise, { json, receivedHostMs: 100 });
  assert.deepEqual(f.child.kills, ["SIGTERM"]); clean(f);
});

test("timeout and cancellation stop the subscription once without retry", async () => {
  const timeout = fixture({ timeoutMs: 5 });
  await assert.rejects(timeout.promise, /deadline/); clean(timeout);
  const cancel = fixture(); cancel.controller.abort(Error("user cancelled"));
  cancel.child.stdout.write(JSON.stringify(event()) + "\n");
  await assert.rejects(cancel.promise, /user cancelled/); clean(cancel);
});

test("malformed logs, oversized lines, flood and stderr never authorize work", async () => {
  for (const input of ["garbage\n", "x".repeat(2049), "\n".repeat(129), "x".repeat(65537)]) {
    const f = fixture(); f.child.stdout.write(input);
    await assert.rejects(f.promise, /Malformed|limit/); clean(f);
  }
  const f = fixture(); f.child.stderr.write("device disconnected");
  await assert.rejects(f.promise, /stderr/); clean(f);
});

test("process failure and early close are terminal and detached", async () => {
  const failed = fixture(); failed.child.emit("error", Error("spawn failed"));
  await assert.rejects(failed.promise, /spawn failed/); clean(failed);
  const closed = fixture(); closed.child.emit("close", 1);
  await assert.rejects(closed.promise, /before matching/); clean(closed);
});

test("unconfirmed cleanup rejects even a matching event and escalates only its child", async () => {
  const f = fixture(); f.child.closeOnKill = false;
  f.child.stdout.write(JSON.stringify(event()) + "\n");
  await assert.rejects(f.promise, /cleanup not confirmed/);
  assert.deepEqual(f.child.kills, ["SIGTERM", "SIGKILL"]); clean(f);
});

test("subscription to preparation preserves receipt age including cleanup time", async () => {
  let ms = 100, reads = 0;
  const f = fixture({ now: () => ms });
  f.child.stdout.write(JSON.stringify(event()) + "\n");
  const log = await f.promise;
  const observer = createQueueObserver(target, { now: () => ms, verify: async () => identity,
    read: async () => { reads++; return { ...event(), phase: "state" } as never; } });
  ms = 351;
  assert.equal((await observer.prepare(log.json, f.controller.signal, () => true, log.receivedHostMs)).status, "stale-notice");
  assert.equal(reads, 0); clean(f);
});

test("fresh subscription prepares once; repeated notices cannot repeat the query", async () => {
  const f = fixture({ now: () => 100 });
  f.child.stdout.write(JSON.stringify(event()) + "\n");
  const log = await f.promise; let reads = 0;
  const observer = createQueueObserver(target, { now: () => 110, verify: async () => identity,
    read: async () => { reads++; return { ...event(), phase: "state" } as never; } });
  assert.equal((await observer.prepare(log.json, f.controller.signal, () => true, log.receivedHostMs)).status, "sample-reserved");
  assert.equal((await observer.prepare(log.json, f.controller.signal, () => true, log.receivedHostMs)).status, "already-attempted");
  assert.equal(reads, 1); clean(f);
});

test("invalid targets and pre-cancelled subscriptions never start adb", () => {
  let starts = 0;
  const start = () => { starts++; return new FakeLog() as never; };
  assert.throws(() => waitForQueueLog({ ...target, serial: "bad;command" }, new AbortController().signal, { start }));
  assert.throws(() => waitForQueueLog(target, new AbortController().signal, { start, timeoutMs: 6000 }));
  const controller = new AbortController(); controller.abort(Error("cancelled"));
  assert.throws(() => waitForQueueLog(target, controller.signal, { start }), /cancelled/);
  assert.equal(starts, 0);
});

test("cancellation after a matching line but before close discards the notice", async () => {
  const f = fixture(); f.child.closeOnKill = false;
  f.child.stdout.write(JSON.stringify(event()) + "\n");
  f.controller.abort(Error("cancel before cleanup"));
  f.child.emit("close", 0);
  await assert.rejects(f.promise, /cancel before cleanup/); clean(f);
});

test("real local subprocess pipes close before preparation, without executing adb", async () => {
  const controller = new AbortController(); let closed = false, starts = 0;
  const log = await waitForQueueLog(target, controller.signal, { now: () => 100, start: () => {
    starts++;
    const child = spawn(process.execPath, ["-e",
      `process.stdout.write(${JSON.stringify(JSON.stringify(event()) + "\n")}); setInterval(() => {}, 1000);`],
      { stdio: ["ignore", "pipe", "pipe"] });
    child.once("close", () => { closed = true; });
    return child;
  } });
  assert.equal(closed, true); assert.equal(starts, 1);
  const observer = createQueueObserver(target, { now: () => 120, verify: async () => identity,
    read: async () => ({ ...event(), phase: "state" }) as never });
  assert.equal((await observer.prepare(log.json, controller.signal, () => true, log.receivedHostMs)).status, "sample-reserved");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
