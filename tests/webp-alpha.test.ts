import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { getEventListeners } from "node:events";
import { resolve } from "node:path";
import sharp from "sharp";
import { rgbaIsEmpty, validImageSize, webpImageSize } from "../electron/desktop/layer-image-alpha";
import { createWebpAlphaDecoder } from "../electron/desktop/webp-alpha";
import { webpImages } from "./fixtures/webp-images";

mkdirSync(resolve(".benchmarks"), { recursive: true });
const output = mkdtempSync(resolve(".benchmarks/webp-alpha-tests-"));
execFileSync("node", ["scripts/build-webp-alpha.mjs", output], { stdio: "pipe" });
const workerFile = resolve(output, "webp-alpha-worker.cjs"), size = { width: 2, height: 2 };
const fixture = () => Buffer.from(webpImages[0].data, "base64");

test("alpha preflight bounds dimensions and requires full RGBA bytes", () => {
  for (const value of [null, { width: 0, height: 2 }, { width: -1, height: 2 }, { width: NaN, height: 2 },
    { width: 1.5, height: 2 }, { width: 2001, height: 2000 }]) assert.equal(validImageSize(value), false);
  assert.equal(validImageSize({ width: 2000, height: 2000 }), true);
  const pixels = new Uint8Array(16); pixels[0] = 255;
  assert.equal(rgbaIsEmpty(pixels, size), true);
  pixels[15] = 1; assert.equal(rgbaIsEmpty(pixels, size), false);
  assert.equal(rgbaIsEmpty(pixels.subarray(0, 15), size), undefined);
});

for (const image of webpImages) test(`WebP alpha reads every pixel: ${image.name}`, async () => {
  const decoder = createWebpAlphaDecoder({ workerFile });
  try {
    const bytes = Buffer.from(image.data, "base64"), before = Buffer.from(bytes);
    assert.deepEqual(webpImageSize(bytes), size);
    assert.equal(await decoder.measure(bytes, size), image.alpha === 0);
    assert.deepEqual(bytes, before, "encoded/displayed image must remain unchanged");
  } finally { await decoder.dispose(); }
});

test("WebP without an alpha channel is decoded as visible, not guessed from header flags", async () => {
  const bytes = await sharp(Buffer.alloc(16, 255), { raw: { ...size, channels: 4 } }).removeAlpha().webp().toBuffer();
  const decoder = createWebpAlphaDecoder({ workerFile });
  try { assert.equal(await decoder.measure(bytes, size), false); }
  finally { await decoder.dispose(); }
});

test("WebP preflight rejects truncation, trailing bytes, wrong chunks, duplicate frames and bad padding", () => {
  const data = fixture(), invalid = Buffer.from(data); invalid.writeUInt32LE(0xffffffff, 16);
  const duplicate = Buffer.concat([data, data.subarray(12)]); duplicate.writeUInt32LE(duplicate.length - 8, 4);
  const padding = Buffer.from(data); padding[padding.length - 1] = 1;
  for (const bytes of [Buffer.from("bad"), data.subarray(0, 26), Buffer.concat([data, Buffer.from([0])]), invalid, duplicate, padding])
    assert.equal(webpImageSize(bytes), null);
});

test("oversized encoded canvas cannot hide behind small declared dimensions", async () => {
  const big = fixture(); big[21] = 255; big[22] = 255; big[23] = 255; big[24] = 0x1f;
  const bigCanvas = Buffer.from(webpImages[3].data, "base64"); bigCanvas.writeUIntLE(0xffffff, 24, 3);
  const mismatchCanvas = Buffer.from(webpImages[3].data, "base64"); mismatchCanvas.writeUIntLE(2, 24, 3);
  const decoder = createWebpAlphaDecoder({ workerFile });
  try {
    for (const data of [big, bigCanvas, mismatchCanvas, Buffer.alloc(10_000_001)]) {
      assert.equal(webpImageSize(data), null);
      assert.equal(await decoder.measure(data, size), undefined);
    }
    assert.equal(await decoder.measure(fixture(), { width: 3, height: 2 }), undefined);
    assert.equal(await decoder.measure(fixture(), size), true);
  } finally { await decoder.dispose(); }
});

test("animated WebP is unknown, never a first-frame transparency result", async () => {
  const data = Buffer.from(webpImages[3].data, "base64"); data[20] |= 0x02;
  const decoder = createWebpAlphaDecoder({ workerFile });
  try { assert.equal(webpImageSize(data), null); assert.equal(await decoder.measure(data, size), undefined); }
  finally { await decoder.dispose(); }
});

test("complete header but corrupt pixels remain unknown, and the next valid image still works", async () => {
  const bad = fixture(); bad.fill(0xff, 25, bad.length - 1);
  const decoder = createWebpAlphaDecoder({ workerFile });
  try {
    assert.deepEqual(webpImageSize(bad), size);
    assert.equal(await decoder.measure(bad, size), undefined);
    assert.equal(await decoder.measure(fixture(), size), true);
  } finally { await decoder.dispose(); }
});

test("decoder timeout stops a stalled worker, does not retry, and ignores its late answer", async () => {
  const decoder = createWebpAlphaDecoder({ workerFile: resolve("tests/fixtures/webp-worker-stall.cjs"), timeoutMs: 100 });
  const start = performance.now();
  try {
    assert.equal(await decoder.measure(fixture(), size), undefined);
    assert.equal(await decoder.measure(fixture(), size), undefined);
  } finally { await decoder.dispose(); }
  assert.ok(performance.now() - start < 1000, "worker teardown must not wait for the 2s stalled decode");
});

test("cancellation preserves its original reason and removes signal listeners", async () => {
  const signal = new AbortController(), reason = new Error("stop this request");
  const decoder = createWebpAlphaDecoder({ workerFile: resolve("tests/fixtures/webp-worker-stall.cjs") });
  const pending = decoder.measure(fixture(), size, signal.signal);
  signal.abort(reason);
  try { await assert.rejects(pending, error => error === reason); }
  finally { await decoder.dispose(); }
  assert.equal(getEventListeners(signal.signal, "abort").length, 0);
  await assert.rejects(decoder.measure(fixture(), size, signal.signal), error => error === reason);
});

test("whole-pass budget is shared across pictures and does not spawn a replacement worker", async () => {
  const decoder = createWebpAlphaDecoder({ workerFile: resolve("tests/fixtures/webp-worker-stall.cjs"), budgetMs: 50 });
  try {
    assert.equal(await decoder.measure(fixture(), size), undefined);
    const start = performance.now();
    assert.equal(await decoder.measure(fixture(), size), undefined);
    assert.ok(performance.now() - start < 30);
  } finally { await decoder.dispose(); }
});

test("first request allows bounded native loading, later requests keep the shorter timeout", async () => {
  const decoder = createWebpAlphaDecoder({ workerFile: resolve("tests/fixtures/webp-worker-delay.cjs") });
  try {
    assert.equal(await decoder.measure(fixture(), size), true);
    assert.equal(await decoder.measure(fixture(), size), undefined);
    assert.equal(await decoder.measure(fixture(), size), undefined);
  } finally { await decoder.dispose(); }
});

test("missing decoder and crashed worker are unknown without unhandled errors", async () => {
  for (const file of [resolve(output, "missing.cjs"), resolve("tests/fixtures/webp-worker-crash.cjs")]) {
    const decoder = createWebpAlphaDecoder({ workerFile: file });
    try { assert.equal(await decoder.measure(fixture(), size), undefined); }
    finally { await decoder.dispose(); }
  }
});

test("sequential reuse cleans request listeners and explicit disposal rejects further work", async () => {
  const decoder = createWebpAlphaDecoder({ workerFile }), controller = new AbortController();
  try {
    for (let index = 0; index < 20; index++) assert.equal(await decoder.measure(fixture(), size, controller.signal), true);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally { await decoder.dispose(); }
  assert.equal(await decoder.measure(fixture(), size), undefined);
});
