import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { providerCall, closeProviderSessions } from "../../electron/sdk/provider-session";
import type { ProviderSessionTiming } from "../../electron/sdk/provider-session-timing";
const mode = process.argv[2];
assert.ok(["abort", "probe-abort", "timeout", "events", "cold", "probe-timeout", "probe-invalid", "legacy", "timing-new", "timing-old", "timing-invalid", "timing-reject"].includes(mode));
const timingMode = mode.startsWith("timing-");
if (timingMode) process.env.PROVIDER_TIMING_FIXTURE = mode.slice(7);
const controller = new AbortController();
let connections = 0, replies = 0, late = false, oldClosed = false;
const sockets = new Set<net.Socket>();
const server = net.createServer(socket => {
  const generation = ++connections;
  sockets.add(socket);
  socket.on("close", () => { sockets.delete(socket); if (generation === 1) oldClosed = true; });
  socket.on("error", () => {});
  let buffer = "";
  socket.on("data", chunk => {
    buffer += chunk.toString();
    if (!buffer.includes("\n")) return;
    const request = JSON.parse(buffer.trim());
    buffer = "";
    if (request.method === "session-probe") {
      if (mode === "probe-abort" && generation === 1) {
        setTimeout(() => controller.abort(new Error("fixture cancel")), 10);
        setTimeout(() => { late = true; if (!socket.destroyed) socket.write("Result: Bundle[{error=Unknown session method}]\n"); }, 50);
        return;
      }
      const started = readFileSync(process.env.PROVIDER_FIXTURE_LOG!, "utf8").includes("open-session");
      if (mode === "legacy" || (mode === "cold" || timingMode) && !started) { socket.destroy(); return; }
      if (mode === "probe-timeout" && !started) return;
      socket.write(mode === "probe-invalid" && !started ? "Result: Bundle[{result=wrong}]\n" : "Result: Bundle[{error=Unknown session method}]\n");
      return;
    }
    if (["cold", "probe-timeout", "probe-invalid"].includes(mode) || timingMode) {
      replies++; socket.write("Result: Bundle[{result=ok}]\n"); return;
    }
    if (mode === "events") {
      const event = { event: "tree-ready", nonce: request.arg, pid: 42, processInstance: "11111111-1111-1111-1111-111111111111" };
      const lines = `Event: ${JSON.stringify({ ...event, nonce: "fedcba9876543210" })}\nEvent: ${JSON.stringify(event)}\nEvent: ${JSON.stringify(event)}\n`;
      socket.write(lines.slice(0, 13));
      setTimeout(() => socket.write(lines.slice(13)), 5);
      setTimeout(() => socket.write("Result: Bundle[{result=ok}]\n"), 25);
      return;
    }
    if (generation === 1) {
      if (mode === "abort") setTimeout(() => controller.abort(new Error("fixture cancel")), 10);
      setTimeout(() => { late = true; if (!socket.destroyed) socket.write("Result: Bundle[{nonce=old}]\n"); }, 150);
    } else { replies++; socket.write(`Result: Bundle[{nonce=${request.extras.nonce}}]\n`); }
  });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
process.env.PROVIDER_FIXTURE_PORT = String((server.address() as net.AddressInfo).port);
const adb = `${import.meta.dirname}/provider-session-adb`;
try {
  if (timingMode) {
    const diagnostic: { startedAt: number; timings: Record<string, number>; requestSessionTiming: boolean; sessionTiming?: ProviderSessionTiming } = {
      startedAt: performance.now(), timings: {}, requestSessionTiming: true,
    };
    const reply = await providerCall(adb, "session-fixture", "com.example.sessionfixture", "capture-refs", "TextView@a", null, 1000,
      false, undefined, undefined, diagnostic);
    assert.equal(reply.stdout.toString().trim(), "Result: Bundle[{result=ok}]");
    if (mode === "timing-reject") {
      assert.equal(diagnostic.sessionTiming, undefined);
      assert.deepEqual(diagnostic.timings, {}); assert.equal(replies, 0);
    } else {
      assert.equal(diagnostic.sessionTiming?.status, mode === "timing-new" ? "available" : mode === "timing-old" ? "unsupported" : "invalid");
      const next: typeof diagnostic = { startedAt: performance.now(), timings: {}, requestSessionTiming: true };
      await providerCall(adb, "session-fixture", "com.example.sessionfixture", "capture-refs", "TextView@a", null, 1000,
        false, undefined, undefined, next);
      assert.deepEqual(next.sessionTiming, diagnostic.sessionTiming, "keep connection's historical diagnostic");
      assert.equal(replies, 2, "diagnostics never replay real data requests");
    }
    await closeProviderSessions();
    const calls = readFileSync(process.env.PROVIDER_FIXTURE_LOG!, "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.equal(calls.filter(c => c.includes("sessionTiming:b:true")).length, 1);
    assert.equal(calls.filter(c => c[0] === "forward" && c[1] === "--remove").length, mode === "timing-reject" ? 1 : 2);
    assert.equal(calls.filter(c => c.includes("capture-refs")).length, mode === "timing-reject" ? 1 : 0);
    console.log(JSON.stringify({ passed: true, mode, lateIgnored: true }));
  } else
  if (["cold", "probe-timeout", "probe-invalid", "legacy"].includes(mode)) {
    const timings: Record<string, number> = {};
    const reply = await providerCall(adb, "session-fixture", "com.example.sessionfixture", "capture-refs", "TextView@a", null, 1000,
      false, undefined, undefined, { startedAt: performance.now(), timings });
    assert.equal(reply.stdout.toString().trim(), "Result: Bundle[{result=ok}]");
    await closeProviderSessions();
    const calls = readFileSync(process.env.PROVIDER_FIXTURE_LOG!, "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.equal(calls.filter(c => c.includes("open-session")).length, 1);
    assert.equal(calls.some(c => c.includes("sessionTiming:b:true")), false, "default never requests internal timing");
    assert.equal(calls.filter(c => c[0] === "forward" && c[1] === "--remove").length, 2);
    assert.equal(calls.filter(c => c.includes("capture-refs")).length, mode === "legacy" ? 1 : 0);
    assert.equal(replies, mode === "legacy" ? 0 : 1, "actual capture is never replayed");
    if (mode === "legacy") assert.deepEqual(timings, {});
    else {
      assert.equal(timings["SDK 当前连接启动服务"], 1);
      assert.ok(timings["SDK 当前连接建立耗时"] >= 0);
      assert.ok(timings["SDK 当前连接兼容启动"] >= 60, "bootstrap delay belongs to bootstrap, not probe");
      if (mode === "probe-timeout") assert.ok(timings["SDK 当前连接首次探测"] >= 480);
      const phases = ["SDK 当前连接首次探测", "SDK 当前连接兼容启动", "SDK 当前连接启动后核验"];
      const sum = phases.reduce((total, key) => { assert.ok(Number.isFinite(timings[key]) && timings[key] >= 0); return total + timings[key]; }, 0);
      assert.ok(Math.abs(sum - timings["SDK 当前连接建立耗时"]) <= 10, "connection phases must share the same scope");
    }
    console.log(JSON.stringify({ passed: true, mode, lateIgnored: true }));
  } else
  if (mode === "events") {
    let notified = 0;
    const timings: Record<string, number> = {};
    const startedAt = performance.now();
    const diagnostic: { startedAt: number; timings: Record<string, number>; requestSessionTiming: boolean; sessionTiming?: ProviderSessionTiming } = {
      startedAt, timings, requestSessionTiming: true,
    };
    const reply = await providerCall(adb, "session-fixture", "com.example.sessionfixture", "capture-visible", "0123456789abcdef",
      { withTree: true, treeReadyEvents: true }, 1000, false, controller.signal, value => {
        notified++; assert.equal(value.pid, 42); assert.equal(value.nonce, "0123456789abcdef");
        assert.ok(Number.isFinite(timings["SDK 会话就绪（调用内）"]));
        assert.ok(timings["SDK 会话就绪（调用内）"] <= Math.round(performance.now() - startedAt));
      }, diagnostic);
    assert.equal(reply.stdout.toString().trim(), "Result: Bundle[{result=ok}]"); assert.equal(notified, 1);
    assert.equal(timings["SDK 当前连接启动服务"], 0);
    assert.deepEqual(diagnostic.sessionTiming, { status: "not-started" }, "warm service never bootstraps just for diagnostics");
    assert.ok(timings["SDK 当前连接建立耗时"] >= 0);
    assert.equal(timings["SDK 当前连接兼容启动"], 0);
    assert.equal(timings["SDK 当前连接启动后核验"], 0);
    assert.ok(Math.abs(timings["SDK 当前连接首次探测"] - timings["SDK 当前连接建立耗时"]) <= 10);
    await closeProviderSessions();
    assert.ok(!readFileSync(process.env.PROVIDER_FIXTURE_LOG!, "utf8").includes("open-session"), "warm service needs no content bootstrap");
    console.log(JSON.stringify({ passed: true, mode, lateIgnored: true, events: notified }));
  } else {
  const first = providerCall(adb, "session-fixture", "com.example.sessionfixture", "capture-refs", "TextView@a", { nonce: "old" }, mode === "timeout" ? 20 : 1000, false, mode === "abort" || mode === "probe-abort" ? controller.signal : undefined);
  await assert.rejects(first, mode === "timeout" ? /会话调用超时/ : /fixture cancel/);
  const next = await providerCall(adb, "session-fixture", "com.example.sessionfixture", "capture-refs", "TextView@a", { nonce: "fresh" }, 1000);
  assert.equal(next.stdout.toString().trim(), "Result: Bundle[{nonce=fresh}]");
  await wait(180);
  assert.equal(oldClosed, true);
  assert.equal(late, true);
  assert.equal(connections, 2);
  assert.equal(replies, 1);
  closeProviderSessions();
  for (let i = 0; i < 30; i++) {
    if (readFileSync(process.env.PROVIDER_FIXTURE_LOG!, "utf8").split("\n").filter(l => l.includes("--remove")).length === 2) break;
    await wait(50);
  }
  const calls = readFileSync(process.env.PROVIDER_FIXTURE_LOG!, "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.equal(calls.filter(c => c[0] === "forward" && c[1] === "--remove").length, 2);
  assert.equal(calls.some(c => c.includes("--method") && c.includes("capture-refs")), false, "no content retry after cancellation");
  console.log(JSON.stringify({ passed: true, mode, connections, oldClosed, lateIgnored: true, recovered: true, forwardsRemoved: 2 }));
  }
} finally {
  closeProviderSessions();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
