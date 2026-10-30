import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareQueueMain, type StackEvidence } from "../scripts/diagnostics/sdk/sdk-queue-jdwp";
import { createServer, type Socket } from "node:net";
import { createRequire } from "node:module";
import { createQueueObserver } from "../scripts/diagnostics/sdk/sdk-queue-observer";
import { verifyQueueProcess } from "../scripts/diagnostics/sdk/sdk-queue-identity";
type Client = { ready: Promise<void>; request: Parameters<typeof prepareQueueMain>[0]; close: () => void };
const { createJdwpClient, withOwnedForward } = createRequire(import.meta.url)("../scripts/lib/startup-stack-observer.cjs") as {
  createJdwpClient: (port: number, options: { timeoutMs: number; handshakeMs: number }) => Client;
  withOwnedForward: (options: { open: () => Promise<number>; connect: (port: number) => Client;
    remove: (port: number) => Promise<void>; observe: (client: Client) => Promise<unknown> }, evidence: object) => Promise<unknown>;
};
const identity = { apkSha256: "a".repeat(64), sdkVersion: "verified-build", pid: 42, startTicks: "12345",
  processInstance: "22222222-2222-2222-2222-222222222222", requestId: "11111111-1111-1111-1111-111111111111" };
const notice = () => ({ identity: { ...identity }, postedMs: 100000, observedMs: 100600,
  enteredMs: -1, settledMs: -1, receivedHostMs: 100 });
const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
function fixture(patch: (set: number, command: number, data?: Buffer) => Buffer | undefined = () => undefined) {
  const calls: string[] = [], controller = new AbortController(); let ms = 110;
  const request = async (set: number, command: number, data?: Buffer) => {
    calls.push(`${set}/${command}`);
    const value = patch(set, command, data); if (value) return value;
    if (set === 1 && command === 7) return Buffer.concat(Array(5).fill(int(4)));
    if (set === 1 && command === 4) return Buffer.concat([int(1), int(7)]);
    if (set === 11 && command === 1) return Buffer.concat([int(4), Buffer.from("main")]);
    if (set === 11 && command === 12) return int(0);
    if (set === 11 && command === 7) return int(100);
    if (set === 11 && command === 6) {
      assert.ok(data); assert.equal(data.readInt32BE(8), 32);
      return Buffer.concat([int(1), int(9), Buffer.from([1]), int(10), int(11), Buffer.alloc(8)]);
    }
    return Buffer.alloc(0);
  };
  return { calls, controller, request, now: () => ms, advance: (value: number) => { ms = value; } };
}
test("preparation reads metadata only; sample reads at most32 frames and confirms resume", async () => {
  const f = fixture(), evidence: StackEvidence = {};
  const prepared = await prepareQueueMain(f.request, f.controller.signal, f.now);
  assert.deepEqual(f.calls, ["1/7", "1/4", "11/1"]);
  const frames = await prepared.sample(identity, async () => notice(), () => true, evidence);
  assert.deepEqual(frames, [{ frameId: "00000009", tag: 1, classId: "0000000a", methodId: "0000000b", codeIndex: "0000000000000000" }]);
  assert.equal(evidence.resumeVerified, true);
  assert.deepEqual(f.calls.slice(3), ["11/12", "11/2", "11/7", "11/6", "11/3", "11/12"]);
  await assert.rejects(prepared.sample(identity, async () => notice(), () => true, {}), /already attempted/);
});
test("stale notice after suspend-count query is rejected without suspend, resume or dispose", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture((s, c) => { if (s === 11 && c === 12) f.advance(351); return undefined; });
  const prepared = await prepareQueueMain(f.request, f.controller.signal, f.now);
  await assert.rejects(prepared.sample(identity, async () => notice(), () => true, {}), /stale-notice/);
  assert.deepEqual(f.calls.slice(3), ["11/12"]);
});
test("ended request and foreign identity cannot pause and are consumed once", async () => {
  for (const ended of [true, false]) {
    const f = fixture(), prepared = await prepareQueueMain(f.request, f.controller.signal, f.now);
    await assert.rejects(prepared.sample(identity, async () => ({ ...notice(),
      identity: { ...identity, pid: ended ? 42 : 99 } }), () => !ended, {}), /request-ended|identity-mismatch/);
    assert.deepEqual(f.calls.slice(3), ["11/12"]);
    await assert.rejects(prepared.sample(identity, async () => notice(), () => true, {}), /already attempted/);
  }
});
test("pre-existing suspension is not touched", async () => {
  const f = fixture((s, c) => s === 11 && c === 12 ? int(1) : undefined);
  const prepared = await prepareQueueMain(f.request, f.controller.signal, f.now);
  await assert.rejects(prepared.sample(identity, async () => notice(), () => true, {}), /already suspended/);
  assert.deepEqual(f.calls.slice(3), ["11/12"]);
});
test("cancellation during frame request restores before returning, never closes transport early", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture((s, c) => { if (s === 11 && c === 6) f.controller.abort(Error("cancel frames")); return undefined; });
  const prepared = await prepareQueueMain(f.request, f.controller.signal, f.now), evidence: StackEvidence = {};
  await assert.rejects(prepared.sample(identity, async () => notice(), () => true, evidence), /cancel frames/);
  assert.equal(evidence.resumeVerified, true);
  assert.deepEqual(f.calls.slice(-2), ["11/3", "11/12"]);
});
test("malformed frames and lost suspend response still restore", async () => {
  for (const failure of ["frames", "suspend"]) {
    const f = fixture((s, c) => {
      if (s === 11 && c === 2 && failure === "suspend") throw Error("lost suspend response");
      if (s === 11 && c === 6) return int(33);
      return undefined;
    });
    const prepared = await prepareQueueMain(f.request, f.controller.signal, f.now), evidence: StackEvidence = {};
    await assert.rejects(prepared.sample(identity, async () => notice(), () => true, evidence), /lost suspend|Invalid JDWP frames/);
    assert.equal(evidence.resumeVerified, true);
    assert.deepEqual(f.calls.slice(-2), ["11/3", "11/12"]);
  }
});
test("lost resume response disposes once, never issues a second resume", async () => {
  const f = fixture((s, c) => { if (s === 11 && c === 3) throw Error("lost resume response"); return undefined; });
  const prepared = await prepareQueueMain(f.request, f.controller.signal, f.now), evidence: StackEvidence = {};
  await assert.rejects(prepared.sample(identity, async () => notice(), () => true, evidence), /lost resume/);
  assert.equal(evidence.resumeVerified, undefined); assert.equal(evidence.disposeAcknowledged, true);
  assert.equal(f.calls.filter(c => c === "11/3").length, 1); assert.equal(f.calls.at(-1), "1/6");
});
test("invalid ID sizes, too many threads and missing main refuse preparation without pause", async () => {
  for (const patch of [
    (s: number, c: number) => s === 1 && c === 7 ? Buffer.alloc(20) : undefined,
    (s: number, c: number) => s === 1 && c === 4 ? int(129) : undefined,
    (s: number, c: number) => s === 11 && c === 1 ? Buffer.concat([int(4), Buffer.from("work")]) : undefined,
  ]) {
    const f = fixture(patch);
    await assert.rejects(prepareQueueMain(f.request, f.controller.signal, f.now), /ID sizes|thread count|unavailable/);
    assert.equal(f.calls.includes("11/2"), false);
  }
});

test("symbols are read only after verified resume and use immutable captured locations", async () => {
  const string = (value: string) => Buffer.concat([int(Buffer.byteLength(value)), Buffer.from(value)]);
  const f = fixture((s, c) => {
    if (s === 2 && c === 1) return string("Lexample/Main;");
    if (s === 2 && c === 5) return Buffer.concat([int(1), int(11), string("render"), string("()V"), int(1)]);
    return undefined;
  });
  const prepared = await prepareQueueMain(f.request, f.controller.signal, f.now);
  await assert.rejects(prepared.resolveFrames(), /Verified/);
  const frames = await prepared.sample(identity, async () => notice(), () => true, {});
  frames[0].classId = "000000ff";
  const symbols = await prepared.resolveFrames();
  assert.equal(symbols[0].classId, "0000000a"); assert.equal(symbols[0].className, "Lexample/Main;");
  assert.deepEqual(symbols[0].method, { name: "render", signature: "()V" });
  assert.deepEqual(f.calls.slice(-4), ["11/3", "11/12", "2/1", "2/5"]);
});

test("malformed or cancelled symbol reads stop without another pause", async () => {
  const f = fixture((s, c) => s === 2 && c === 1 ? int(5000) : undefined);
  const prepared = await prepareQueueMain(f.request, f.controller.signal, f.now);
  await prepared.sample(identity, async () => notice(), () => true, {});
  await assert.rejects(prepared.resolveFrames(), /length/);
  const calls = f.calls.length; f.controller.abort(Error("cancel symbols"));
  await assert.rejects(prepared.resolveFrames(), /cancel symbols/);
  assert.equal(f.calls.length, calls); assert.equal(f.calls.filter(c => c === "11/2").length, 1);
});

test("local TCP connects process recheck, fresh queue state, frame recovery and owned-forward cleanup", async t => {
  const f = fixture(), sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
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
          reply.writeUInt32BE(packet.readUInt32BE(4), 4); reply[8] = 0x80;
          payload.copy(reply, 11); socket.write(reply.subarray(0, 5)); socket.write(reply.subarray(5));
        });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const removed: number[] = [], evidence: StackEvidence & { forwardRemoved?: boolean } = {};
  let processReads = 0, queueReads = 0;
  const event = { event: "tree-queue" as const, protocol: "tree-queue-v1" as const, phase: "queued" as const,
    kind: "classic" as const, requestId: identity.requestId, processInstance: identity.processInstance, pid: 42,
    postedMs: 100000, enteredMs: -1, endedMs: -1, settledMs: -1, observedMs: 100600 };
  const observer = createQueueObserver({ serial: "fixture", packageName: "example.app", identity }, {
    now: f.now,
    verify: async signal => {
      const process = await verifyQueueProcess({ serial: "fixture", packageName: "example.app", pid: 42, startTicks: "12345" }, signal, async () => {
        processReads++;
        const fields = Array(25).fill("0"); fields[0] = "S"; fields[19] = "12345";
        const stat = `42 (fixture) ${fields.join(" ")}\n`;
        return Buffer.from(`${stat}example.app\0${stat}`);
      });
      // APK/SDK values are fixture evidence only, not proof of an installed business SDK.
      return { ...identity, ...process };
    },
    read: async () => { queueReads++; return { ...event, phase: "state" }; },
  });
  const frames = await withOwnedForward({ open: async () => address.port,
    connect: port => createJdwpClient(port, { timeoutMs: 200, handshakeMs: 750 }),
    remove: async port => { removed.push(port); }, observe: async client => {
      const prepared = await prepareQueueMain(client.request, f.controller.signal, f.now);
      return prepared.sample(identity, async () => {
        const result = await observer.prepare(JSON.stringify(event), f.controller.signal, () => true, 100);
        if (result.status !== "sample-reserved" || !("notice" in result) || !result.notice) throw Error("Not admitted");
        return result.notice;
      }, () => true, evidence);
    } }, evidence) as unknown[];
  assert.equal(frames.length, 1); assert.equal(evidence.resumeVerified, true);
  assert.equal(evidence.forwardRemoved, true); assert.deepEqual(removed, [address.port]);
  assert.equal(processReads, 1); assert.equal(queueReads, 1);
});
