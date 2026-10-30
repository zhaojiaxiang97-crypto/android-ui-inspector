import assert from "node:assert/strict";

/** Read-only: never suspend, resume, invoke methods or fetch frames. */
export async function readMainSuspendCount(request: (set: number, operation: number, data?: Buffer) => Promise<Buffer>) {
  const deadline = performance.now() + 3000;
  const read = async (set: number, operation: number, data?: Buffer) => {
    if (performance.now() >= deadline) throw new Error("main suspension diagnostic exceeded read budget");
    const reply = await request(set, operation, data);
    if (performance.now() >= deadline) throw new Error("main suspension diagnostic exceeded read budget");
    return reply;
  };
  const sizes = await read(1, 7);
  assert.equal(sizes.length, 20);
  const size = sizes.readInt32BE(8); assert.ok(size === 4 || size === 8);
  const threads = await read(1, 4); assert.ok(threads.length >= 4);
  const count = threads.readInt32BE(0); assert.ok(count > 0 && count <= 5000);
  assert.equal(threads.length, 4 + count * size);
  for (let i = 0; i < count; i++) {
    const id = threads.subarray(4 + i * size, 4 + (i + 1) * size);
    const name = await read(11, 1, id);
    assert.ok(name.length >= 4 && name.readUInt32BE(0) === name.length - 4);
    if (name.subarray(4).toString() !== "main") continue;
    const value = await read(11, 12, id); assert.equal(value.length, 4);
    const suspendCount = value.readInt32BE(0); assert.ok(suspendCount >= 0);
    return { thread: id.toString("hex"), suspendCount };
  }
  throw new Error("main thread unavailable for suspension check");
}
