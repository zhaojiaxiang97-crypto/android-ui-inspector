import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import { readViewFont } from "../electron/capture/view-font";

const target = { rootRef: "example.DecorView@abc", windowName: "activity-window", hardwareAccelerated: true };
const ref = "example.Title@def";
type Options = {
  idSize?: 4 | 8; family?: string | null; familyApi?: boolean; weightApi?: boolean; styleApi?: boolean;
  fields?: boolean; weight?: number; style?: number; defaultTypeface?: boolean; nullStringTag?: "L" | "s";
  staleRoot?: boolean; missingView?: boolean; notTextView?: boolean; fakeBootstrap?: boolean;
  wrongPaintType?: boolean; wrongTypefaceType?: boolean; wrongStringType?: boolean;
  integerTag?: string; methodException?: boolean; stringBytes?: Buffer; oversizedString?: boolean;
  onCommand?: (command: string, socket: Socket) => boolean | void;
};
async function fixture(options: Options = {}) {
  const size = options.idSize ?? 4;
  const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
  const id = (n: number) => size === 4 ? int(n) : (() => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; })();
  const readId = (b: Buffer, offset = 0) => size === 4 ? b.readInt32BE(offset) : Number(b.readBigInt64BE(offset));
  const string = (value: string) => Buffer.concat([int(Buffer.byteLength(value)), Buffer.from(value)]);
  const tagged = (tag: string, value: number) => Buffer.concat([Buffer.from(tag), tag === "I" || tag === "F" ? int(value) : id(value)]);
  const result = (tag: string, value: number, exception = 0) => Buffer.concat([tagged(tag, value), tagged("L", exception)]);
  const classes = new Map([
    ["Landroid/os/MessageQueue;", 1], ["Landroid/view/View;", 2], ["Landroid/view/ViewDebug;", 3],
    ["Landroid/view/WindowManagerGlobal;", 4], ["Landroid/widget/TextView;", 5],
    ["Landroid/graphics/Paint;", 6], ["Landroid/graphics/Typeface;", 7], ["Ljava/lang/String;", 8],
  ]);
  // 20 is an app subclass whose name need not contain "TextView"; 21 is TextPaint.
  const methods = new Map<number, (readonly [number, string, string])[]>([
    [1, [[1, "next", "()Landroid/os/Message;"]]],
    [3, [[2, "findView", "(Landroid/view/View;Ljava/lang/String;)Landroid/view/View;"]]],
    [4, [[3, "getInstance", "()Landroid/view/WindowManagerGlobal;"], [4, "getRootView", "(Ljava/lang/String;)Landroid/view/View;"]]],
    [5, [[5, "getPaint", "()Landroid/text/TextPaint;"], [99, "getTypeface", "()Landroid/graphics/Typeface;"]]],
    [6, [[6, "getTypeface", "()Landroid/graphics/Typeface;"]]],
    [7, [
      ...(options.weightApi === false ? [] : [[7, "getWeight", "()I"] as const]),
      ...(options.styleApi === false ? [] : [[8, "getStyle", "()I"] as const]),
      ...(options.familyApi === false ? [] : [[9, "getSystemFontFamilyName", "()Ljava/lang/String;"] as const]),
    ]],
  ]);
  const strings = new Map<number, string>();
  const pins: number[] = [], releases: number[] = [], calls: string[] = [];
  const invokes: { object: number; klass: number; method: number; flags: number }[] = [];
  const sockets = new Set<Socket>();
  let nextString = 1000, disposed = 0, legacyWakes = 0, disconnected = 0;
  let serverFailure: unknown;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); disconnected++; });
    socket.on("error", () => undefined);
    let buffered: Buffer = Buffer.alloc(0), handshaken = false;
    socket.on("data", chunk => {
      try {
        buffered = Buffer.concat([buffered, chunk]);
        if (!handshaken) {
          if (buffered.length < 14) return;
          assert.equal(buffered.subarray(0, 14).toString(), "JDWP-Handshake");
          socket.write(buffered.subarray(0, 14)); buffered = buffered.subarray(14); handshaken = true;
        }
        while (buffered.length >= 11 && buffered.length >= buffered.readUInt32BE()) {
          const packet = buffered.subarray(0, buffered.readUInt32BE());
          buffered = buffered.subarray(packet.length);
          const command = `${packet[9]}/${packet[10]}`, body = packet.subarray(11);
          calls.push(command);
          if (options.onCommand?.(command, socket)) continue;
          let payload: Buffer = Buffer.alloc(0), event = false;
          switch (command) {
            case "1/7": payload = Buffer.concat(Array.from({ length: 5 }, () => int(size))); break;
            case "1/4": payload = Buffer.concat([int(1), id(30)]); break;
            case "11/1": payload = string("main"); break;
            case "1/2": {
              const signature = body.subarray(4).toString(), klass = classes.get(signature);
              assert.ok(klass, `Unexpected class request: ${signature}`);
              payload = Buffer.concat([int(1), Buffer.from([1]), id(klass), int(7)]); break;
            }
            case "2/2": payload = id(options.fakeBootstrap && readId(body) === 5 ? 99 : 0); break;
            case "2/5": {
              const entries = methods.get(readId(body)) ?? [];
              payload = Buffer.concat([int(entries.length), ...entries.flatMap(([mid, name, sig]) => [id(mid), string(name), string(sig), int(1)])]);
              break;
            }
            case "2/4": {
              assert.equal(readId(body), 7);
              const fields = [
                [50, "DEFAULT", "Landroid/graphics/Typeface;"],
                ...(options.fields === false ? [] : [[51, "mWeight", "I"], [52, "mStyle", "I"]]),
              ] as [number, string, string][];
              payload = Buffer.concat([int(fields.length), ...fields.flatMap(([fid, name, sig]) => [id(fid), string(name), string(sig), int(1)])]); break;
            }
            case "15/1":
              assert.deepEqual([...body.subarray(0, 2)], [2, 1], "suspend only the event thread");
              assert.equal(body.readInt32BE(2), 2);
              assert.equal(body[6], 3); assert.equal(readId(body, 7), 30);
              assert.equal(body[7 + size], 7); assert.equal(body[8 + size], 1);
              assert.equal(readId(body, 9 + size), 1); assert.equal(readId(body, 9 + size * 2), 1);
              assert.equal(body.readBigInt64BE(9 + size * 3), 0n);
              payload = int(77); event = true; break;
            case "15/2": assert.equal(body[0], 2); assert.equal(body.readInt32BE(1), 77); break;
            case "199/1":
              legacyWakes++;
              assert.equal(body.subarray(0, 4).toString(), "VUOP");
              assert.equal(body.readInt32BE(8), 2, "only the existing hardware wake operation");
              break;
            case "1/11": strings.set(++nextString, body.subarray(4).toString()); payload = id(nextString); break;
            case "9/7": pins.push(readId(body)); break;
            case "9/8": releases.push(readId(body)); break;
            case "3/3": {
              const klass = readId(body), method = readId(body, size * 2);
              assert.equal(readId(body, size), 30);
              assert.equal(body.readInt32BE(body.length - 4), 1);
              if (method === 3) { assert.equal(klass, 4); payload = result("L", 100); }
              else {
                assert.equal(klass, 3); assert.equal(method, 2);
                assert.equal(body.readInt32BE(size * 3), 2);
                const offset = size * 3 + 4;
                assert.equal(readId(body, offset + 1), 101, "lookup stays inside the verified window");
                const name = strings.get(readId(body, offset + size + 2));
                assert.ok(name === target.rootRef || name === ref);
                payload = result("L", name === target.rootRef ? options.staleRoot ? 999 : 101 : options.missingView ? 0 : 102);
              }
              break;
            }
            case "9/6": {
              const object = readId(body), klass = readId(body, size * 2), method = readId(body, size * 3);
              const flags = body.readInt32BE(body.length - 4);
              assert.equal(readId(body, size), 30);
              if (method === 4) {
                assert.equal(klass, 4); assert.equal(object, 100); assert.equal(flags, 1);
                assert.equal(strings.get(readId(body, size * 4 + 5)), target.windowName);
                payload = result("L", 101); break;
              }
              assert.equal(body.readInt32BE(size * 4), 0, "font getters are zero-argument calls");
              assert.equal(flags, 3, "fixed framework methods bypass business overrides");
              invokes.push({ object, klass, method, flags });
              switch (method) {
                case 5: assert.equal(object, 102); assert.equal(klass, 5); payload = result("L", 103, options.methodException ? 900 : 0); break;
                case 6: assert.equal(object, 103); assert.equal(klass, 6); payload = result("L", options.defaultTypeface ? 0 : 104); break;
                case 7: case 8:
                  assert.equal(object, options.defaultTypeface ? 105 : 104); assert.equal(klass, 7);
                  payload = result(options.integerTag ?? "I", method === 7 ? options.weight ?? 700 : options.style ?? 3); break;
                case 9:
                  assert.equal(object, options.defaultTypeface ? 105 : 104); assert.equal(klass, 7);
                  payload = result(options.family === null ? options.nullStringTag ?? "L" : "s", options.family === null ? 0 : 106); break;
                default: assert.fail(`Unexpected invoked method: ${method}`);
              }
              break;
            }
            case "9/1": {
              const object = readId(body);
              const klass = object === 102 ? 20 : object === 103 ? options.wrongPaintType ? 2 : 21
                : object === 104 || object === 105 ? options.wrongTypefaceType ? 2 : 7 : object === 106 ? options.wrongStringType ? 2 : 8 : 0;
              assert.ok(klass);
              payload = Buffer.concat([Buffer.from([1]), id(klass)]); break;
            }
            case "3/1": {
              const klass = readId(body);
              payload = id(klass === 20 ? options.notTextView ? 2 : 5 : klass === 21 ? 6 : 0); break;
            }
            case "2/6":
              assert.equal(readId(body), 7); assert.equal(body.readInt32BE(size), 1); assert.equal(readId(body, size + 4), 50);
              payload = Buffer.concat([int(1), tagged("L", 105)]); break;
            case "9/2": {
              assert.equal(readId(body), options.defaultTypeface ? 105 : 104);
              assert.equal(body.readInt32BE(size), 1);
              const field = readId(body, size + 4); assert.ok(field === 51 || field === 52);
              payload = Buffer.concat([int(1), tagged(options.integerTag ?? "I", field === 51 ? options.weight ?? 400 : options.style ?? 0)]); break;
            }
            case "10/1":
              assert.equal(readId(body), 106);
              payload = options.stringBytes ?? string(options.family ?? "sans-serif");
              if (options.oversizedString) {
                const header = Buffer.alloc(11); header.writeUInt32BE(11 + 4101);
                packet.copy(header, 4, 4, 8); header[8] = 0x80;
                socket.write(header); continue; // No body: bounded read must reject before waiting for it.
              }
              break;
            case "1/6": disposed++; break;
            default: assert.fail(`Unexpected JDWP command: ${command}`);
          }
          const header = Buffer.alloc(11); header.writeUInt32BE(11 + payload.length);
          packet.copy(header, 4, 4, 8); header[8] = 0x80;
          socket.write(Buffer.concat([header, payload]));
          if (event) {
            const eventData = Buffer.concat([Buffer.from([1]), int(1), Buffer.from([2]), int(77), id(30)]);
            const header = Buffer.alloc(11); header.writeUInt32BE(11 + eventData.length); header[9] = 64; header[10] = 100;
            socket.write(Buffer.concat([header, eventData]));
          }
        }
      } catch (error) {
        serverFailure = error; socket.destroy();
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return {
    port: address.port, pins, releases, calls, invokes,
    get disposed() { return disposed; }, get legacyWakes() { return legacyWakes; }, get disconnected() { return disconnected; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (serverFailure) throw serverFailure;
    },
    assertReleased() { assert.equal(disposed, 1); assert.deepEqual([...pins].sort(), [...releases].sort()); },
  };
}

for (const idSize of [4, 8] as const) test(`font reads the effective Paint Typeface using framework methods (${idSize}-byte IDs)`, async () => {
  const server = await fixture({ idSize });
  try {
    const before = Date.now(), font = await readViewFont(server.port, target, ref);
    assert.deepEqual({ ...font, capturedAtMillis: 0 }, { ref, capturedAtMillis: 0, source: "jdwp", basis: "text-paint",
      familyName: "sans-serif", familyNameStatus: "system-family", weight: 700, style: 3, usesDefaultTypeface: false });
    assert.ok(font.capturedAtMillis >= before && font.capturedAtMillis <= Date.now());
    assert.deepEqual(server.invokes.map(v => v.method), [5, 6, 7, 8, 9]);
    assert.equal(server.legacyWakes, 1);
    server.assertReleased();
    // The strict fixture rejects all bitmap, heap scan, GC, array, mutation,
    // unscoped lookup, subclass override and original Typeface calls.
  } finally { await server.close(); }
});

test("null Paint Typeface resolves DEFAULT and records that choice", async () => {
  const server = await fixture({ defaultTypeface: true, weight: 400, style: 0 });
  try {
    const result = await readViewFont(server.port, target, ref);
    assert.equal(result.usesDefaultTypeface, true); assert.equal(result.weight, 400); assert.equal(result.style, 0);
    assert.ok(server.calls.includes("2/6")); server.assertReleased();
  } finally { await server.close(); }
});

test("unexposed family remains unknown for both null reference tags", async () => {
  for (const nullStringTag of ["L", "s"] as const) {
    const server = await fixture({ family: null, nullStringTag });
    try {
      const result = await readViewFont(server.port, target, ref);
      assert.equal(result.familyName, null); assert.equal(result.familyNameStatus, "not-exposed");
      assert.equal(server.calls.includes("10/1"), false); server.assertReleased();
    } finally { await server.close(); }
  }
});

test("old systems use only verified integer fields and do not guess family or missing values", async () => {
  for (const fields of [true, false]) {
    const server = await fixture({ familyApi: false, weightApi: false, styleApi: false, fields, weight: 1, style: 0 });
    try {
      const result = await readViewFont(server.port, target, ref);
      assert.equal(result.familyName, null); assert.equal(result.familyNameStatus, "unsupported");
      assert.equal(result.weight, fields ? 1 : null); assert.equal(result.style, fields ? 0 : null);
      assert.equal(server.calls.includes("9/2"), fields); server.assertReleased();
    } finally { await server.close(); }
  }
});

test("root, View identity, inheritance and framework loader failures stop font reads", async () => {
  for (const [options, pattern] of [
    [{ staleRoot: true }, /身份已变化/], [{ missingView: true }, /已不在当前窗口/],
    [{ notTextView: true }, /不是原生 TextView/], [{ fakeBootstrap: true }, /class ambiguous/],
  ] as const) {
    const server = await fixture(options);
    try {
      await assert.rejects(readViewFont(server.port, target, ref), pattern);
      assert.equal(server.invokes.length, 0); server.assertReleased();
    } finally { await server.close(); }
  }
});

test("malformed font objects, values and strings are rejected and release the debugger", async () => {
  const badStrings = [Buffer.from([0, 0, 0, 2, 65]), Buffer.from([0, 0, 0, 0]), Buffer.from([0, 0, 0, 1, 255]),
    Buffer.from([0, 0, 0, 1, 0]), Buffer.from([0, 0, 16, 1])];
  for (const options of [
    { wrongPaintType: true }, { wrongTypefaceType: true }, { wrongStringType: true }, { integerTag: "F" },
    { methodException: true }, { weight: 0 }, { weight: -1 }, { weight: 1001 }, { style: 4 }, ...badStrings.map(stringBytes => ({ stringBytes })),
  ]) {
    const server = await fixture(options);
    try { await assert.rejects(readViewFont(server.port, target, ref)); server.assertReleased(); }
    finally { await server.close(); }
  }
});

test("oversized StringReference responses disconnect before waiting for the payload", async () => {
  const server = await fixture({ oversizedString: true });
  try {
    await assert.rejects(readViewFont(server.port, target, ref), /exceeds read limit/);
    assert.equal(server.disposed, 0, "a desynchronized stream is closed rather than reused");
  } finally { await server.close(); }
});

test("software windows require the existing safe wake callback", async () => {
  const server = await fixture();
  try {
    await assert.rejects(readViewFont(server.port, { ...target, hardwareAccelerated: false }, ref), /安全唤醒/);
    assert.equal(server.legacyWakes, 0); assert.equal(server.invokes.length, 0); server.assertReleased();
  } finally { await server.close(); }
  const safeServer = await fixture(); let wakes = 0;
  try {
    await readViewFont(safeServer.port, { ...target, hardwareAccelerated: false, wakeUi: async () => { wakes++; } }, ref);
    assert.equal(wakes, 1); assert.equal(safeServer.legacyWakes, 0); safeServer.assertReleased();
  } finally { await safeServer.close(); }
});

test("abort during a stalled read or wake closes the connection promptly and preserves its reason", async () => {
  for (const phase of ["read", "wake", "cleanup"] as const) {
    const controller = new AbortController(), reason = new Error("user canceled font read");
    const server = await fixture({ onCommand: command => {
      if (phase === "read" && command === "10/1" || phase === "cleanup" && command === "9/8") { controller.abort(reason); return true; }
    } });
    try {
      const started = performance.now();
      const wakeUi = phase === "wake" ? async () => { controller.abort(reason); await new Promise<void>(() => undefined); } : undefined;
      await assert.rejects(readViewFont(server.port, { ...target, wakeUi }, ref, controller.signal), error => error === reason);
      assert.ok(performance.now() - started < 2000);
    } finally { await server.close(); }
  }
});
