import assert from "node:assert/strict";
import { test } from "node:test";
import { requestJdwpMetadataBatch } from "../electron/capture/jdwp-transport";

function packet(id: number, payload: string, error = 0, event = false) {
  const data = Buffer.from(payload), header = Buffer.alloc(11);
  header.writeUInt32BE(11 + data.length); header.writeUInt32BE(id, 4);
  header[8] = event ? 0 : 0x80; header.writeUInt16BE(error, 9);
  return Buffer.concat([header, data]);
}
function fixture(data: Buffer) {
  let offset = 0; const writes: Buffer[] = [];
  return { writes, remaining: () => data.length - offset,
    socket: { write(value: Buffer) { writes.push(value); return true; } },
    reader: { async take(size: number) { if (offset + size > data.length) throw new Error("closed");
      const result = data.subarray(offset, offset + size); offset += size; return result; } } };
}
const requests = [1, 2, 3].map(id => ({ id, set: 1, operation: 2, data: Buffer.from("class" + id) }));

test("metadata sends once and matches reversed replies with interleaved events", async () => {
  const f = fixture(Buffer.concat([packet(3, "third"), packet(90, "event", 0, true), packet(1, "first"), packet(2, "second")]));
  const events: Buffer[] = [];
  const result = await requestJdwpMetadataBatch(f.socket, f.reader, requests, events);
  assert.deepEqual(result.map(r => r.toString()), ["first", "second", "third"]);
  assert.equal(f.writes.length, 1); assert.equal(f.remaining(), 0);
  assert.deepEqual(events.map(r => r.toString()), ["event"]);
  let offset = 0;
  for (const r of requests) {
    const size = f.writes[0].readUInt32BE(offset);
    assert.equal(f.writes[0].readUInt32BE(offset + 4), r.id);
    assert.equal(f.writes[0][offset + 9], 1); assert.equal(f.writes[0][offset + 10], 2);
    offset += size;
  }
  assert.equal(offset, f.writes[0].length);
});

test("metadata drains errors before cleanup and preserves next reply", async () => {
  const f = fixture(Buffer.concat([packet(2, "", 99), packet(3, "third"), packet(1, "first"), packet(4, "cleanup")]));
  await assert.rejects(requestJdwpMetadataBatch(f.socket, f.reader, requests, []), /JDWP 1\/2: 99/);
  const result = await requestJdwpMetadataBatch(f.socket, f.reader, [{ id: 4, set: 2, operation: 5, data: Buffer.alloc(4) }], []);
  assert.equal(result[0].toString(), "cleanup");
});

test("metadata rejects mutation, duplicate IDs, empty and oversized batches before writing", async () => {
  for (const invalid of [[], [...requests, requests[0]], Array.from({ length: 9 }, (_, id) => ({ ...requests[0], id })),
    [{ ...requests[0], set: 1, operation: 6 }], [{ ...requests[0], set: 9, operation: 6 }]]) {
    const f = fixture(Buffer.alloc(0));
    await assert.rejects(requestJdwpMetadataBatch(f.socket, f.reader, invalid, []), /Invalid JDWP metadata batch/);
    assert.equal(f.writes.length, 0);
  }
});

test("metadata rejects unknown and duplicate replies, invalid lengths and interrupted reads", async () => {
  const short = Buffer.alloc(11); short.writeUInt32BE(10);
  for (const data of [packet(99, "unknown"), Buffer.concat([packet(1, "first"), packet(1, "duplicate")]), short, Buffer.alloc(0)]) {
    const f = fixture(data);
    await assert.rejects(requestJdwpMetadataBatch(f.socket, f.reader, requests, []), /Unexpected|Invalid|closed/);
  }
});

test("cancel with metadata requests outstanding preserves reason; a fresh reader recovers", async () => {
  const controller = new AbortController(), reason = new Error("cancel-metadata-batch");
  let writes = 0;
  const pending = requestJdwpMetadataBatch({ write() { writes++; return true; } }, {
    take() { return new Promise<Buffer>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })); }
  }, requests, []);
  assert.equal(writes, 1, "all read-only requests are already sent before interruption");
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  const recovered = fixture(Buffer.concat([packet(3, "third"), packet(2, "second"), packet(1, "first")]));
  const replies = await requestJdwpMetadataBatch(recovered.socket, recovered.reader, requests, []);
  assert.deepEqual(replies.map(r => r.toString()), ["first", "second", "third"]);
});
