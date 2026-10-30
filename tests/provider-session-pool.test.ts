import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createProviderSessionPool, type ProviderSessionDependencies, type ProviderSocket } from "../electron/sdk/provider-session";
import type { CommandResult } from "../electron/device/runtime";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const result = (text = ""): CommandResult => ({ code: 0, stdout: Buffer.from(text), stderr: "" });
class Socket extends EventEmitter implements ProviderSocket {
  destroyed = false;
  requests: string[] = [];
  autoReply = true;
  setNoDelay() {}
  write(line: string) {
    const { method } = JSON.parse(line); this.requests.push(method);
    if (method === "session-probe") queueMicrotask(() => this.reply("Result: Bundle[{error=Unknown session method}]"));
    else if (this.autoReply) queueMicrotask(() => this.reply("Result: Bundle[{result=ok}]"));
  }
  reply(line: string) { this.emit("data", Buffer.from(`${line}\n`)); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}
function fixture(overrides: Partial<ProviderSessionDependencies> = {}) {
  const sockets: Socket[] = [], commands: string[][] = [];
  let now = 0, sweep: (() => void) | undefined, timers = 0, cleared = 0;
  const pool = createProviderSessionPool({
    idleMs: 100, now: () => now, monotonicNow: () => now,
    setInterval: ((callback: () => void) => { sweep = callback; timers++; return { unref() {} }; }) as unknown as typeof setInterval,
    clearInterval: (() => { sweep = undefined; cleared++; }) as typeof clearInterval,
    connect: () => { const socket = new Socket(); sockets.push(socket); queueMicrotask(() => socket.emit("connect")); return socket; },
    runDeviceAdb: async (_adb, _serial, args) => { commands.push(args); return result(args[1] === "tcp:0" ? String(2000 + sockets.length) : ""); },
    runCommand: async () => { throw new Error("must not replay via content"); }, ...overrides,
  });
  const call = () => pool.call("adb", "serial", "app.pkg", "capture-refs", null, null, 1000);
  return { pool, call, sockets, commands, advance: (ms: number) => { now += ms; sweep?.(); }, timers: () => timers, cleared: () => cleared };
}

test("pool factory owns its timer; concurrent opens share one connection, disposal is final and idempotent", async () => {
  const h = fixture(); assert.equal(h.timers(), 1); assert.equal(h.sockets.length, 0);
  await Promise.all([h.call(), h.call(), h.pool.open("adb", "serial", "app.pkg")]);
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(h.sockets[0].requests, ["session-probe", "capture-refs", "capture-refs"]);
  const done = h.pool.dispose(); assert.equal(done, h.pool.dispose()); await done;
  assert.equal(h.cleared(), 1); assert.equal(h.sockets[0].destroyed, true);
  assert.equal(h.commands.filter(args => args[1] === "--remove").length, 1);
  await assert.rejects(h.call(), /池已关闭/); await assert.rejects(h.pool.open("adb", "serial", "app.pkg"), /池已关闭/);
});

test("disposing while adb forward is opening removes the eventual port without connecting or bootstrapping", async () => {
  const forward = deferred<CommandResult>(); const commands: string[][] = [];
  const h = fixture({ runDeviceAdb: async (_adb, _serial, args) => { commands.push(args); return args[1] === "tcp:0" ? forward.promise : result(); } });
  const opening = h.pool.open("adb", "serial", "app.pkg"); await flush();
  let finished = false; const disposal = h.pool.dispose(); void disposal.then(() => { finished = true; });
  await flush(); assert.equal(finished, false);
  forward.resolve(result("2913")); assert.equal(await opening, null); await disposal;
  assert.deepEqual(commands.map(args => args.slice(0, 2)), [["forward", "tcp:0"], ["forward", "--remove"]]);
  assert.equal(h.sockets.length, 0);
});

test("release-all aborts pending requests, waits cleanup, then permits a fresh connection", async () => {
  const h = fixture(); await h.call(); h.sockets[0].autoReply = false;
  const pending = h.call(); const canceled = assert.rejects(pending, /释放|关闭|断开/); await flush();
  const released = h.pool.releaseAll(); assert.equal(released, h.pool.releaseAll());
  const next = h.call(); await canceled; await released; await next;
  assert.equal(h.sockets.length, 2); assert.equal(h.sockets[0].destroyed, true); assert.equal(h.sockets[1].destroyed, false);
  h.sockets[0].reply("Result: Bundle[{result=late}]"); await h.call();
  assert.equal(h.sockets.length, 2, "old socket events cannot evict its replacement");
  await h.pool.dispose();
});

test("idle reclamation uses the injected clock and skips active waiters", async () => {
  const h = fixture(); await h.call(); h.sockets[0].autoReply = false;
  const pending = h.call(); await flush(); h.advance(101); await flush(); assert.equal(h.sockets[0].destroyed, false);
  h.sockets[0].reply("Result: Bundle[{result=ok}]"); await pending;
  h.advance(99); await flush(); assert.equal(h.sockets[0].destroyed, false);
  h.advance(1); await flush(); assert.equal(h.sockets[0].destroyed, true);
  await h.call(); assert.equal(h.sockets.length, 2); await h.pool.dispose();
});

test("separate owners never share support decisions, sockets, timers or disposal", async () => {
  const first = fixture(), second = fixture(); await first.call(); await second.call();
  await first.pool.dispose(); assert.equal(first.sockets[0].destroyed, true); assert.equal(second.sockets[0].destroyed, false);
  await second.call(); assert.equal(second.sockets.length, 1); await second.pool.dispose();
});

test("business transport failure is never replayed as a content command", async () => {
  const h = fixture(); await h.call(); h.sockets[0].autoReply = false;
  const pending = h.call(); const failed = assert.rejects(pending, /断开/); await flush(); h.sockets[0].destroy(); await failed;
  assert.equal(h.sockets[0].requests.filter(method => method === "capture-refs").length, 2);
  await h.call(); assert.equal(h.sockets.length, 2); await h.pool.dispose();
});

test("disposal during compatibility startup waits for startup but never creates a later connection", async () => {
  const bootstrap = deferred<CommandResult>(); let opened = 0, bootstrapStarted = false, removed = 0;
  const h = fixture({ runDeviceAdb: async (_adb, _serial, args) => {
    if (args[1] === "tcp:0") { opened++; return result("2900"); }
    if (args[1] === "--remove") { removed++; return result(); }
    bootstrapStarted = true; return bootstrap.promise;
  }, connect: () => { throw new Error("service is not ready"); } });
  const pending = h.pool.open("adb", "serial", "app.pkg"); await flush(); assert.equal(bootstrapStarted, true);
  let complete = false; const disposal = h.pool.dispose(); void disposal.then(() => { complete = true; });
  await flush(); assert.equal(complete, false); bootstrap.resolve(result("Result: Bundle[{result=ok}]"));
  assert.equal(await pending, null); await disposal; assert.equal(opened, 1); assert.equal(removed, 1);
});

test("session deadlines use injected timers, reject once and do not consume a late reply", async () => {
  const scheduled = new Map<ReturnType<typeof setTimeout>, { callback: () => void; ms: number }>();
  const h = fixture({ setTimeout: ((callback: () => void, ms: number) => {
    const token = setTimeout(() => {}, 60_000); scheduled.set(token, { callback, ms }); return token;
  }) as typeof setTimeout, clearTimeout: token => { scheduled.delete(token as ReturnType<typeof setTimeout>); clearTimeout(token); } });
  try {
    await h.call(); assert.equal(scheduled.size, 0);
    h.sockets[0].autoReply = false; const pending = h.call(); const failed = assert.rejects(pending, /调用超时/); await flush();
    assert.equal(scheduled.size, 1); const timer = [...scheduled.values()][0]; assert.equal(timer.ms, 1000); timer.callback();
    await failed; assert.equal(scheduled.size, 0); h.sockets[0].reply("Result: Bundle[{result=late}]");
    await h.call(); assert.equal(h.sockets.length, 2); assert.equal(scheduled.size, 0);
  } finally { await h.pool.dispose(); for (const timer of scheduled.keys()) clearTimeout(timer); }
});

test("legacy support cache stays inside its owner and fallback work is joined on disposal", async () => {
  const reply = deferred<CommandResult>(); let fallbackCalls = 0, forwards = 0;
  const h = fixture({ runDeviceAdb: async (_adb, _serial, args) => {
    if (args[1] === "tcp:0") { forwards++; return result("invalid"); } return result("unsupported");
  }, runCommand: async (_adb, args) => {
    fallbackCalls++; assert.equal(args.includes("capture-refs"), true); return reply.promise;
  } });
  const pending = h.call(); const canceled = assert.rejects(pending, /释放/); await flush(); assert.equal(fallbackCalls, 1);
  let complete = false; const disposal = h.pool.dispose(); void disposal.then(() => { complete = true; });
  await flush(); assert.equal(complete, false); reply.resolve(result("late")); await canceled; await disposal;
  assert.equal(forwards, 1); assert.equal(fallbackCalls, 1);
});
