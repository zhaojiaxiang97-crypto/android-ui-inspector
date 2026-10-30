import { test } from "node:test";
import assert from "node:assert/strict";
import { SdkPreviewPrefix } from "../electron/sdk/sdk-preview-prefix";

const nonce = "0123456789abcdef";
const prefix = () => Buffer.concat([Buffer.from(nonce, "hex"), Buffer.alloc(24)]);

test("below-cap prefix keeps polling without extra device queries", () => {
  const gate = new SdkPreviewPrefix();
  assert.equal(gate.shouldRead(), true);
  gate.accept(prefix(), nonce, () => []);
  assert.equal(gate.shouldRead(), true);
  assert.equal(gate.metrics.skipped, 0);
});

test("state is local to a request", () => {
  const gate = new SdkPreviewPrefix();
  const data = Buffer.alloc(SdkPreviewPrefix.limit);
  Buffer.from(nonce, "hex").copy(data);
  gate.accept(data, nonce, () => []);
  assert.equal(gate.shouldRead(), false);
  assert.equal(new SdkPreviewPrefix().shouldRead(), true);
});

test("wrong nonce, short data and parser rejection never seed cache", () => {
  const gate = new SdkPreviewPrefix();
  gate.accept(Buffer.alloc(32), nonce, () => []);
  gate.accept(Buffer.alloc(7), nonce, () => []);
  assert.equal(gate.capped, false);
  assert.throws(() => gate.accept(prefix(), nonce, () => { throw new Error("CRC"); }), /CRC/);
  assert.equal(gate.shouldRead(), true);
});

test("validated prefix at cap stops optional reads only", () => {
  const gate = new SdkPreviewPrefix();
  const data = Buffer.alloc(SdkPreviewPrefix.limit);
  Buffer.from(nonce, "hex").copy(data);
  gate.accept(data, nonce, () => []);
  assert.equal(gate.capped, true);
  assert.equal(gate.shouldRead(), false);
});
