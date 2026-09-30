// Usage: bun scripts/sdk-visible-profile.ts SERIAL DEBUG_PACKAGE
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { inflateSync } from "node:zlib";

const [serial, packageName] = process.argv.slice(2);
if (!serial || !/^[A-Za-z0-9._:-]+$/.test(serial) || !packageName || !/^[A-Za-z0-9_.]+$/.test(packageName) || process.argv.length !== 4) {
  throw new Error("Usage: bun scripts/sdk-visible-profile.ts SERIAL DEBUG_PACKAGE");
}

async function adb(...args: string[]) {
  return await new Promise<{ stdout: Buffer; stderr: string; code: number | null }>((resolve, reject) => {
    const process = spawn("adb", ["-s", serial, ...args]);
    const output: Buffer[] = [], errors: Buffer[] = [];
    const timeout = setTimeout(() => process.kill("SIGKILL"), args.includes("capture-visible") ? 70_000 : 15_000);
    process.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", (error) => { clearTimeout(timeout); reject(error); });
    process.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout: Buffer.concat(output), stderr: Buffer.concat(errors).toString(), code });
    });
  });
}

const base = "no_backup/inspector-visible-layers.bin";
const nonce = randomBytes(8).toString("hex");
function transparentPng(png: Buffer): boolean | null {
  if (png[24] !== 8 || png[25] !== 6 || png[28] !== 0) return null; // Only 8-bit non-interlaced RGBA.
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const chunks: Buffer[] = [];
  for (let at = 8; at + 12 <= png.length;) {
    const length = png.readUInt32BE(at), end = at + 12 + length;
    assert.ok(end <= png.length, "PNG chunk exceeds file");
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
    at = end;
  }
  const bytes = inflateSync(Buffer.concat(chunks));
  assert.equal(bytes.length, height * (width * 4 + 1));
  // PNG filters act on each color channel separately: every alpha residual is zero iff all source alpha is zero.
  for (let row = 0; row < height; row++) {
    const start = row * (width * 4 + 1) + 4;
    for (let column = 0; column < width; column++) if (bytes[start + column * 4] !== 0) return false;
  }
  return true;
}
try {
async function mainPid() {
  const pid = (await adb("shell", "pidof", "-s", packageName)).stdout.toString().trim();
  assert.match(pid, /^\d+$/, "Debug App main process must be running");
  return pid;
}
const pidBefore = await mainPid();

const started = performance.now();
let finished = false;
const request = adb("shell", "content", "call", "--uri", `content://${packageName}.inspector`, "--method", "capture-visible", "--arg", nonce)
  .finally(() => { finished = true; });
const samples: { ms: number; bytes: number }[] = [];
while (!finished) {
  const result = await adb("shell", "run-as", packageName, "stat", "-c", "%s", `${base}.tmp`);
  const value = result.stdout.toString().trim();
  if (result.code === 0 && /^\d+$/.test(value)) samples.push({ ms: Math.round(performance.now() - started), bytes: Number(value) });
  await wait(100);
}
const reply = await request;
assert.equal(reply.code, 0, reply.stderr);
const response = reply.stdout.toString();
const field = (name: string) => new RegExp(`\\b${name}=([^,}\\]]+)`).exec(response)?.[1];
assert.equal(field("result"), "ok", field("error") ?? response);
assert.equal(field("nonce"), nonce);
assert.equal(await mainPid(), pidBefore, "App restarted during capture");

const file = await adb("exec-out", "run-as", packageName, "cat", base);
assert.equal(file.code, 0, file.stderr);
assert.equal(file.stdout.length, Number(field("bytes")));
assert.equal(createHash("sha256").update(file.stdout).digest("hex"), field("sha256"));
assert.equal(file.stdout.subarray(0, 8).toString("hex"), nonce);

const records: { end: number; pngAt: number; pixels: number; pngBytes: number; className: string; hash: string }[] = [];
let offset = 8;
while (file.stdout[offset] === 1) {
  const nameBytes = file.stdout.readUInt16BE(offset + 1);
  const className = file.stdout.subarray(offset + 3, offset + 3 + nameBytes).toString().split("@")[0];
  const imageLengthAt = offset + 3 + nameBytes + 9;
  const pngBytes = file.stdout.readUInt32BE(imageLengthAt);
  const pngAt = imageLengthAt + 4;
  const png = file.stdout.subarray(pngAt, pngAt + pngBytes);
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  records.push({ end: pngAt + pngBytes, pngAt, pixels: png.readUInt32BE(16) * png.readUInt32BE(20), pngBytes, className,
    hash: createHash("sha256").update(png).digest("hex") });
  offset = pngAt + pngBytes;
}
assert.equal(file.stdout[offset], 2);
assert.equal(offset + 1, file.stdout.length);
assert.equal(records.length, Number(field("count")));

let seen = 0, previousMs = 0;
const single: { ms: number; pixels: number; pngBytes: number; className: string }[] = [];
for (const sample of samples) {
  let next = seen;
  while (next < records.length && records[next].end <= sample.bytes) next++;
  if (next === seen + 1) {
    const record = records[seen];
    single.push({ ms: sample.ms - previousMs, pixels: record.pixels, pngBytes: record.pngBytes, className: record.className });
  }
  if (next > seen) { seen = next; previousMs = sample.ms; }
}

const largest = [...single].sort((a, b) => b.ms - a.ms).slice(0, 8);
const copies = new Map<string, { count: number; pixels: number; pngBytes: number }>();
for (const record of records) {
  const previous = copies.get(record.hash);
  if (previous) previous.count++;
  else copies.set(record.hash, { count: 1, pixels: record.pixels, pngBytes: record.pngBytes });
}
const repeated = [...copies.values()].filter((item) => item.count > 1);
const largeSmallPngs = records.filter((item) => item.pixels >= 1_000_000 && item.pngBytes < 20_000);
const alphaByHash = new Map<string, boolean | null>();
for (const record of largeSmallPngs) if (!alphaByHash.has(record.hash)) {
  alphaByHash.set(record.hash, transparentPng(file.stdout.subarray(record.pngAt, record.end)));
}
const largeTransparent = largeSmallPngs.filter((item) => alphaByHash.get(item.hash) === true);
console.log(JSON.stringify({
  count: records.length, durationMs: Number(field("durationMs")), renderMs: Number(field("renderMs")),
  encodeMs: Number(field("encodeMs")), polls: samples.length, oneImageIntervals: single.length,
  imageDigest: createHash("sha256").update(records.map((item) => item.hash).join("")).digest("hex"),
  pngBytes: records.reduce((sum, item) => sum + item.pngBytes, 0),
  pixels: records.reduce((sum, item) => sum + item.pixels, 0),
  repeatedPngGroups: repeated.length,
  repeatedPngImages: repeated.reduce((sum, item) => sum + item.count, 0),
  repeatedPngPixels: repeated.reduce((sum, item) => sum + (item.count - 1) * item.pixels, 0),
  largeSmallPngs: largeSmallPngs.length,
  largeSmallPngPixels: largeSmallPngs.reduce((sum, item) => sum + item.pixels, 0),
  largeTransparentPngs: largeTransparent.length,
  largeTransparentPixels: largeTransparent.reduce((sum, item) => sum + item.pixels, 0),
  reusableLargeTransparentPixels: [...copies.entries()].reduce((sum, [hash, item]) =>
    sum + (alphaByHash.get(hash) === true ? (item.count - 1) * item.pixels : 0), 0),
  largestSingleCompletionGaps: largest,
}, null, 2));
} finally {
  await adb("shell", "run-as", packageName, "rm", "-f", base).catch(() => undefined);
}
