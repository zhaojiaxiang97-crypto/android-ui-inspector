import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { createQueueObservation, type ObservationTarget } from "../scripts/diagnostics/sdk/sdk-queue-observation";
import { waitForQueueLog, QueueLogCleanupError } from "../scripts/diagnostics/sdk/sdk-queue-log";
import { type QueueEvent } from "../scripts/diagnostics/sdk/sdk-queue-observer";

type Dependencies = Parameters<typeof createQueueObservation>[1];
const target: ObservationTarget = { serial: "fixture", packageName: "example.app", pid: 42, startTicks: "12345",
  processInstance: "22222222-2222-2222-2222-222222222222", requestId: "11111111-1111-1111-1111-111111111111",
  apkPath: "/fixture/app.apk", aarPath: "/fixture/sdk.aar" };
const sourceSha256 = "b".repeat(64), apkSha256 = "a".repeat(64), sdkVersion = `sdk-source-v1:${sourceSha256}`;
const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const string = (s: string) => Buffer.concat([int(Buffer.byteLength(s)), Buffer.from(s)]);
const event = (patch: Partial<QueueEvent> = {}): QueueEvent => ({ event: "tree-queue", protocol: "tree-queue-v1", phase: "state",
  requestId: target.requestId, kind: "classic", pid: 42, processInstance: target.processInstance, postedMs: 100000,
  enteredMs: -1, endedMs: -1, settledMs: -1, observedMs: 100620, ...patch });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const events: string[] = [], capture = deferred<void>(), parent = new AbortController();
  let ms = 110, stateReads = 0, captureCalls = 0, suspendCount = 0;
  let requestPatch: ((set: number, command: number) => Buffer | undefined) | undefined;
  const request = async (set: number, command: number, data?: Buffer) => {
    events.push(`jdwp:${set}/${command}`);
    if (set === 11 && command === 2) suspendCount++;
    if (set === 11 && command === 3) suspendCount--;
    if (set === 1 && command === 6) suspendCount = 0;
    const patched = requestPatch?.(set, command); if (patched) return patched;
    if (set === 1 && command === 7) return Buffer.concat(Array(5).fill(int(4)));
    if (set === 1 && command === 4) return Buffer.concat([int(1), int(7)]);
    if (set === 11 && command === 1) return string("main");
    if (set === 11 && command === 12) return int(suspendCount);
    if (set === 11 && command === 7) return int(100);
    if (set === 11 && command === 6) {
      assert.ok(data); assert.equal(data.readInt32BE(8), 32);
      return Buffer.concat([int(1), int(9), Buffer.from([1]), int(10), int(11), Buffer.alloc(8)]);
    }
    if (set === 2 && command === 1) return string("Lexample/Handler;");
    if (set === 2 && command === 5) return Buffer.concat([int(1), int(11), string("work"), string("()V"), int(1)]);
    return Buffer.alloc(0);
  };
  const deps: Dependencies = {
    now: () => ms,
    artifacts: async () => { events.push("artifacts"); return { apkSha256, aarSha256: "c".repeat(64), sourceSha256, sdkVersion }; },
    installed: async (_, sha) => { events.push("installed"); assert.equal(sha, apkSha256); return { apkSha256, installedPath: "/data/app/fixture/base.apk" }; },
    process: async () => { events.push("process"); return { pid: 42, startTicks: "12345" }; },
    runtime: async () => { events.push("runtime"); return { pid: 42, processInstance: target.processInstance, sdkVersion }; },
    forward: { open: async () => { events.push("open"); return 12345; },
      remove: async port => { events.push("remove"); assert.equal(port, 12345); },
      connect: () => ({ ready: Promise.resolve(), request, close: () => { events.push("close"); } }) },
    subscribe: async () => {
      events.push("subscribe");
      return { json: JSON.stringify(event({ phase: "queued", observedMs: 100600 })), receivedHostMs: 100 };
    },
    captureOnce: async (actualTarget, options, signal) => {
      captureCalls++; events.push("capture"); assert.deepEqual(actualTarget, target);
      assert.equal(options.identity.requestId, target.requestId); assert.equal(options.treeQueueDiagnostics, true);
      const cancel = () => capture.reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try { await capture.promise; }
      finally { signal.removeEventListener("abort", cancel); }
    },
    state: async () => {
      stateReads++; events.push(`state:${stateReads}`);
      if (stateReads === 1) return event();
      if (stateReads === 2) { capture.resolve(); return event({ observedMs: 100700 }); }
      return event({ observedMs: 103100, enteredMs: 100800, endedMs: 100900, settledMs: 103000 });
    },
  };
  return { deps, parent, capture, events, request,
    advance: (n: number) => { ms = n; }, patchRequest: (patch: typeof requestPatch) => { requestPatch = patch; },
    count: () => ({ stateReads, captureCalls, suspendCount }),
    create: () => createQueueObservation(target, deps) };
}
function cleaned(f: ReturnType<typeof fixture>) {
  assert.equal(getEventListeners(f.parent.signal, "abort").length, 0);
  assert.equal(f.count().suspendCount, 0);
  assert.ok(f.count().captureCalls <= 1);
}

test("complete entry performs one request, brackets recovery before symbols and reports only after cleanup", async () => {
  const f = fixture(), observation = f.create();
  const report = await observation.run(f.parent.signal);
  assert.equal(report.status, "queue-covered"); assert.equal(report.frames.length, 1);
  assert.equal(report.symbols?.[0].className, "Lexample/Handler;");
  assert.equal(report.cleanup.resumeVerified, true); assert.equal(report.cleanup.forwardRemoved, true);
  assert.equal(report.logClosed, true); assert.equal(report.captureReplySettled, true);
  assert.deepEqual(report.deviceBounds, { startedDeviceMs: 100620, resumedDeviceMs: 100701, roundingUpperMs: 1 });
  assert.deepEqual(f.count(), { stateReads: 3, captureCalls: 1, suspendCount: 0 });
  assert.ok(f.events.indexOf("subscribe") < f.events.indexOf("capture"));
  assert.ok(f.events.indexOf("jdwp:11/3") < f.events.indexOf("state:2"));
  assert.ok(f.events.indexOf("state:2") < f.events.indexOf("jdwp:2/1"));
  assert.deepEqual(f.events.slice(-2), ["close", "remove"]);
  assert.equal(f.events.filter(e => e === "installed").length, 2);
  assert.equal(f.events.filter(e => e === "runtime").length, 3);
  await assert.rejects(observation.run(f.parent.signal), /already attempted/); cleaned(f);
});

test("failed original capture is retained and never disguised as a successful UI capture", async () => {
  const f = fixture(); let reads = 0;
  f.deps.state = async () => {
    if (++reads === 1) return event();
    if (reads === 2) { f.capture.reject(Error("SDK tree timeout")); return event({ observedMs: 100700 }); }
    return event({ observedMs: 103100, settledMs: 103000 });
  };
  const report = await f.create().run(f.parent.signal);
  assert.equal(report.status, "queue-covered"); assert.equal(report.capture?.status, "failed");
  assert.match(report.capture?.error ?? "", /SDK tree timeout/); cleaned(f);
});

test("preflight mismatch or unknown source prevents opening a connection or starting capture", async () => {
  for (const type of ["installed", "runtime", "process", "source"]) {
    const f = fixture();
    if (type === "installed") f.deps.installed = async () => ({ apkSha256: "d".repeat(64), installedPath: "changed" });
    if (type === "runtime") f.deps.runtime = async () => ({ pid: 99, processInstance: target.processInstance, sdkVersion });
    if (type === "process") f.deps.process = async () => ({ pid: 99, startTicks: "12345" });
    if (type === "source") f.deps.artifacts = async () => ({ apkSha256, aarSha256: "c".repeat(64), sourceSha256, sdkVersion: "tree-queue-v1" });
    const report = await f.create().run(f.parent.signal);
    assert.equal(report.status, "observation-failed"); assert.equal(f.events.includes("open"), false);
    assert.equal(f.count().captureCalls, 0); cleaned(f);
  }
});

test("changed process proof is refused at admission and after recovery despite a matching SDK reply", async () => {
  for (const failedRead of [1, 2, 3]) {
    const f = fixture(); let reads = 0;
    f.deps.process = async () => ({ pid: ++reads === failedRead ? 99 : 42, startTicks: "12345" });
    const report = await f.create().run(f.parent.signal);
    assert.equal(report.status, "observation-failed"); assert.match(report.error ?? "", /process identity changed/);
    if (failedRead === 1) assert.equal(f.events.includes("open"), false);
    else assert.equal(report.cleanup.forwardRemoved, true);
    assert.equal(f.events.includes("jdwp:11/2"), failedRead === 3);
    assert.equal(report.deviceBounds, undefined); cleaned(f);
  }
});

test("stale or finished queue cannot suspend and still closes the owned connection", async () => {
  for (const finished of [false, true]) {
    const f = fixture();
    f.deps.state = async () => {
      if (finished) return event({ enteredMs: 100610 });
      f.advance(400); return event();
    };
    const report = await f.create().run(f.parent.signal);
    assert.equal(report.status, "no-stack"); assert.equal(f.events.includes("jdwp:11/2"), false);
    assert.deepEqual(f.events.slice(-2), ["close", "remove"]); cleaned(f);
  }
});

test("cancel during frames or lost suspend acknowledgement restores before closing", async () => {
  for (const lost of [false, true]) {
    const f = fixture();
    f.patchRequest((s, c) => {
      if (s === 11 && c === 2 && lost) throw Error("lost suspend acknowledgement");
      if (s === 11 && c === 6 && !lost) f.parent.abort(Error("cancel during frames"));
      return undefined;
    });
    const report = await f.create().run(f.parent.signal);
    assert.equal(report.status, "observation-failed"); assert.equal(report.cleanup.resumeVerified, true);
    assert.ok(f.events.indexOf("jdwp:11/3") < f.events.indexOf("close"));
    assert.equal(f.count().stateReads, 1); cleaned(f);
  }
});

test("lost resume acknowledgement disposes once and does not report queue coverage", async () => {
  const f = fixture();
  f.patchRequest((s, c) => { if (s === 11 && c === 3) throw Error("lost resume acknowledgement"); return undefined; });
  const report = await f.create().run(f.parent.signal);
  assert.equal(report.status, "observation-failed"); assert.equal(report.cleanup.disposeAcknowledged, true);
  assert.equal(report.cleanup.resumeVerified, undefined);
  assert.equal(f.events.filter(e => e === "jdwp:11/3").length, 1);
  assert.equal(f.events.filter(e => e === "jdwp:1/6").length, 1); cleaned(f);
});

test("final instance change, missing settled state or cleanup failure never reports coverage", async () => {
  for (const type of ["instance", "settled", "remove", "close", "close-null"]) {
    const f = fixture(); let reads = 0;
    const original = f.deps.state!;
    f.deps.state = async (...args) => {
      const state = await original(...args);
      if (++reads === 3 && type === "instance") state.processInstance = "33333333-3333-3333-3333-333333333333";
      if (reads === 3 && type === "settled") return event({ observedMs: 103100 });
      return state;
    };
    if (type === "remove") f.deps.forward.remove = async () => { f.events.push("remove"); throw Error("remove failed"); };
    if (type.startsWith("close")) f.deps.forward.connect = () => ({ ready: Promise.resolve(), request: f.request,
      close: () => { f.events.push("close"); if (type === "close-null") throw null; throw Error("close failed"); } });
    const report = await f.create().run(f.parent.signal);
    assert.equal(report.status, "observation-failed");
    assert.equal(f.events.includes("remove"), true); cleaned(f);
  }
});

test("symbol failure retains raw sample and coverage without retrying or pausing again", async () => {
  const f = fixture();
  f.patchRequest((s, c) => { if (s === 2 && c === 1) throw Error("symbols unavailable"); return undefined; });
  const report = await f.create().run(f.parent.signal);
  assert.equal(report.status, "queue-covered"); assert.equal(report.frames.length, 1);
  assert.match(report.symbolError ?? "", /symbols unavailable/);
  assert.equal(f.events.filter(e => e === "jdwp:11/2").length, 1); cleaned(f);
});

test("pre-cancel and late preflight result cannot issue subsequent operations", async () => {
  const cancelled = fixture(); cancelled.parent.abort(Error("cancelled before run"));
  assert.equal((await cancelled.create().run(cancelled.parent.signal)).status, "observation-failed");
  assert.deepEqual(cancelled.events, []); cleaned(cancelled);
  const f = fixture(), pending = deferred<Awaited<ReturnType<NonNullable<Dependencies["artifacts"]>>>>();
  f.deps.artifacts = async () => { f.parent.abort(Error("cancel preflight")); return pending.promise; };
  const report = await f.create().run(f.parent.signal); assert.equal(report.status, "observation-failed");
  pending.resolve({ apkSha256, aarSha256: "c".repeat(64), sourceSha256, sdkVersion });
  await Promise.resolve(); assert.deepEqual(f.events, []); cleaned(f);
});

test("log cleanup failure cannot claim success, and a hung subscriber exits boundedly", async () => {
  for (const hung of [false, true]) {
    const f = fixture(); f.deps.timeoutMs = 10;
    f.deps.subscribe = async () => {
      if (hung) return new Promise(() => {});
      throw new QueueLogCleanupError();
    };
    const report = await f.create().run(f.parent.signal);
    assert.equal(report.status, "observation-failed"); assert.equal(report.logClosed, false);
    assert.match(report.error ?? "", /cleanup not confirmed/); cleaned(f);
  }
});

test("late capture reply cannot mutate a returned report after unconfirmed cleanup", async () => {
  const f = fixture(); f.deps.timeoutMs = 10;
  f.deps.captureOnce = async () => { f.events.push("capture"); await f.capture.promise; };
  f.deps.state = async () => event();
  const report = await f.create().run(f.parent.signal);
  assert.equal(report.status, "observation-failed"); assert.equal(report.captureReplySettled, false);
  const saved = JSON.stringify(report);
  f.capture.resolve(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(JSON.stringify(report), saved); cleaned(f);
});

test("request completion before a notice stops the subscriber without sampling or retrying", async () => {
  const f = fixture(); let logStopped = false;
  f.deps.subscribe = (_, signal) => new Promise((_, reject) => {
    const stopped = () => { logStopped = true; reject(signal.reason); };
    signal.addEventListener("abort", stopped, { once: true });
    if (signal.aborted) stopped();
  });
  f.capture.resolve();
  const report = await f.create().run(f.parent.signal);
  assert.equal(report.status, "no-stack"); assert.equal(report.capture?.status, "completed");
  assert.equal(report.captureReplySettled, true); assert.equal(report.logClosed, true);
  assert.equal(logStopped, true); assert.equal(f.events.includes("jdwp:11/2"), false);
  assert.equal(f.count().captureCalls, 1); assert.equal(f.count().stateReads, 0); cleaned(f);
});

test("connection preparation failure removes its forward without issuing capture", async () => {
  const f = fixture();
  f.deps.forward.connect = () => ({ ready: Promise.reject(Error("handshake failed")), request: f.request,
    close: () => { f.events.push("close"); } });
  const report = await f.create().run(f.parent.signal);
  assert.equal(report.status, "observation-failed"); assert.match(report.error ?? "", /handshake failed/);
  assert.equal(report.cleanup.forwardRemoved, true); assert.equal(f.count().captureCalls, 0);
  assert.deepEqual(f.events.slice(-2), ["close", "remove"]); cleaned(f);
});

test("capture resource setup precedes subscription and is paired with cleanup even before capture", async () => {
  for (const stage of ["success", "prepare-failure", "cancel", "cleanup-failure"]) {
    const f = fixture();
    f.deps.prepareCapture = async () => {
      f.events.push("prepare-capture");
      if (stage === "prepare-failure") throw Error("prepare capture failed");
      if (stage === "cancel") f.parent.abort(Error("cancel in capture preparation"));
    };
    f.deps.closeCapture = async () => { f.events.push("close-capture"); if (stage === "cleanup-failure") throw Error("close capture failed"); };
    const report = await f.create().run(f.parent.signal);
    assert.equal(report.status, stage === "success" ? "queue-covered" : "observation-failed");
    assert.equal(report.cleanup.captureConnectionClosed, stage !== "cleanup-failure");
    assert.equal(f.events.filter(event => event === "close-capture").length, 1);
    if (stage === "prepare-failure" || stage === "cancel") {
      assert.equal(f.count().captureCalls, 0); assert.equal(f.events.includes("open"), false);
    } else {
      assert.ok(f.events.indexOf("prepare-capture") < f.events.indexOf("subscribe"));
      assert.ok(f.events.indexOf("jdwp:11/3") < f.events.indexOf("close-capture"));
    }
    if (stage === "cleanup-failure") assert.match(report.error ?? "", /Capture connection cleanup not confirmed/);
    cleaned(f);
  }
  const f = fixture(); f.deps.prepareCapture = async () => {};
  assert.throws(() => f.create(), /Invalid observation target/); assert.deepEqual(f.events, []);
});

test("complete entry uses real local JDWP TCP and log subprocess pipes without executing adb", async t => {
  const f = fixture(), sockets = new Set<Socket>(), errors: unknown[] = [];
  let child: ChildProcess | undefined, childClosed = false;
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("error", error => errors.push(error));
    let buffer = Buffer.alloc(0), handshake = true;
    socket.on("data", data => {
      buffer = Buffer.concat([buffer, data]);
      if (handshake) {
        if (buffer.length < 14) return;
        assert.equal(buffer.subarray(0, 14).toString(), "JDWP-Handshake");
        buffer = buffer.subarray(14); handshake = false; socket.write("JDWP-Handshake");
      }
      while (buffer.length >= 11) {
        const length = buffer.readUInt32BE(); if (buffer.length < length) return;
        const packet = buffer.subarray(0, length); buffer = buffer.subarray(length);
        void f.request(packet[9], packet[10], packet.subarray(11)).then(payload => {
          const reply = Buffer.alloc(11 + payload.length); reply.writeUInt32BE(reply.length);
          reply.writeUInt32BE(packet.readUInt32BE(4), 4); reply[8] = 0x80; payload.copy(reply, 11);
          socket.write(reply.subarray(0, 5)); socket.write(reply.subarray(5));
        }, error => { errors.push(error); socket.destroy(); });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (child && !childClosed) child.kill("SIGKILL");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  f.deps.forward = { open: async () => { f.events.push("open"); return address.port; },
    remove: async port => { f.events.push("remove"); assert.equal(port, address.port); } };
  f.deps.subscribe = (logTarget, signal, options) => waitForQueueLog(logTarget, signal, { ...options,
    start: args => {
      assert.deepEqual(args, ["-s", "fixture", "logcat", "-v", "raw", "--pid=42", "-s", "InspectorTreeQueue:D"]);
      f.events.push("subscribe");
      child = spawn(process.execPath, ["-e", "process.stdin.once('data', data => process.stdout.write(data)); setInterval(() => {}, 1000);"],
        { stdio: ["pipe", "pipe", "pipe"] });
      child.once("close", () => { childClosed = true; f.events.push("log-close"); });
      return child;
    } });
  const captureOnce = f.deps.captureOnce;
  f.deps.captureOnce = async (...args) => {
    assert.ok(child?.stdin); child.stdin.write(JSON.stringify(event({ phase: "queued", observedMs: 100600 })) + "\n");
    return captureOnce(...args);
  };
  const report = await f.create().run(f.parent.signal);
  assert.equal(report.status, "queue-covered"); assert.equal(report.frames.length, 1);
  assert.equal(report.symbols?.[0].method?.name, "work");
  assert.equal(report.cleanup.resumeVerified, true); assert.equal(report.cleanup.forwardRemoved, true);
  assert.equal(report.logClosed, true); assert.equal(report.captureReplySettled, true); assert.equal(childClosed, true);
  assert.ok(f.events.indexOf("log-close") < f.events.indexOf("state:1"));
  assert.ok(f.events.indexOf("jdwp:11/3") < f.events.indexOf("state:2"));
  assert.deepEqual(f.count(), { stateReads: 3, captureCalls: 1, suspendCount: 0 });
  assert.deepEqual(errors, []); cleaned(f);
});
