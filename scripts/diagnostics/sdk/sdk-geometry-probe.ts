// Start sample with --es mode capture-geometry, then run: bun scripts/diagnostics/sdk/sdk-geometry-probe.ts SERIAL
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { parseCapturedViewLayers } from "../../../electron/capture/view-protocol";
import { parseCaptureGeometryEvidence } from "../../../electron/capture/layer-images";
import { captureScreenQuad } from "../../../shared/capture-transform";
import { setTimeout as wait } from "node:timers/promises";

const serial = process.argv[2];
if (!serial || !/^[\w.:-]+$/.test(serial)) throw new Error("Usage: bun scripts/diagnostics/sdk/sdk-geometry-probe.ts SERIAL");
const pkg = "com.androiduiinspector.sample";
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 70_000, maxBuffer: 64_000_000 });
function pixel(imageDataUrl: string, x: number, y: number) {
  const image = Buffer.from(imageDataUrl.split(",")[1], "base64");
  return [...execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", `format=rgba,crop=1:1:${x}:${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: image, timeout: 10_000, maxBuffer: 1024 })];
}
const previous = new Map<string, string>();
let checked = 0, moved = 0;
let treeReply = "";
const readyDeadline = performance.now() + 10_000;
do {
  treeReply = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "capture").toString();
  if (/result=ok/.test(treeReply) || !/Window is detached|No resumed Activity/.test(treeReply)) break;
  await wait(300);
} while (performance.now() < readyDeadline);
assert.match(treeReply, /result=ok/);
const tree = JSON.parse(adb("exec-out", "run-as", pkg, "cat", "no_backup/inspector-hierarchy.json").toString());
const queue = [tree.root];
let mutatingRef: string | undefined;
let parentMutatingRef: string | undefined;
let parentClipMutatingRef: string | undefined;
let nestedMarkerRef: string | undefined;
const markerRefs: string[] = [];
while (queue.length) {
  const node = queue.pop();
  if (node.className.endsWith("$MutatingGeometryMarker")) mutatingRef = node.ref;
  if (node.className.endsWith("$ParentMutatingGeometryMarker")) parentMutatingRef = node.ref;
  if (node.className.endsWith("$ParentClipMutatingMarker")) parentClipMutatingRef = node.ref;
  if (node.className.endsWith("$GeometryMarker")) markerRefs.push(node.ref);
  if (node.children.length === 1 && node.children[0].className.endsWith("$GeometryMarker")) nestedMarkerRef = node.children[0].ref;
  queue.push(...node.children);
}
assert.ok(mutatingRef && /^[\w.$]+@[0-9a-f]+$/.test(mutatingRef), "Need the self-mutating marker to test rejection");
for (let round = 0; round < 3; round++) {
  const nonce = randomBytes(8).toString("hex");
  const started = performance.now();
  const reply = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "capture-visible", "--arg", nonce).toString();
  const field = (name: string) => new RegExp(`\\b${name}=([^,}\\]]+)`).exec(reply)?.[1];
  assert.equal(field("result"), "ok", reply);
  assert.equal(field("nonce"), nonce);
  assert.equal(field("rootRef"), tree.root.ref, "Sample window changed during dynamic probe");
  const file = adb("exec-out", "run-as", pkg, "cat", "no_backup/inspector-visible-layers.bin");
  assert.equal(file.length, Number(field("bytes")));
  assert.equal(file.subarray(0, 8).toString("hex"), nonce);
  assert.equal(createHash("sha256").update(file).digest("hex"), field("sha256"));
  const layers = parseCapturedViewLayers(file);
  assert.ok(!layers.some(layer => layer.name.includes("$MutatingGeometryMarker@")), "Must reject a View that moves during its own draw");
  const markers = layers.filter(layer => layer.name.includes("$GeometryMarker@"));
  assert.equal(markers.length, 20, "Need all twenty animated sample markers");
  for (const layer of markers) {
    assert.ok(layer.imageDataUrl);
    assert.deepEqual(pixel(layer.imageDataUrl, 8, 8), [layer.x & 255, layer.y & 255, 123, 255], `Pixels disagree with capture coordinates: ${layer.name} (${layer.x},${layer.y})`);
    const position = `${layer.x},${layer.y}`;
    if (previous.has(layer.name) && previous.get(layer.name) !== position) moved++;
    previous.set(layer.name, position);
    checked++;
  }
  console.log(JSON.stringify({ round: round + 1, checked: markers.length, elapsedMs: Math.round(performance.now() - started), renderMs: Number(field("renderMs")) }));
}
assert.ok(moved > 0, "The page was not moving; cannot validate dynamic capture");
console.log(JSON.stringify({ passed: true, checked, moved }));
assert.ok(parentMutatingRef, "Need a marker that changes only its parent context during draw");
assert.ok(parentClipMutatingRef, "Need a marker that changes only its parent's clip rectangle");
assert.ok(nestedMarkerRef, "Need a marker inside an animated parent");
const parentPositions = new Set<string>();
for (let round = 0; round < 3; round++) {
  const refs: string[] = [nestedMarkerRef, markerRefs.find(ref => ref !== nestedMarkerRef)!, parentMutatingRef, parentClipMutatingRef];
  const nonce = randomBytes(8).toString("hex");
  const reply: string = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "capture-refs", "--arg", `'${refs.join(";")}'`,
    "--extra", `nonce:s:${nonce}`, "--extra", "geometryEvidence:b:true").toString();
  const field = (name: string): string | undefined => new RegExp(`\\b${name}=([^,}\\]]+)`).exec(reply)?.[1];
  assert.equal(field("result"), "ok", reply);
  assert.equal(field("nonce"), nonce);
  assert.equal(field("rootRef"), tree.root.ref, "Sample window changed before mutation probe");
  assert.ok(reply.includes(`${parentMutatingRef}:位图缺失或绘制期间位置/尺寸变化`), `Parent-only alpha mutation must reject the image: ${reply}`);
  assert.ok(reply.includes(`${parentClipMutatingRef}:位图缺失或绘制期间位置/尺寸变化`), `Parent-only clip mutation must reject the image: ${reply}`);
  const file = adb("exec-out", "run-as", pkg, "cat", "no_backup/inspector-ref-layers.bin");
  assert.equal(createHash("sha256").update(file).digest("hex"), field("sha256"));
  assert.equal(file.subarray(0, 8).toString("hex"), nonce);
  const images = parseCapturedViewLayers(file);
  const evidence = parseCaptureGeometryEvidence(field("geometryEvidence"), refs, tree.root.ref);
  assert.equal(evidence.size, 2);
  assert.equal(images.length, 2);
  const parent = evidence.get(nestedMarkerRef)!.chain[1];
  parentPositions.add(`${parent[2]},${parent[3]}`);
  for (const image of images) {
    const context = evidence.get(image.name)!;
    const row = context.chain[0];
    assert.equal(context.clipContext?.length, context.chain.length);
    assert.deepEqual(row.slice(2, 6), [image.x, image.y, image.width, image.height]);
    assert.deepEqual(pixel(image.imageDataUrl!, 8, 8), [image.x & 255, image.y & 255, 123, 255]);
    assert.equal(context.bitmapSpace, "view-local");
    const quad = captureScreenQuad(context.localToScreen, image.width, image.height);
    assert.ok(quad, "Capture must have a finite screen quad");
    assert.ok(Math.abs(quad[0].x - image.x!) <= 1 && Math.abs(quad[0].y - image.y!) <= 1);
    if (image.name === nestedMarkerRef) {
      const scale = (row[10] as number[])[0];
      assert.ok(scale >= 0.79 && scale <= 0.91, "Nested marker must really be scaled");
      assert.ok(Math.abs(quad[1].x - quad[0].x - image.width * scale) < 0.001);
      assert.ok(Math.abs(quad[3].y - quad[0].y - image.height * scale) < 0.001);
      assert.ok(quad[1].x - quad[0].x < image.width, "Local pixels must not already include own scaling");
    }
  }
  console.log(JSON.stringify({ parentEvidenceRound: round + 1, images: images.length, parentMutationRejected: true, parentClipMutationRejected: true, scaledLocalPixelsVerified: true }));
}
assert.ok(parentPositions.size > 1, "Parent must actually move between diagnostic captures");
const refNonce = randomBytes(8).toString("hex");
const rejected = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "capture-refs", "--arg", `'${mutatingRef}'`, "--extra", `nonce:s:${refNonce}`).toString();
assert.match(rejected, /result=ok/);
assert.match(rejected, /count=0(?:[,}\]])/);
assert.ok(rejected.includes(`${mutatingRef}:位图缺失或绘制期间位置/尺寸变化`), "Own-image supplement must also reject synchronous layout mutation");
adb("shell", "am", "start", "-S", "-n", `${pkg}/.MainActivity`);
await wait(1500);
const ownReply = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "capture-visible").toString();
assert.match(ownReply, /result=ok/);
const ownLayers = parseCapturedViewLayers(adb("exec-out", "run-as", pkg, "cat", "no_backup/inspector-visible-layers.bin"));
const parent = ownLayers.find(layer => layer.name.includes("$DecoratedParent@"));
assert.ok(parent?.imageDataUrl);
assert.deepEqual(pixel(parent.imageDataUrl, 10, 10), [255, 255, 0, 255], "Parent's own yellow marker is missing");
assert.deepEqual(pixel(parent.imageDataUrl, Math.floor(parent.width / 2), Math.floor(parent.height / 2)), [12, 52, 104, 255], "Parent own image contains children");
const text = ownLayers.find(layer => layer.name.startsWith("android.widget.TextView@"));
assert.ok(text?.imageDataUrl);
assert.equal(pixel(text.imageDataUrl, 0, 0)[3], 0, "Transparent text inherited a parent background");
console.log(JSON.stringify({ isolationPassed: true, mutationRejected: true }));
