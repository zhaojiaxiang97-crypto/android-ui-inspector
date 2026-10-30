import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Socket } from "node:net";
import { createRequire } from "node:module";
import { createStartupStackObservation } from "../scripts/diagnostics/startup/startup-stack-observation";

const target = { serial: "fixture", packageName: "example.app", component: "example.app/.Home",
  pid: 42, startTicks: "12345", apkSha256: "a".repeat(64) };
const launch = { runId: "11111111-1111-1111-1111-111111111111", startedAt: 0, authorized: true as const };
const path = "/data/app/~~fixture/example.app-ab/base.apk";
const record = (token = "abc") => `ActivityRecord{${token} u0 example.app/.Home t1}`;
const activity = (token = "abc") => `ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)\n` +
  ` topResumedActivity=${record(token)}\n * Hist #0: ${record(token)}\n` +
  ` packageName=example.app processName=example.app\n app=ProcessRecord{def 42:example.app/u0a123}\n`;
const windows = (ready: boolean) => `WINDOW MANAGER WINDOWS (dumpsys window windows)\n` + (ready ?
  ` Window #0 Window{fed u0 example.app/.Home}:\n mDisplayId=0 mSession=Session{aaa 42:u0a123}\n` +
  ` mOwnerUid=10123 package=example.app\n mAttrs={(0,0) ty=BASE_APPLICATION}\n mActivityRecord=${record()}\n` : "") +
  ` mTopFocusedDisplayId=0\n`;
const displays = `WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)\n` +
  ` Display: mDisplayId=0\n mCurrentFocus=null\n mFocusedApp=${record()}\n`;
const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const string = (s: string) => Buffer.concat([int(Buffer.byteLength(s)), Buffer.from(s)]);
function processFrame(ticks = target.startTicks) {
  const fields = Array(25).fill("0"); fields[0] = "S"; fields[19] = ticks;
  const stat = `42 (fixture) ${fields.join(" ")}\n`;
  return Buffer.from(stat + "example.app\0" + stat);
}
type Patch = (set: number, command: number, payload: Buffer, socket: Socket, id: number) => Buffer | null | undefined;
async function fixture() {
  let time = 12000, ready = false, mapping: string | undefined, currentPort = 0;
  let commandPatch: ((args: string[], reply: Buffer) => Buffer) | undefined, patch: Patch | undefined;
  let handshake = true, ticks = target.startTicks;
  const controller = new AbortController(), commands: string[][] = [], packets: string[] = [], sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, work: () => void) => {
    const timer = setTimeout(() => { timers.delete(timer); work(); }, ms); timers.add(timer);
  };
  const replyLater = (socket: Socket, id: number, payload: Buffer, ms: number) => later(ms, () => {
    if (socket.destroyed) return;
    const packet = Buffer.alloc(11 + payload.length); packet.writeUInt32BE(packet.length);
    packet.writeUInt32BE(id, 4); packet[8] = 0x80; payload.copy(packet, 11); socket.write(packet);
  });
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0), first = true;
    socket.on("data", data => {
      buffer = Buffer.concat([buffer, data]);
      if (first) {
        if (buffer.length < 14) return;
        assert.equal(buffer.subarray(0, 14).toString(), "JDWP-Handshake");
        buffer = buffer.subarray(14); first = false;
        if (handshake) { socket.write("JDWP-"); socket.write("Handshake"); }
      }
      while (buffer.length >= 11) {
        const length = buffer.readUInt32BE(); if (buffer.length < length) return;
        const request = buffer.subarray(0, length); buffer = buffer.subarray(length);
        const s = request[9], c = request[10], payload = request.subarray(11); packets.push(`${s}/${c}`);
        let response = patch?.(s, c, payload, socket, request.readUInt32BE(4));
        if (response === null) continue;
        if (response === undefined) {
          if (s === 1 && c === 7) response = Buffer.concat(Array(5).fill(int(4)));
          else if (s === 1 && c === 4) response = Buffer.concat([int(1), int(7)]);
          else if (s === 11 && c === 1) response = string("main");
          else if (s === 11 && c === 12) response = int(0);
          else if (s === 11 && c === 7) response = int(100);
          else if (s === 11 && c === 6) {
            assert.equal(payload.readInt32BE(8), 32);
            response = Buffer.concat([int(1), int(9), Buffer.from([1]), int(10), int(11), Buffer.alloc(8)]);
          } else if (s === 2 && c === 1) response = string("Lexample/Main;");
          else if (s === 2 && c === 5) response = Buffer.concat([int(1), int(11), string("render"), string("()V"), int(1)]);
          else response = Buffer.alloc(0);
        }
        const reply = Buffer.alloc(11 + response.length); reply.writeUInt32BE(reply.length);
        reply.writeUInt32BE(request.readUInt32BE(4), 4); reply[8] = 0x80; response.copy(reply, 11);
        socket.write(reply.subarray(0, 5)); socket.write(reply.subarray(5));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); currentPort = address.port;
  const execute = async (args: string[], timeout: number, signal: AbortSignal) => {
    signal.throwIfAborted(); assert.ok(timeout > 0 && timeout <= 5000);
    assert.deepEqual(args.slice(0, 2), ["-s", "fixture"]); commands.push([...args]); time += 1;
    let reply: Buffer;
    if (args[2] === "forward") {
      if (args.includes("--list")) reply = Buffer.from(mapping ? `fixture tcp:${currentPort} ${mapping}\n` : "");
      else if (args.includes("--remove")) { mapping = undefined; reply = Buffer.alloc(0); }
      else { mapping = args.at(-1)!; reply = Buffer.alloc(0); }
    } else if (args.includes("pm")) reply = Buffer.from(`package:${path}\n`);
    else if (args.includes("sha256sum")) reply = Buffer.from(`${target.apkSha256}  ${path}\n`);
    else if (args.includes("run-as")) reply = processFrame(ticks);
    else if (args.at(-1) === "activities") reply = Buffer.from(activity());
    else if (args.at(-1) === "windows") reply = Buffer.from(windows(ready));
    else if (args.at(-1) === "displays") reply = Buffer.from(displays);
    else throw Error(`Forbidden device command: ${args.join(" ")}`);
    return commandPatch ? commandPatch(args, reply) : reply;
  };
  return { controller, commands, packets, execute, replyLater, later, port: currentPort, now: () => time,
    setTime: (value: number) => { time = value; }, setReady: () => { ready = true; },
    setPatch: (value: Patch) => { patch = value; }, setCommandPatch: (value: typeof commandPatch) => { commandPatch = value; },
    setTicks: () => { ticks = "12346"; }, setHandshake: () => { handshake = false; },
    setMapping: (value: string) => { mapping = value; }, mapping: () => mapping,
    observer: (actual = target, origin = launch) => createStartupStackObservation(actual, origin,
      { execute, now: () => time, choosePort: async () => currentPort, wait: async ms => { time += ms; } }),
    close: async () => { for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test("explicit entry is pure, frozen, single-use and uses real local TCP without SDK commands", async t => {
  const f = await fixture(); t.after(f.close);
  const mutable = { ...target }, origin = { ...launch }, observer = f.observer(mutable, origin);
  assert.equal(f.commands.length, 0); mutable.pid = 99; origin.startedAt = 99999;
  const report = await observer.run(f.controller.signal);
  assert.equal(report.status, "stack-collected"); assert.equal(report.runId, launch.runId);
  assert.equal(report.frames.length, 1); assert.ok(report.rawFramesReplyHex);
  assert.equal(report.symbols?.[0].method?.name, "render"); assert.equal(report.finalIdentityVerified, true);
  assert.equal(report.cleanup.resumeVerified, true); assert.equal(report.cleanup.socketClosed, true);
  assert.equal(report.cleanup.forwardRemoved, true); assert.equal(f.mapping(), undefined);
  assert.equal(report.transport?.runId, launch.runId); assert.equal(report.transport?.socketClosed, true);
  assert.ok(report.transport!.connectionStartedAfterLaunchMs >= 12000);
  assert.equal(report.transport?.events.at(-1)?.event, "socket-closed");
  assert.equal(report.transport?.firstRequest?.command, 7);
  assert.equal(report.transport?.firstRequest?.budgetMs, 500);
  assert.equal(report.transport?.firstRequest?.outcome, "reply-received");
  assert.equal(f.packets.filter(c => c === "11/2").length, 1); assert.equal(f.packets.filter(c => c === "11/6").length, 1);
  assert.ok(f.packets.indexOf("2/1") > f.packets.lastIndexOf("11/12"));
  assert.equal(f.commands.some(args => args.includes("content") || args.includes("am") || args.includes("install")), false);
  const count = f.commands.length;
  await assert.rejects(observer.run(new AbortController().signal), /consumed/); assert.equal(f.commands.length, count);
});

test("first startup IDSizes500ms timeout is retained with handshake/write events and never sends suspend", async t => {
  const f = await fixture(); t.after(f.close); f.setPatch((s, c) => s === 1 && c === 7 ? null : undefined);
  const report = await f.observer().run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.deepEqual(f.packets, ["1/7"]);
  assert.ok(report.errors.some(e => e.phase === "prepare-main" && /timeout 1\/7/.test(e.message)));
  assert.equal(report.frames.length, 0); assert.equal(report.cleanup.suspendRequested, undefined);
  assert.equal(report.cleanup.socketClosed, true); assert.equal(report.cleanup.forwardRemoved, true);
  const transport = report.transport!; assert.equal(transport.runId, launch.runId);
  assert.ok(transport.events.some(e => e.event === "handshake-received"));
  assert.ok(transport.events.some(e => e.event === "request-queued" && e.set === 1 && e.command === 7));
  assert.ok(transport.events.some(e => e.event === "request-flushed" && e.set === 1 && e.command === 7));
  assert.ok(transport.events.some(e => e.event === "request-timeout" && e.budgetMs === 500));
  assert.equal(transport.firstRequest?.outcome, "request-timeout");
  assert.equal(transport.firstRequest?.budgetMs, 500);
  const before = JSON.stringify(report); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(JSON.stringify(report), before);
});

test("375ms first startup IDSizes reply succeeds once; all later and recovery requests stay 200ms", async t => {
  const f = await fixture(); t.after(f.close);
  f.setPatch((s, c, _data, socket, id) => {
    if (s !== 1 || c !== 7) return undefined;
    f.replyLater(socket, id, Buffer.concat(Array(5).fill(int(4))), 375); return null;
  });
  const report = await f.observer().run(f.controller.signal);
  assert.equal(report.status, "stack-collected"); assert.equal(report.cleanup.resumeVerified, true);
  assert.equal(f.packets.filter(p => p === "1/7").length, 1);
  const queued = report.transport!.events.filter(e => e.event === "request-queued");
  assert.equal(queued[0].budgetMs, 500); assert.equal(queued[0].set, 1); assert.equal(queued[0].command, 7);
  assert.ok(queued.length > 5); assert.ok(queued.slice(1).every(e => e.budgetMs === 200));
  assert.equal(report.transport!.events.some(e => e.event === "request-timeout"), false);
  assert.equal(report.cleanup.socketClosed, true); assert.equal(report.cleanup.forwardRemoved, true);
});

test("reply beyond500ms remains failed and unmatched; cleanup cannot accept it or retry", async t => {
  const f = await fixture(); t.after(f.close);
  f.setPatch((s, c, _data, socket, id) => {
    if (s !== 1 || c !== 7) return undefined;
    f.replyLater(socket, id, Buffer.concat(Array(5).fill(int(4))), 600); return null;
  });
  const observer = createStartupStackObservation(target, launch, { now: f.now, choosePort: async () => f.port,
    execute: async (args, timeout, signal) => {
      if (f.packets.length && args.includes("sha256sum")) await new Promise(resolve => setTimeout(resolve, 200));
      return f.execute(args, timeout, signal);
    } });
  const report = await observer.run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.deepEqual(f.packets, ["1/7"]);
  const events = report.transport!.events;
  const timeout = events.find(e => e.event === "request-timeout")!;
  const late = events.find(e => e.event === "unmatched-reply")!;
  assert.equal(timeout.budgetMs, 500); assert.equal(late.id, timeout.id); assert.ok(late.atMs > timeout.atMs);
  assert.equal(report.cleanup.suspendRequested, undefined); assert.equal(report.frames.length, 0);
  const saved = JSON.stringify(report); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(JSON.stringify(report), saved); assert.equal(report.cleanup.forwardRemoved, true);
});

test("a later preparation read still times out at200ms and cannot inherit the first-read allowance", async t => {
  const f = await fixture(); t.after(f.close); f.setPatch((s, c) => s === 1 && c === 4 ? null : undefined);
  const report = await f.observer().run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.deepEqual(f.packets, ["1/7", "1/4"]);
  assert.ok(report.transport!.events.some(e => e.event === "request-timeout" && e.command === 4 && e.budgetMs === 200));
  assert.equal(report.cleanup.suspendRequested, undefined);
});

test("preparation reads clamp to the original3s remainder, not a reset deadline", async t => {
  const f = await fixture(); t.after(f.close);
  f.setPatch((s, c) => {
    if (s === 1 && c === 7) f.setTime(f.now() + 2850);
    return s === 1 && c === 4 ? null : undefined;
  });
  const report = await f.observer().run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.deepEqual(f.packets, ["1/7", "1/4"]);
  const next = report.transport!.events.find(e => e.event === "request-queued" && e.command === 4)!;
  assert.equal(next.budgetMs, 150); assert.equal(report.cleanup.suspendRequested, undefined);
});

test("a preparation reply at the3s deadline cannot advance to another read or pause", async t => {
  const f = await fixture(); t.after(f.close);
  f.setPatch((s, c) => { if (s === 1 && c === 7) f.setTime(f.now() + 3000); return undefined; });
  const report = await f.observer().run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.deepEqual(f.packets, ["1/7"]);
  assert.ok(report.errors.some(e => /preparation deadline/.test(e.message)));
  assert.equal(report.cleanup.suspendRequested, undefined);
});

test("first IDSizes500ms allowance is clipped by the same launch's18s remaining time", async t => {
  const f = await fixture(); t.after(f.close);
  f.setCommandPatch((args, reply) => {
    if (args[2] === "forward" && args[3]?.startsWith("tcp:")) f.setTime(17920); return reply;
  });
  f.setPatch((s, c) => s === 1 && c === 7 ? null : undefined);
  const report = await f.observer().run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.deepEqual(f.packets, ["1/7"]);
  const first = report.transport!.events.find(e => e.event === "request-queued")!;
  assert.ok(first.budgetMs! > 0 && first.budgetMs! <= 80); assert.equal(report.cleanup.suspendRequested, undefined);
});

test("cancel during the extended first read stops immediately without retry or recovery writes", async t => {
  const f = await fixture(); t.after(f.close);
  f.setPatch((s, c) => {
    if (s !== 1 || c !== 7) return undefined;
    f.later(250, () => f.controller.abort(Error("cancel first read"))); return null;
  });
  const report = await f.observer().run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.deepEqual(f.packets, ["1/7"]);
  assert.ok(report.transport!.events.some(e => e.event === "request-cancelled" && e.budgetMs === 500));
  assert.equal(report.cleanup.suspendRequested, undefined); assert.equal(report.cleanup.socketClosed, true);
  assert.equal(report.cleanup.forwardRemoved, true);
});

test("disconnect during the extended first read fails without waiting500ms or claiming recovery", async t => {
  const f = await fixture(); t.after(f.close);
  f.setPatch((s, c, _data, socket) => {
    if (s !== 1 || c !== 7) return undefined;
    f.later(250, () => socket.destroy()); return null;
  });
  const report = await f.observer().run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.deepEqual(f.packets, ["1/7"]);
  assert.ok(report.transport!.events.some(e => e.event === "request-failed" && e.budgetMs === 500));
  assert.equal(report.transport!.events.some(e => e.event === "request-timeout"), false);
  assert.equal(report.cleanup.resumeVerified, undefined); assert.equal(report.cleanup.forwardRemoved, true);
});

test("normal window stops before connection; newly registered window stops before pause", async t => {
  for (const at of ["initial", "recheck"]) {
    const f = await fixture(); t.after(f.close);
    if (at === "initial") f.setReady(); else f.setPatch((s, c) => { if (s === 11 && c === 12) f.setReady(); return undefined; });
    const report = await f.observer().run(f.controller.signal);
    assert.equal(report.status, "no-stack"); assert.equal(report.finalIdentityVerified, true);
    assert.equal(f.packets.includes("11/2"), false); assert.equal(f.packets.includes("11/3"), false);
    assert.equal(f.packets.includes("1/6"), false);
    if (at === "initial") { assert.equal(f.commands.some(args => args[2] === "forward"), false); assert.equal(report.transport, undefined); }
  }
});

test("unknown ownership/install/process and pre-cancel cannot connect or pause", async t => {
  for (const mode of ["activity", "windows", "hash", "process", "cancel", "deadline", "future"]) {
    const f = await fixture(); t.after(f.close);
    if (mode === "process") f.setTicks();
    if (mode === "cancel") f.controller.abort(Error("cancel initial"));
    if (mode === "deadline") f.setTime(18000); if (mode === "future") f.setTime(-1);
    f.setCommandPatch((args, reply) => args.at(-1) === (mode === "activity" ? "activities" : mode)
      || mode === "hash" && args.includes("sha256sum") ? Buffer.from("unknown") : reply);
    const report = await f.observer().run(f.controller.signal);
    assert.equal(report.status, "observation-failed", mode); assert.ok(report.errors.length);
    assert.equal(f.packets.length, 0); assert.equal(f.commands.some(args => args[2] === "forward"), false);
  }
});

test("JDWP handshake unavailable leaves no stack, verifies final identity and cleans owned port", async t => {
  const f = await fixture(); t.after(f.close); f.setHandshake();
  const report = await f.observer().run(f.controller.signal);
  assert.equal(report.status, "no-stack"); assert.match(report.reason!, /JDWP unavailable/);
  assert.equal(report.finalIdentityVerified, true); assert.equal(report.cleanup.socketClosed, true);
  assert.equal(report.cleanup.forwardRemoved, true); assert.equal(f.packets.length, 0);
});

test("cancellation at each JDWP read/paused boundary restores only an owned suspension", async t => {
  for (const boundary of ["1/7", "1/4", "11/1", "11/12", "11/2", "11/7", "11/6"]) {
    const f = await fixture(); t.after(f.close);
    f.setPatch((s, c) => { if (`${s}/${c}` === boundary) f.controller.abort(Error(`cancel ${boundary}`)); return undefined; });
    const report = await f.observer().run(f.controller.signal);
    assert.equal(report.status, "observation-failed");
    const owned = ["11/2", "11/7", "11/6"].includes(boundary);
    assert.equal(f.packets.filter(c => c === "11/3").length, owned ? 1 : 0);
    assert.equal(report.cleanup.resumeVerified === true, owned);
    assert.equal(report.cleanup.socketClosed, true); assert.equal(report.cleanup.forwardRemoved, true);
    assert.equal(f.packets.includes("2/1"), false);
  }
});

test("lost suspend/frame replies recover once; malformed frames retain raw reply", async t => {
  for (const boundary of ["11/2", "11/7", "11/6", "malformed"]) {
    const f = await fixture(); t.after(f.close);
    f.setPatch((s, c) => `${s}/${c}` === boundary ? null : boundary === "malformed" && s === 11 && c === 6 ? int(33) : undefined);
    const report = await f.observer().run(f.controller.signal);
    assert.equal(report.status, "observation-failed"); assert.equal(report.cleanup.resumeVerified, true);
    assert.equal(f.packets.filter(c => c === "11/3").length, 1); assert.equal(f.packets.includes("2/1"), false);
    assert.equal(report.finalIdentityVerified, true); assert.equal(report.cleanup.forwardRemoved, true);
    if (boundary === "malformed") assert.equal(report.rawFramesReplyHex, int(33).toString("hex"));
  }
});

test("lost resume/count replies retain frames, Dispose once and never claim verified recovery", async t => {
  for (const boundary of ["resume", "count", "both", "nonzero"]) {
    const f = await fixture(); t.after(f.close); let recovering = false;
    f.setPatch((s, c) => {
      if (s === 11 && c === 3) { recovering = true; if (boundary === "resume" || boundary === "both") return null; }
      if (recovering && s === 11 && c === 12) return boundary === "count" ? null : boundary === "nonzero" ? int(1) : undefined;
      if (s === 1 && c === 6 && boundary === "both") return null;
      return undefined;
    });
    const report = await f.observer().run(f.controller.signal);
    assert.equal(report.status, "observation-failed"); assert.equal(report.frames.length, 1); assert.ok(report.rawFramesReplyHex);
    assert.notEqual(report.cleanup.resumeVerified, true); assert.equal(f.packets.filter(c => c === "11/3").length, 1);
    assert.equal(f.packets.filter(c => c === "1/6").length, 1); assert.equal(f.packets.includes("2/1"), false);
    assert.ok(report.cleanup.recoveryMs! < 1000); assert.equal(report.cleanup.forwardRemoved, true);
    if (boundary === "both") assert.ok(report.cleanup.disposeError);
  }
});

test("pre-existing main suspension never resumes or disposes another debugger's work", async t => {
  const f = await fixture(); t.after(f.close); f.setPatch((s, c) => s === 11 && c === 12 ? int(1) : undefined);
  const report = await f.observer().run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.equal(f.packets.includes("11/2"), false);
  assert.equal(f.packets.includes("11/3"), false); assert.equal(f.packets.includes("1/6"), false);
});

test("15s pre-suspend and 18s operation deadlines do not reset launch origin; recovery remains independent", async t => {
  for (const boundary of ["gate", "paused", "symbols"]) {
    const f = await fixture(); t.after(f.close);
    f.setPatch((s, c) => {
      if (boundary === "gate" && s === 11 && c === 12) f.setTime(15000);
      if (boundary === "paused" && s === 11 && c === 7) f.setTime(18000);
      if (boundary === "symbols" && s === 2 && c === 1) f.setTime(18000);
      return undefined;
    });
    const report = await f.observer().run(f.controller.signal);
    assert.equal(report.status, "observation-failed");
    assert.equal(f.packets.includes("11/2"), boundary !== "gate");
    assert.equal(report.cleanup.resumeVerified === true, boundary !== "gate");
    assert.equal(report.cleanup.socketClosed, true); assert.equal(report.cleanup.forwardRemoved, true);
    if (boundary === "paused") assert.equal(report.finalIdentityVerified, false);
  }
});

test("final APK, process or Activity change invalidates success without losing raw frames", async t => {
  for (const mode of ["hash", "process", "activity"]) {
    const f = await fixture(); t.after(f.close); let sampled = false;
    f.setPatch((s, c) => { if (s === 11 && c === 3) sampled = true; return undefined; });
    f.setCommandPatch((args, reply) => {
      if (sampled && mode === "hash" && args.includes("sha256sum")) return Buffer.from(`${"b".repeat(64)}  ${path}`);
      if (sampled && mode === "process" && args.includes("run-as")) return processFrame("12346");
      if (sampled && mode === "activity" && args.at(-1) === "activities") return Buffer.from(activity("aaa"));
      return reply;
    });
    const report = await f.observer().run(f.controller.signal);
    assert.equal(report.status, "observation-failed"); assert.equal(report.finalIdentityVerified, false);
    assert.ok(report.errors.some(e => e.phase === "final-identity")); assert.equal(report.frames.length, 1);
    assert.equal(report.cleanup.resumeVerified, true); assert.equal(f.packets.includes("2/1"), false);
  }
});

test("symbol failure stays separate from sample and cannot cause a second pause", async t => {
  const f = await fixture(); t.after(f.close); f.setPatch((s, c) => s === 2 && c === 1 ? int(5000) : undefined);
  const report = await f.observer().run(f.controller.signal);
  assert.equal(report.status, "stack-collected"); assert.ok(report.symbolError); assert.equal(report.frames.length, 1);
  assert.equal(f.packets.filter(c => c === "11/2").length, 1);
});

test("observation and cleanup failures are retained together; foreign rebind is never removed", async t => {
  const f = await fixture(); t.after(f.close);
  f.setPatch((s, c) => {
    if (s === 11 && c === 6) return int(33);
    if (s === 11 && c === 3) f.setMapping("jdwp:99"); return undefined;
  });
  const report = await f.observer().run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.ok(report.errors.some(e => e.phase === "sample"));
  assert.ok(report.errors.some(e => e.phase === "forward-cleanup")); assert.equal(report.cleanup.forwardRemoved, false);
  assert.equal(f.mapping(), "jdwp:99"); assert.equal(f.commands.some(args => args.includes("--remove")), false);
});

test("late command reply cannot authorize follow-up reads or a connection", async t => {
  const f = await fixture(); t.after(f.close); let calls = 0;
  const observer = createStartupStackObservation(target, launch, { now: f.now, execute: async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 40)); return Buffer.from(`package:${path}`);
  } });
  f.setTime(14995);
  const report = await observer.run(f.controller.signal); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(report.status, "observation-failed"); assert.equal(calls, 1); assert.equal(f.packets.length, 0);
});

test("cancel at each forward phase and lost creation/binding replies clean without attaching", async t => {
  for (const mode of ["cancel-list", "cancel-reserve", "cancel-bind", "lost-reserve", "lost-bind"]) {
    const f = await fixture(); t.after(f.close);
    f.setCommandPatch((args, reply) => {
      const matched = mode.endsWith("list") ? args.includes("--list") : mode.endsWith("reserve") ? args.includes("--no-rebind")
        : args[2] === "forward" && args[3].startsWith("tcp:");
      if (matched) {
        if (mode.startsWith("cancel")) f.controller.abort(Error(mode)); else throw Error(mode);
      }
      return reply;
    });
    const report = await f.observer().run(f.controller.signal);
    assert.equal(report.status, "observation-failed"); assert.equal(f.packets.length, 0);
    assert.equal(f.mapping(), undefined); assert.equal(report.cleanup.forwardRemoved, true);
    assert.equal(f.commands.filter(args => args.includes("--remove")).length, mode === "cancel-list" ? 0 : 1);
  }
});

test("disconnect while paused reports failed recovery, even if port and socket are cleaned", async t => {
  const f = await fixture(); t.after(f.close);
  f.setPatch((s, c, _data, socket) => { if (s === 11 && c === 6) { socket.destroy(); return null; } return undefined; });
  const report = await f.observer().run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.notEqual(report.cleanup.resumeVerified, true);
  assert.ok(report.cleanup.resumeError); assert.ok(report.cleanup.disposeError);
  assert.equal(report.cleanup.socketClosed, true); assert.equal(report.cleanup.forwardRemoved, true);
  assert.equal(f.packets.includes("2/1"), false);
});

test("late JDWP frame reply cannot satisfy recovery or replace the failed sample", async t => {
  const f = await fixture(); t.after(f.close); let late: ReturnType<typeof setTimeout> | undefined;
  t.after(() => clearTimeout(late));
  f.setPatch((s, c, _data, socket, id) => {
    if (s !== 11 || c !== 6) return undefined;
    late = setTimeout(() => {
      if (socket.destroyed) return;
      const reply = Buffer.alloc(15); reply.writeUInt32BE(15); reply.writeUInt32BE(id, 4); reply[8] = 0x80;
      socket.write(reply);
    }, 210);
    return null;
  });
  const report = await f.observer().run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.equal(report.frames.length, 0);
  assert.equal(report.rawFramesReplyHex, undefined); assert.equal(report.cleanup.resumeVerified, true);
});

test("blocked cleanup has its own bound and never assumes an unread port is absent", async t => {
  const f = await fixture(); t.after(f.close); let cleaning = false;
  f.setPatch((s, c) => { if (s === 2 && c === 5) cleaning = true; return undefined; });
  const observer = createStartupStackObservation(target, launch, { now: f.now, choosePort: async () => f.port,
    execute: async (args, timeout, signal) => {
      if (cleaning && args.includes("--list")) return new Promise<Buffer>(() => {});
      return f.execute(args, timeout, signal);
    } });
  const report = await observer.run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.equal(report.cleanup.forwardRemoved, false);
  assert.ok(report.errors.some(e => e.phase === "forward-cleanup")); assert.ok(report.cleanup.cleanupMs! < 3000);
  assert.equal(f.mapping(), "jdwp:42"); assert.equal(f.commands.some(args => args.includes("--remove")), false);
});

test("explicit pre-send rejection never resumes a suspension that was not written", async () => {
  const { withSuspendedMain } = createRequire(import.meta.url)("../scripts/lib/startup-stack-observer.cjs");
  const calls: string[] = [], evidence: { suspendSent?: boolean } = {};
  await assert.rejects(withSuspendedMain(async (s: number, c: number) => {
    calls.push(`${s}/${c}`);
    if (s === 11 && c === 12) return int(0);
    if (s === 11 && c === 2) { evidence.suspendSent = false; throw Error("cancel before socket write"); }
    return Buffer.alloc(0);
  }, int(7), async () => [], evidence), /cancel before socket write/);
  assert.deepEqual(calls, ["11/12", "11/2"]);
});

test("a timed-out creation still in flight cannot be called cleaned or followed by a blind removal", async t => {
  const f = await fixture(); t.after(f.close); let late: Promise<Buffer> | undefined;
  const observer = createStartupStackObservation(target, launch, { now: f.now, choosePort: async () => f.port,
    execute: async (args, timeout, signal) => {
      if (args.includes("--no-rebind")) {
        late = new Promise(resolve => setTimeout(resolve, 35)).then(() => f.execute(args, timeout, new AbortController().signal));
        return late;
      }
      const reply = await f.execute(args, timeout, signal);
      if (args.includes("--list")) f.setTime(17995);
      return reply;
    } });
  const report = await observer.run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.equal(report.cleanup.forwardRemoved, false);
  assert.equal(report.cleanup.forwardCommandsSettled, false); assert.equal(f.packets.length, 0);
  assert.equal(f.commands.some(args => args.includes("--remove")), false);
  const saved = JSON.stringify(report); await late;
  assert.match(f.mapping()!, /^localabstract:inspector\.queue\./); assert.equal(JSON.stringify(report), saved);
});
