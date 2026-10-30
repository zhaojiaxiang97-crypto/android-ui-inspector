import assert from "node:assert/strict";

// ART Android 14 non-streaming v3 dual-clock format (runtime/trace.cc).
// Sampling attributes CPU between observations to the previous stack, not exact calls.
export function parseMethodProfile(data: Buffer, expectedPid: string, encoderName = "inspector-encode") {
  assert.ok(["inspector-encode", "geometry-encode"].includes(encoderName), "Unknown encoder role");
  assert.ok(/^\d+$/.test(expectedPid) && data.length <= 32 * 1024 * 1024, "Invalid profile target/budget");
  const boundary = data.indexOf(Buffer.from("*end\n"));
  assert.ok(boundary >= 0 && boundary <= 1024 * 1024, "Missing/oversized trace header");
  const header = data.subarray(0, boundary).toString("utf8");
  assert.match(header, /^\*version\n3\n/);
  assert.match(header, /\ndata-file-overflow=false\n/);
  assert.match(header, /\nclock=dual\n/);
  assert.equal(/\npid=(\d+)\n/.exec(header)?.[1], expectedPid, "Trace process changed");
  const [, threadText, methodText] = header.split(/\*threads\n|\*methods\n/);
  assert.ok(threadText && methodText, "Missing trace dictionaries");
  const threads = new Map<number, string>();
  for (const line of threadText.trim().split("\n")) {
    const [tid, name] = line.split("\t");
    assert.ok(/^\d+$/.test(tid!) && name && !threads.has(Number(tid)), "Invalid thread dictionary");
    threads.set(Number(tid), name);
  }
  const methods = new Map<number, string>();
  for (const line of methodText.trim().split("\n")) {
    const [id, cls, name, signature] = line.split("\t");
    assert.ok(/^(?:0|0x[\da-f]+)$/i.test(id!) && cls && name && signature, "Invalid method dictionary");
    const key = Number(id);
    assert.ok(key % 4 === 0 && !methods.has(key), "Duplicate/unaligned method");
    methods.set(key, `${cls}.${name}${signature}`);
  }
  const selected = [...threads].filter(([tid, name]) => tid === Number(expectedPid) || name === encoderName);
  assert.ok(selected.some(([tid, name]) => tid === Number(expectedPid) && name === "main"), "Missing main thread");
  assert.equal(selected.filter(([, name]) => name === encoderName).length, 2, "Missing real encoders");
  // Trace records store only 16-bit TIDs. Reject collisions rather than misattribute.
  assert.ok(selected.every(([tid]) => tid <= 65535 && [...threads.keys()].filter(value => (value & 65535) === tid).length === 1), "Ambiguous trace TID");
  const states = new Map(selected.map(([tid, name]) => [tid, { tid, name, stack: [] as number[], cpu: undefined as number | undefined,
    wall: undefined as number | undefined, firstWall: undefined as number | undefined, firstCpu: undefined as number | undefined,
    cpuUs: 0, intervals: 0, self: new Map<number, number>(), inclusive: new Map<number, number>(),
    sampledStacks: new Map<string, { ids: number[]; cpuUs: number; wallUs: number; intervals: number }>() }]));
  const binary = boundary + 5;
  assert.ok(data.length >= binary + 32, "Short binary header");
  assert.equal(data.readUInt32LE(binary), 0x574f4c53);
  assert.equal(data.readUInt16LE(binary + 4), 3);
  assert.equal(data.readUInt16LE(binary + 6), 32);
  assert.equal(data.readUInt16LE(binary + 16), 14);
  const offset = binary + 32;
  assert.equal((data.length - offset) % 14, 0, "Partial trace record");
  const records = (data.length - offset) / 14;
  assert.equal(Number(/\nnum-method-calls=(\d+)\n/.exec(header)?.[1]), records, "Trace count mismatch");
  for (let at = offset; at < data.length; at += 14) {
    const tid = data.readUInt16LE(at), encoded = data.readUInt32LE(at + 2);
    const id = (encoded & 0xfffffffc) >>> 0, action = encoded & 3;
    assert.ok(action <= 2 && methods.has(id), "Unknown trace action/method");
    const state = states.get(tid);
    if (!state) continue;
    const cpu = data.readUInt32LE(at + 6), wall = data.readUInt32LE(at + 10);
    if (state.firstWall === undefined) { state.firstWall = wall; state.firstCpu = cpu; }
    assert.ok(state.cpu === undefined || (cpu >= state.cpu && wall >= state.wall!), "Trace clocks went backwards");
    if (state.cpu !== undefined && state.stack.length) {
      const delta = cpu - state.cpu;
      const wallDelta = wall - state.wall!;
      const stackKey = state.stack.join(",");
      let sampled = state.sampledStacks.get(stackKey);
      if (!sampled) {
        assert.ok(state.sampledStacks.size < 4096, "Sampled stack budget exceeded");
        sampled = { ids: [...state.stack], cpuUs: 0, wallUs: 0, intervals: 0 };
        state.sampledStacks.set(stackKey, sampled);
      }
      sampled.cpuUs += delta; sampled.wallUs += wallDelta; sampled.intervals++;
      state.cpuUs += delta; state.intervals += delta > 0 ? 1 : 0;
      const leaf = state.stack[state.stack.length - 1]!;
      state.self.set(leaf, (state.self.get(leaf) ?? 0) + delta);
      for (const parent of new Set(state.stack)) state.inclusive.set(parent, (state.inclusive.get(parent) ?? 0) + delta);
    }
    state.cpu = cpu; state.wall = wall;
    if (action === 0) { state.stack.push(id); assert.ok(state.stack.length <= 512, "Stack budget exceeded"); }
    else assert.equal(state.stack.pop(), id, "Unbalanced sampled stack");
  }
  const rank = (values: Map<number, number>) => [...values].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([id, cpuUs]) => ({ method: methods.get(id)!, cpuUs }));
  assert.ok([...states.values()].every(state => state.intervals > 0), "Need observed CPU intervals for main and both encoders");
  return { format: "ART-v3-dual-sampling", records, bytes: data.length, approximate: true,
    threads: [...states.values()].map(state => ({ tid: state.tid, name: state.name, cpuUs: state.cpuUs, intervals: state.intervals,
      observedWallUs: state.wall! - state.firstWall!, observedCpuUs: state.cpu! - state.firstCpu!,
      // Wall minus thread CPU includes sleeps, native blocking and descheduling; it is not run-queue time.
      nonCpuUs: (state.wall! - state.firstWall!) - (state.cpu! - state.firstCpu!),
      // Previous sampled Java stack only: no native frames, lock owner or exact blocked duration.
      waitingStacks: [...state.sampledStacks.values()].sort((a, b) => (b.wallUs - b.cpuUs) - (a.wallUs - a.cpuUs)).slice(0, 20)
        .map(sample => ({ stack: sample.ids.map(id => methods.get(id)!), wallUs: sample.wallUs,
          cpuUs: sample.cpuUs, nonCpuUs: sample.wallUs - sample.cpuUs, intervals: sample.intervals })),
      self: rank(state.self), sdkInclusive: rank(new Map([...state.inclusive].filter(([id]) => methods.get(id)!.startsWith("com.androiduiinspector.sdk.")))),
      jsonInclusive: rank(new Map([...state.inclusive].filter(([id]) => methods.get(id)!.startsWith("org.json.")))) })) };
}
