import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { createQueueDeviceAdapters, type QueueDeviceExecute } from "../scripts/diagnostics/sdk/sdk-queue-device";
import { createQueueObservation, type ObservationTarget } from "../scripts/diagnostics/sdk/sdk-queue-observation";
import type { QueueEvent } from "../scripts/diagnostics/sdk/sdk-queue-observer";
import { createQueueObserver } from "../scripts/diagnostics/sdk/sdk-queue-observer";
import { verifyQueueProcess } from "../scripts/diagnostics/sdk/sdk-queue-identity";

const target: ObservationTarget = { serial: "fixture", packageName: "example.app", pid: 42, startTicks: "12345",
  processInstance: "22222222-2222-2222-2222-222222222222", requestId: "11111111-1111-1111-1111-111111111111",
  apkPath: "/fixture/app.apk", aarPath: "/fixture/sdk.aar" };
const identity = { apkSha256: "a".repeat(64), sdkVersion: `sdk-source-v1:${"b".repeat(64)}`, pid: 42,
  startTicks: "12345", processInstance: target.processInstance, requestId: target.requestId };
const options = { identity, treeQueueDiagnostics: true as const };
const runtimeTarget = { ...target, sourceSha256: "b".repeat(64) };
const runtimeReply = `Result: Bundle[{result=ok, protocol=sdk-source-v1, sourceSha256=${runtimeTarget.sourceSha256}, pid=42, processInstance=${target.processInstance}}]`;
const queueState = (patch: Partial<QueueEvent> = {}): QueueEvent => ({ event: "tree-queue", protocol: "tree-queue-v1", phase: "state",
  requestId: target.requestId, kind: "classic", pid: 42, processInstance: target.processInstance,
  postedMs: 100000, enteredMs: -1, endedMs: -1, settledMs: -1, observedMs: 100620, ...patch });
const stateReply = (state = queueState()) => `Result: Bundle[{result=ok, diagnostic=${JSON.stringify(state)}}]`;
type Request = { method: string; arg: string | null; extras: Record<string, boolean | string> };

function fixture(actual = target) {
  const controller = new AbortController(), commands: string[][] = [], mappings = new Map<number, string>();
  const foreign = "other-device tcp:1234 jdwp:999\nfixture tcp:9999 jdwp:888";
  const requests: Request[] = [], sockets = new Set<Socket>(), servers: Server[] = [];
  let stage: ((args: string[]) => void) | undefined, port = 12000;
  let captureSocket: Socket | undefined;
  let reply = actual.requestId.length === 16
    ? `Result: Bundle[{result=ok, nonce=${actual.requestId}, processInstance=${actual.processInstance}, tree=ok}]`
    : "Result: Bundle[{result=ok}]";
  let probeReply: string | null = "Result: Bundle[{error=Unknown session method}]";
  let onCapture: ((request: Request, socket: Socket) => void) | undefined;
  let onRead: ((request: Request, socket: Socket) => void) | undefined;
  const execute: QueueDeviceExecute = async (args, timeout, signal) => {
    assert.ok(timeout > 0 && timeout <= 1500); assert.deepEqual(args.slice(0, 2), ["-s", "fixture"]);
    commands.push(args.slice(2)); const operation = args.slice(2);
    if (operation[0] === "shell") {
      signal?.throwIfAborted();
      assert.deepEqual(operation, ["shell", "content", "call", "--uri", "content://example.app.inspector", "--method", "open-session"]);
      stage?.(operation);
      return "Result: Bundle[{result=ok, socket=example.app.inspector.session}]";
    }
    assert.equal(operation[0], "forward"); assert.equal(signal, undefined, "resource cleanup must survive caller abort");
    if (operation[1] === "--list") {
      stage?.(operation);
      return foreign + "\n" + [...mappings].map(([port, remote]) => `fixture tcp:${port} ${remote}`).join("\n");
    }
    if (operation[1] === "--remove") {
      const selected = Number(operation[2].slice(4)); assert.notEqual(selected, 9999);
      mappings.delete(selected); stage?.(operation); return "";
    }
    const norebind = operation[1] === "--no-rebind", local = operation[norebind ? 2 : 1], remote = operation[norebind ? 3 : 2];
    const selected = Number(local.slice(4));
    if (norebind && mappings.has(selected)) throw Error("port collision");
    mappings.set(selected, remote); stage?.(operation); return "";
  };
  const choosePort = async () => ++port;
  const cleanup = async () => {
    for (const socket of sockets) socket.destroy();
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
  };
  const listen = async (receive: (socket: Socket) => void) => {
    const server = createServer(socket => {
      sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {}); receive(socket);
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port;
  };
  const sdkServer = () => listen(socket => {
    let buffer = "";
    socket.on("data", data => {
      buffer += data.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const request: Request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); requests.push(request);
        if (request.method === "session-probe") { if (probeReply !== null) socket.write(probeReply + "\n"); continue; }
        if (request.method.startsWith("read-")) {
          if (onRead) onRead(request, socket); else socket.write((request.method === "read-sdk-build" ? runtimeReply : stateReply()) + "\n");
          continue;
        }
        captureSocket = socket;
        if (onCapture) onCapture(request, socket); else socket.write(reply + "\n");
      }
    });
  });
  return { controller, commands, mappings, requests, cleanup, listen, sdkServer, execute, choosePort,
    setStage: (hook: typeof stage) => { stage = hook; }, setReply: (value: string) => { reply = value; },
    setProbe: (value: string | null) => { probeReply = value; }, setCapture: (hook: typeof onCapture) => { onCapture = hook; },
    setRead: (hook: typeof onRead) => { onRead = hook; },
    replyCapture: () => { assert.ok(captureSocket); captureSocket.write(reply + "\n"); },
    adapters: (sdkPort?: number, extra = {}) => createQueueDeviceAdapters(actual, { execute, choosePort,
      ...(sdkPort ? { connect: () => createConnection({ host: "127.0.0.1", port: sdkPort }) } : {}), ...extra }) };
}

test("adapter construction and rejected targets have no adb/socket side effects", async () => {
  const f = fixture(), adapters = f.adapters(); assert.deepEqual(f.commands, []);
  await assert.rejects(adapters.forward.open({ ...target, pid: 99 }, f.controller.signal), /target changed/);
  await assert.rejects(adapters.forward.remove(9999), /unowned/);
  assert.deepEqual(f.commands, []);
  assert.throws(() => createQueueDeviceAdapters({ ...target, requestId: "bad" }));
  assert.throws(() => createQueueDeviceAdapters(target, { captureTimeoutMs: 10001 }));
  await assert.rejects(adapters.readRuntime(runtimeTarget, f.controller.signal), /not prepared/);
  await assert.rejects(adapters.readState({ ...target, identity }, f.controller.signal), /not prepared/);
  assert.deepEqual(f.commands, []);
});

test("independent scalar session reads beside a pending capture, with no content query or third client", async t => {
  const f = fixture(); t.after(f.cleanup); const port = await f.sdkServer();
  const reader = f.adapters(port), capture = f.adapters(port);
  t.after(reader.closeCapture); t.after(capture.closeCapture);
  await reader.prepareCapture(target, f.controller.signal); await capture.prepareCapture(target, f.controller.signal);
  let started!: () => void;
  const sent = new Promise<void>(resolve => { started = resolve; });
  f.setCapture(() => started());
  const pending = capture.captureOnce(target, options, f.controller.signal); await sent;
  assert.deepEqual(await reader.readRuntime(runtimeTarget, f.controller.signal),
    { pid: 42, processInstance: target.processInstance, sdkVersion: identity.sdkVersion });
  assert.deepEqual(await reader.readState({ ...target, identity }, f.controller.signal), queueState());
  assert.deepEqual(f.requests.slice(3), [
    { method: "read-sdk-build", arg: null, extras: { processInstance: target.processInstance } },
    { method: "read-tree-task", arg: target.requestId, extras: { processInstance: target.processInstance } },
  ]);
  await assert.rejects(capture.readState({ ...target, identity }, f.controller.signal), /independent/);
  await assert.rejects(reader.captureOnce(target, options, f.controller.signal), /independent/);
  assert.equal(f.commands.filter(args => args[0] === "shell").length, 2, "only two session bootstraps");
  f.replyCapture(); await pending;
  await reader.closeCapture(); await capture.closeCapture(); assert.equal(f.mappings.size, 0);
});

test("scalar target mismatches are rejected before socket writes; concurrent reads do not queue", async t => {
  const f = fixture(); t.after(f.cleanup); const reader = f.adapters(await f.sdkServer()); t.after(reader.closeCapture);
  await reader.prepareCapture(target, f.controller.signal);
  for (const patch of [{ serial: "other" }, { packageName: "other.app" }, { pid: 43 },
    { processInstance: "33333333-3333-3333-3333-333333333333" }, { sourceSha256: "unknown" }])
    await assert.rejects(reader.readRuntime({ ...runtimeTarget, ...patch }, f.controller.signal), /target changed/);
  for (const patch of [{ pid: 43 }, { startTicks: "12346" }, { requestId: "33333333-3333-3333-3333-333333333333" },
    { processInstance: "33333333-3333-3333-3333-333333333333" }, { sdkVersion: "unknown" }])
    await assert.rejects(reader.readState({ ...target, identity: { ...identity, ...patch } }, f.controller.signal));
  assert.equal(f.requests.length, 1);
  let release!: () => void, started!: () => void;
  const sent = new Promise<void>(resolve => { started = resolve; });
  f.setRead((_, socket) => { release = () => socket.write(runtimeReply + "\n"); started(); });
  const first = reader.readRuntime(runtimeTarget, f.controller.signal); await sent;
  await assert.rejects(reader.readState({ ...target, identity }, f.controller.signal), /already pending/);
  assert.equal(f.requests.length, 2); release(); await first;
  assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
});

test("failed scalar reads retire their own socket/forward; late replies cannot validate another query", async t => {
  for (const method of ["runtime", "state"] as const) {
    for (const mode of ["old-sdk", "timeout", "cancel", "disconnect", "oversize", "double-reply", "wrong-identity", "wrong-protocol", "wrong-kind"]) {
      if (method === "runtime" && mode === "wrong-kind") continue;
      const f = fixture(); t.after(f.cleanup); const port = await f.sdkServer();
      const reader = f.adapters(port); t.after(reader.closeCapture);
      const other = createConnection({ host: "127.0.0.1", port }); t.after(() => other.destroy());
      await new Promise<void>(resolve => other.once("connect", resolve));
      await reader.prepareCapture(target, f.controller.signal);
      const normal = method === "runtime" ? runtimeReply : stateReply();
      f.setRead((_, socket) => {
        if (mode === "timeout") return;
        if (mode === "cancel") { f.controller.abort(Error("cancel scalar read")); return; }
        if (mode === "disconnect") { socket.destroy(); return; }
        if (mode === "oversize") { socket.write("x".repeat(9000)); return; }
        const reply = mode === "old-sdk" ? "Result: Bundle[{error=Unknown session method}]"
          : mode === "double-reply" ? normal + "\n" + normal
          : mode === "wrong-identity" ? normal.replace("pid=42", "pid=43").replace('"pid":42', '"pid":43')
          : mode === "wrong-protocol" ? normal.replace("source-v1", "source-v2").replace("queue-v1", "queue-v2")
          : mode === "wrong-kind" ? stateReply(queueState({ kind: "merged", requestId: "0123456789abcdef" })) : normal;
        socket.write(reply + "\n");
      });
      const read = () => method === "runtime" ? reader.readRuntime(runtimeTarget, f.controller.signal)
        : reader.readState({ ...target, identity }, f.controller.signal);
      await assert.rejects(read());
      assert.equal(f.mappings.size, 0, "reader owns and closes only its forward");
      assert.equal(other.destroyed, false); assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
      await assert.rejects(reader.readRuntime(runtimeTarget, new AbortController().signal), /not prepared/);
      assert.equal(f.requests.length, 2, "one probe and one read, never retried or replaced by content");
      assert.equal(f.commands.filter(args => args[0] === "shell").length, 1);
    }
  }
});

test("fast session reads do not refresh an expired notice or authorize an already entered UI task", async t => {
  for (const stale of [true, false]) {
    const f = fixture(); t.after(f.cleanup); const reader = f.adapters(await f.sdkServer()); t.after(reader.closeCapture);
    await reader.prepareCapture(target, f.controller.signal);
    let host = 1000;
    if (!stale) f.setRead((request, socket) => socket.write((request.method === "read-sdk-build"
      ? runtimeReply : stateReply(queueState({ enteredMs: 100610 }))) + "\n"));
    const observer = createQueueObserver({ ...target, identity }, { now: () => host, read: reader.readState,
      verify: async signal => {
        await reader.readRuntime(runtimeTarget, signal); if (stale) host += 251;
        return identity;
      } });
    const result = await observer.prepare(JSON.stringify(queueState({ phase: "queued", observedMs: 100600 })),
      f.controller.signal, () => true, 1000);
    assert.equal(result.status, stale ? "stale-notice" : "task-not-queued");
    assert.equal(f.requests.filter(request => request.method === "read-tree-task").length, stale ? 0 : 1);
  }
});

test("known marker reservation binds once and removes only its unchanged owned forward", async () => {
  const f = fixture(), adapters = f.adapters();
  const port = await adapters.forward.open(target, f.controller.signal);
  assert.equal(f.mappings.get(port), "jdwp:42");
  const reserve = f.commands.find(args => args[1] === "--no-rebind");
  assert.ok(reserve?.[3].startsWith("localabstract:inspector.queue."));
  await adapters.forward.remove(port); await adapters.forward.remove(port);
  assert.equal(f.mappings.size, 0); assert.equal(f.commands.filter(args => args[1] === "--remove").length, 1);
  await assert.rejects(adapters.forward.open(target, f.controller.signal), /already attempted/);
});

test("lost reservation/binding replies and cancellation recover the known self-owned port", async () => {
  for (const mode of ["reserve", "bind", "cancel"]) {
    const f = fixture(), adapters = f.adapters();
    f.setStage(args => {
      if (mode === "reserve" && args[1] === "--no-rebind") throw Error("lost reservation reply");
      if (mode === "bind" && args[1] === "tcp:12001") throw Error("lost bind reply");
      if (mode === "cancel" && args[1] === "--no-rebind") f.controller.abort(Error("cancel forward"));
    });
    await assert.rejects(adapters.forward.open(target, f.controller.signal), /lost|cancel forward/);
    assert.equal(f.mappings.size, 0); assert.equal(f.commands.filter(args => args[1] === "--remove").length, 1);
    assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  }
});

test("pre-existing mappings and observed external replacements are refused without removal", async () => {
  const occupied = fixture(); occupied.mappings.set(12001, "jdwp:777");
  await assert.rejects(occupied.adapters().forward.open(target, occupied.controller.signal), /already in use/);
  assert.equal(occupied.mappings.get(12001), "jdwp:777"); assert.equal(occupied.commands.length, 1);
  const f = fixture(), adapters = f.adapters();
  const port = await adapters.forward.open(target, f.controller.signal); f.mappings.set(port, "jdwp:777");
  await assert.rejects(adapters.forward.remove(port), /changed; refusing removal/);
  assert.equal(f.mappings.get(port), "jdwp:777"); assert.equal(f.commands.some(args => args[1] === "--remove"), false);
  for (const after of ["reservation", "binding"]) {
    const changed = fixture();
    changed.setStage(args => {
      if (after === "reservation" ? args[1] === "--no-rebind" : args[1] === "tcp:12001")
        changed.mappings.set(12001, "jdwp:777");
    });
    await assert.rejects(changed.adapters().forward.open(target, changed.controller.signal), /identity changed.*refusing removal/);
    assert.equal(changed.mappings.get(12001), "jdwp:777");
    assert.equal(changed.commands.some(args => args[1] === "--remove"), false);
    if (after === "reservation") assert.equal(changed.commands.some(args => args[1] === "tcp:12001"), false);
  }
});

test("remove response loss is confirmed by absence; a remaining mapping is a cleanup failure without retry", async () => {
  for (const remains of [false, true]) {
    const f = fixture(), adapters = f.adapters();
    const port = await adapters.forward.open(target, f.controller.signal);
    f.setStage(args => {
      if (args[1] === "--remove") { if (remains) f.mappings.set(port, "jdwp:42"); throw Error("lost remove reply"); }
    });
    if (remains) {
      await assert.rejects(adapters.forward.remove(port), /cleanup not confirmed/);
      await assert.rejects(adapters.forward.remove(port), /cleanup not confirmed/);
    } else await adapters.forward.remove(port);
    assert.equal(f.commands.filter(args => args[1] === "--remove").length, 1);
  }
});

test("classic and merged requests reuse the SDK session dispatcher with the exact ID/instance and no fallback", async t => {
  for (const requestId of [target.requestId, "0123456789abcdef"]) {
    const actual = { ...target, requestId }, f = fixture(actual); t.after(f.cleanup);
    const adapters = f.adapters(await f.sdkServer());
    await adapters.prepareCapture(actual, f.controller.signal);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, "session-probe");
    await adapters.captureOnce(actual, { ...options, identity: { ...identity, requestId } }, f.controller.signal);
    assert.deepEqual(f.requests[1], { method: requestId.length === 16 ? "capture-visible" : "capture", arg: requestId,
      extras: { treeQueueDiagnostics: true, processInstance: target.processInstance, ...(requestId.length === 16 ? { withTree: true } : {}) } });
    await assert.rejects(adapters.captureOnce(actual, { ...options, identity: { ...identity, requestId } }, f.controller.signal), /already attempted/);
    await adapters.closeCapture(); await adapters.closeCapture(); assert.equal(f.mappings.size, 0);
    assert.equal(f.commands.filter(args => args[0] === "shell").length, 1);
    assert.equal(f.requests.length, 2); assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  }
});

test("bootstrap/probe failure stops before a capture and cleans any prepared forward", async t => {
  for (const mode of ["bootstrap", "probe"]) {
    const f = fixture(); t.after(f.cleanup);
    if (mode === "bootstrap") f.setStage(args => { if (args[0] === "shell") throw Error("bootstrap denied"); });
    else f.setProbe("Result: Bundle[{result=ok}]");
    const adapters = f.adapters(await f.sdkServer());
    await assert.rejects(adapters.prepareCapture(target, f.controller.signal), /denied|probe rejected/);
    await adapters.closeCapture(); assert.equal(f.mappings.size, 0);
    assert.equal(f.requests.some(request => request.method !== "session-probe"), false);
  }
});

test("an SDK connection blocked by another client stops boundedly without closing that client", async t => {
  const f = fixture(); t.after(f.cleanup); f.setProbe(null);
  const port = await f.sdkServer(), other = createConnection({ host: "127.0.0.1", port });
  t.after(() => other.destroy()); await new Promise<void>(resolve => other.once("connect", resolve));
  const adapters = f.adapters(port), started = performance.now();
  await assert.rejects(adapters.prepareCapture(target, f.controller.signal), /会话调用超时/);
  assert.ok(performance.now() - started < 2000);
  await adapters.closeCapture(); assert.equal(f.mappings.size, 0);
  assert.equal(other.destroyed, false); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, "session-probe");
});

test("invalid binding and pre-cancellation send no capture data", async t => {
  for (const cancel of [false, true]) {
    const f = fixture(); t.after(f.cleanup); const adapters = f.adapters(await f.sdkServer());
    await adapters.prepareCapture(target, f.controller.signal);
    if (cancel) f.controller.abort(Error("cancel capture"));
    await assert.rejects(adapters.captureOnce(target, { ...options, identity: { ...identity, pid: cancel ? 42 : 99 } }, f.controller.signal), /cancel capture|binding changed/);
    await adapters.closeCapture(); assert.equal(f.mappings.size, 0); assert.equal(f.requests.length, 1);
  }
});

test("timeout/cancel/disconnect/bad or oversized replies cannot replay or claim success", async t => {
  for (const mode of ["timeout", "cancel", "disconnect", "oversize", "error", "duplicate", "wrong-instance", "double-reply"]) {
    const actual = { ...target, requestId: "0123456789abcdef" }, f = fixture(actual); t.after(f.cleanup);
    if (mode === "disconnect") f.setCapture((_, socket) => socket.destroy());
    if (mode === "oversize") f.setCapture((_, socket) => socket.write("x".repeat(9000)));
    if (mode === "timeout" || mode === "cancel") f.setCapture(() => {});
    if (mode === "error") f.setReply("Result: Bundle[{error=View tree timed out, tree=failed, treeFailure=ui-timeout}]");
    if (mode === "duplicate") f.setReply(`Result: Bundle[{result=ok, result=ok, nonce=${actual.requestId}, tree=ok, processInstance=${actual.processInstance}}]`);
    if (mode === "wrong-instance") f.setReply(`Result: Bundle[{result=ok, nonce=${actual.requestId}, tree=ok, processInstance=33333333-3333-3333-3333-333333333333}]`);
    if (mode === "double-reply") f.setReply(`Result: Bundle[{result=ok, nonce=${actual.requestId}, tree=ok, processInstance=${actual.processInstance}}]\nResult: Bundle[{result=ok}]`);
    const adapters = f.adapters(await f.sdkServer(), { captureTimeoutMs: mode === "timeout" ? 20 : 500 });
    await adapters.prepareCapture(actual, f.controller.signal);
    const capture = adapters.captureOnce(actual, { ...options, identity: { ...identity, requestId: actual.requestId } }, f.controller.signal);
    const rejected = assert.rejects(capture);
    if (mode === "cancel") f.controller.abort(Error("cancel after send"));
    await rejected; await adapters.closeCapture();
    assert.ok(f.requests.filter(request => request.method !== "session-probe").length <= 1);
    assert.equal(f.mappings.size, 0); assert.equal(f.commands.filter(args => args[0] === "shell").length, 1);
    assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  }
});

test("complete observation uses an independent fast reader, system process bracket and capture/JDWP cleanup", async t => {
  for (const mode of ["success", "cancel-frames", "cleanup-failure"]) {
  const cancelFrames = mode === "cancel-frames";
  const f = fixture(); t.after(f.cleanup);
  const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
  const string = (s: string) => Buffer.concat([int(Buffer.byteLength(s)), Buffer.from(s)]);
  let suspended = 0, pauses = 0;
  const jdwpPort = await f.listen(socket => {
    let buffer = Buffer.alloc(0), handshake = true;
    socket.on("data", data => {
      buffer = Buffer.concat([buffer, data]);
      if (handshake) {
        if (buffer.length < 14) return; assert.equal(buffer.subarray(0, 14).toString(), "JDWP-Handshake");
        buffer = buffer.subarray(14); handshake = false; socket.write("JDWP-Handshake");
      }
      while (buffer.length >= 11) {
        const length = buffer.readUInt32BE(); if (buffer.length < length) return;
        const packet = buffer.subarray(0, length); buffer = buffer.subarray(length);
        const set = packet[9], command = packet[10]; let data = Buffer.alloc(0);
        if (set === 1 && command === 7) data = Buffer.concat(Array(5).fill(int(4)));
        if (set === 1 && command === 4) data = Buffer.concat([int(1), int(7)]);
        if (set === 11 && command === 1) data = string("main");
        if (set === 11 && command === 2) { suspended++; pauses++; }
        if (set === 11 && command === 3) suspended--;
        if (set === 11 && command === 12) data = int(suspended);
        if (set === 11 && command === 7) data = int(1);
        if (set === 11 && command === 6) {
          data = Buffer.concat([int(1), int(9), Buffer.from([1]), int(10), int(11), Buffer.alloc(8)]);
          if (cancelFrames) f.controller.abort(Error("cancel during actual frames"));
        }
        if (set === 2 && command === 1) data = string("Lexample/Main;");
        if (set === 2 && command === 5) data = Buffer.concat([int(1), int(11), string("work"), string("()V"), int(1)]);
        const reply = Buffer.alloc(11 + data.length); reply.writeUInt32BE(reply.length); reply.writeUInt32BE(packet.readUInt32BE(4), 4);
        reply[8] = 0x80; data.copy(reply, 11); socket.write(reply);
      }
    });
  });
  const sdkPort = await f.sdkServer(), ports = [sdkPort, jdwpPort];
  if (mode === "cleanup-failure") f.setStage(args => {
    if (args[1] === "--remove" && args[2] === `tcp:${sdkPort}`) {
      f.mappings.set(sdkPort, `localabstract:${target.packageName}.inspector.session`); throw Error("SDK forward cleanup failed");
    }
  });
  const adapters = f.adapters(sdkPort, { choosePort: async () => ports.shift()! });
  const reader = f.adapters(sdkPort); t.after(reader.closeCapture);
  await reader.prepareCapture(target, f.controller.signal);
  const state = queueState;
  let notified!: (notice: { json: string; receivedHostMs: number }) => void, reads = 0;
  f.setCapture(() => notified({ json: JSON.stringify(state({ phase: "queued", observedMs: 100600 })), receivedHostMs: 100 }));
  f.setRead((request, socket) => {
    if (request.method === "read-sdk-build") { socket.write(runtimeReply + "\n"); return; }
    const count = ++reads;
    if (count > 1) assert.equal(suspended, 0);
    if (count === 2) f.replyCapture();
    socket.write(stateReply(count === 1 ? state() : count === 2 ? state({ observedMs: 100700 })
      : state({ observedMs: 103100, enteredMs: 100800, endedMs: 100900, settledMs: 103000 })) + "\n");
  });
  const observation = createQueueObservation(target, { ...adapters, now: () => 110,
    artifacts: async () => ({ apkSha256: identity.apkSha256, sdkVersion: identity.sdkVersion, sourceSha256: "b".repeat(64), aarSha256: "c".repeat(64) }),
    installed: async () => ({ apkSha256: identity.apkSha256, installedPath: "/data/app/fixture/base.apk" }),
    process: (actual, signal) => verifyQueueProcess(actual, signal, async () => {
      const fields = Array(25).fill("0"); fields[0] = "S"; fields[19] = "12345";
      const stat = `42 (fixture) ${fields.join(" ")}\n`;
      return Buffer.from(`${stat}example.app\0${stat}`);
    }),
    runtime: reader.readRuntime,
    subscribe: async () => {
      assert.equal(f.requests.length, 3, "reader probe/runtime and capture probe complete before subscribing");
      return new Promise(resolve => { notified = resolve; });
    },
    state: reader.readState });
  const report = await observation.run(f.controller.signal);
  assert.equal(report.status, mode === "success" ? "queue-covered" : "observation-failed");
  assert.equal(report.capture?.status, cancelFrames ? "failed" : "completed");
  assert.equal(report.cleanup.resumeVerified, true); assert.equal(report.cleanup.forwardRemoved, true);
  assert.equal(report.cleanup.captureConnectionClosed, mode !== "cleanup-failure");
  if (!cancelFrames) assert.equal(report.symbols?.[0].method?.name, "work");
  else assert.match(report.error ?? "", /cancel during actual frames/);
  assert.equal(suspended, 0); assert.equal(pauses, 1); assert.equal(reads, cancelFrames ? 1 : 3);
  assert.equal(f.requests.filter(request => request.method === "capture").length, 1);
  await reader.closeCapture();
  assert.equal(f.mappings.size, mode === "cleanup-failure" ? 1 : 0);
  if (mode === "cleanup-failure") assert.match(report.error ?? "", /Capture connection cleanup not confirmed/);
  assert.equal(f.commands.filter(args => args[1] === "--remove").length, 3);
  assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  }
});
