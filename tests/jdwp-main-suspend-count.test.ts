import assert from "node:assert/strict";
import { test } from "node:test";
import { readMainSuspendCount } from "../scripts/jdwp-main-suspend-count";
test("suspension diagnostic only sends ID, thread, name and count reads", async () => {
  const calls: number[][] = [];
  const sizes = Buffer.alloc(20); sizes.writeInt32BE(8, 8);
  const threads = Buffer.alloc(12); threads.writeInt32BE(1); threads[11] = 7;
  const name = Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from("main")]);
  const result = await readMainSuspendCount(async (set, operation, id) => {
    calls.push([set, operation]);
    if (set === 1 && operation === 7) return sizes;
    if (set === 1 && operation === 4) return threads;
    assert.equal(id?.toString("hex"), "0000000000000007");
    if (set === 11 && operation === 1) return name;
    assert.equal(operation, 12); return Buffer.alloc(4);
  });
  assert.equal(result.suspendCount, 0);
  assert.deepEqual(calls, [[1, 7], [1, 4], [11, 1], [11, 12]]);
});
test("suspension diagnostic rejects malformed IDs, thread tables and counts", async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(20)]) {
    await assert.rejects(readMainSuspendCount(async () => bytes));
  }
  const sizes = Buffer.alloc(20); sizes.writeInt32BE(8, 8);
  await assert.rejects(readMainSuspendCount(async (_set, operation) => operation === 7 ? sizes : Buffer.alloc(4)));
});
