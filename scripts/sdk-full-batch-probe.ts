// Experimental same-page upper bound: baseline discovers the exact image refs.
// Run with: bun scripts/sdk-full-batch-probe.ts DEVICE_SERIAL com.example.debug
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inspectPreferredDevice, getDebugTarget } from "../electron/adb";
import { captureViewBitmaps } from "../electron/view-debug";
import type { UiNode } from "../shared/types";

const serial = process.argv[2], pkg = process.argv[3];
assert.match(serial ?? "", /^[\w.:-]{1,256}$/, "Provide an ADB device serial");
assert.match(pkg ?? "", /^[a-z]\w*(?:\.[a-z]\w*)+$/, "Provide a Debug App package");
const adb = process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : "adb";
const uri = `content://${pkg}.inspector`;
const fileName = /^inspector-(?:hierarchy\.json|own-image\.png|own-batch\.json|own-batch-[0-9]\.png)$/;

function command(args: string[]) {
  const start = performance.now();
  const data = execFileSync(adb, ["-s", serial, ...args], { timeout: 30_000, maxBuffer: 20_000_000 });
  return { data, ms: performance.now() - start };
}
function call(method: "capture" | "capture-own" | "capture-own-batch", refs?: string) {
  if (refs) assert.match(refs, /^[\w.$@,]+$/);
  return command(["shell", "content", "call", "--uri", uri, "--method", method, ...(refs ? ["--arg", `'${refs}'`] : [])]);
}
function privateFile(name: string) {
  assert.match(name, fileName);
  return command(["exec-out", "run-as", pkg, "cat", `no_backup/${name}`]);
}
function sha256(data: Buffer) { return createHash("sha256").update(data).digest("hex"); }
function field(reply: Buffer, name: string) { return new RegExp(`\\b${name}=([^,}\\]]+)`).exec(reply.toString())?.[1] ?? null; }
function accepted(reply: Buffer) { assert.equal(field(reply, "result"), "ok", reply.toString()); }

type ImageNode = { ref: string; node: UiNode; pixels: number; width: number; height: number };
const before = await getDebugTarget(serial, pkg);
console.log("baseline: capturing existing desktop path");
const baseline = await inspectPreferredDevice(serial, { expectedPackage: pkg });
assert.equal(baseline.error, null, baseline.error ?? undefined);
assert.ok(baseline.inspectionSource === "debug-hybrid" || baseline.inspectionSource === "debug-view");
assert.ok(baseline.root?.children.length === 1);
const root = baseline.root.children[0];
const rootRef = root.attributes?.["view-ref"];
const pid = baseline.root.attributes?.["debug-process-id"];
assert.ok(rootRef && /^\d+$/.test(pid ?? ""));
const candidate: ImageNode[] = [];
const nodes = [root];
while (nodes.length) {
  const node = nodes.pop()!;
  nodes.push(...node.children);
  if (node.layerImageStatus !== "captured" || !node.layerImageSize) continue;
  const ref = node.attributes?.["view-ref"];
  assert.ok(ref, "Captured View is missing an object identity");
  const { width, height } = node.layerImageSize;
  candidate.push({ ref, node, width, height, pixels: width * height });
}
const baselineTarget = await getDebugTarget(serial, pkg);
assert.equal(baselineTarget.component, before.component);
assert.equal(baselineTarget.windowId, before.windowId);
assert.equal(command(["shell", "pidof", "-s", pkg]).data.toString().trim(), pid);
console.log(JSON.stringify({ baselineMs: baseline.captureDurationMs, source: baseline.inspectionSource,
  nodes: baseline.nodeCount, images: candidate.length, warning: baseline.warning }));

// ponytail: baseline-known refs give the SDK path a favorable bound; real capture still needs a way to discover candidates.
const sdkStarted = performance.now();
const treeReply = call("capture"); accepted(treeReply.data);
const treeRead = privateFile("inspector-hierarchy.json");
const tree = JSON.parse(treeRead.data.toString()) as { processInstance: string; root: {
  ref: string; className: string; width: number; height: number; screenX: number; screenY: number; children: typeof tree.root[]
}; nodeCount: number };
const instance = tree.processInstance;
if (baseline.inspectionSource === "debug-hybrid") assert.equal(baseline.root.attributes?.["sdk-process-instance"], instance);
assert.equal(tree.root.ref, rootRef);
const sdkNodes = new Map<string, typeof tree.root>();
const pending = [tree.root];
while (pending.length) {
  const node = pending.pop()!;
  sdkNodes.set(node.ref, node);
  pending.push(...node.children);
}
const stable = candidate.filter(item => {
  const node = sdkNodes.get(item.ref), bounds = item.node.bounds;
  return node && bounds && node.className === item.node.className && node.width === item.width && node.height === item.height
    && Math.abs(node.screenX - bounds.left) <= 8 && Math.abs(node.screenY - bounds.top) <= 8;
});
const special = stable.filter(item => /SurfaceView|TextureView|独立缓冲/.test(`${item.node.className} ${item.node.attributes?.["image-source"] ?? ""}`));
const native = stable.filter(item => !special.includes(item));
const batchable = native.filter(item => item.pixels <= 1_000_000);
const single = native.filter(item => item.pixels > 1_000_000 && item.pixels <= 4_000_000);
const jdwp = [...special, ...native.filter(item => item.pixels > 4_000_000)];
console.log(JSON.stringify({ stable: stable.length, stale: candidate.length - stable.length,
  batchable: batchable.length, single: single.length, jdwp: jdwp.length, sdkTreeNodes: tree.nodeCount }));
const batches: ImageNode[][] = [];
for (const item of batchable) {
  const last = batches.at(-1);
  if (!last || last.length === 10 || last.reduce((sum, value) => sum + value.pixels, 0) + item.pixels > 2_000_000) batches.push([item]);
  else last.push(item);
}
let callMs = treeReply.ms, readMs = treeRead.ms, matched = 0, samePng = 0;
const failures: string[] = [];
function verify(item: ImageNode, data: Buffer, expected: string, width: number, height: number) {
  assert.equal(sha256(data), expected, `PNG digest mismatch: ${item.ref}`);
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `Not PNG: ${item.ref}`);
  assert.equal(data.readUInt32BE(16), width);
  assert.equal(data.readUInt32BE(20), height);
  if (width !== item.width || height !== item.height) { failures.push(`${item.ref}: View size changed`); return; }
  matched++;
  const old = item.node.layerImageDataUrl;
  if (old?.startsWith("data:image/png;base64,") && sha256(Buffer.from(old.slice(22), "base64")) === expected) samePng++;
}
function one(item: ImageNode) {
  const reply = call("capture-own", item.ref); callMs += reply.ms;
  if (field(reply.data, "result") !== "ok") { failures.push(`${item.ref}: ${field(reply.data, "error") ?? "capture failed"}`); return; }
  assert.equal(field(reply.data, "processInstance"), instance);
  assert.equal(field(reply.data, "rootRef"), rootRef);
  const file = privateFile("inspector-own-image.png"); readMs += file.ms;
  verify(item, file.data, field(reply.data, "sha256")!, Number(field(reply.data, "width")), Number(field(reply.data, "height")));
}
for (let index = 0; index < batches.length; index++) {
  const batch = batches[index];
  const reply = call("capture-own-batch", batch.map(item => item.ref).join(",")); callMs += reply.ms;
  if (field(reply.data, "result") !== "ok") {
    const reason = field(reply.data, "error") ?? "batch failed";
    if (/root changed|process|Activity/i.test(reason)) throw new Error(reason);
    for (const item of batch) one(item);
  } else {
    assert.equal(field(reply.data, "processInstance"), instance);
    assert.equal(field(reply.data, "rootRef"), rootRef);
    const file = privateFile("inspector-own-batch.json"); readMs += file.ms;
    assert.equal(sha256(file.data), field(reply.data, "sha256"));
    const manifest = JSON.parse(file.data.toString()) as { processInstance: string; rootRef: string;
      images: { ref: string; file: string; sha256: string; width: number; height: number }[] };
    assert.equal(manifest.processInstance, instance);
    assert.equal(manifest.rootRef, rootRef);
    assert.equal(manifest.images.length, batch.length);
    for (let i = 0; i < batch.length; i++) {
      const item = manifest.images[i];
      assert.equal(item.ref, batch[i].ref);
      assert.equal(item.file, `inspector-own-batch-${i}.png`);
      const image = privateFile(item.file); readMs += image.ms;
      verify(batch[i], image.data, item.sha256, item.width, item.height);
    }
  }
  if ((index + 1) % 5 === 0 || index + 1 === batches.length) {
    console.log(`SDK batches ${index + 1}/${batches.length}: ${matched}/${candidate.length} matched, ${Math.round(performance.now() - sdkStarted)} ms`);
    const target = await getDebugTarget(serial, pkg);
    assert.equal(target.windowId, before.windowId);
    assert.equal(target.component, before.component);
  }
}
for (let index = 0; index < single.length; index++) {
  one(single[index]);
  if ((index + 1) % 5 === 0 || index + 1 === single.length) console.log(`SDK large images ${index + 1}/${single.length}: ${matched}/${candidate.length} matched`);
}
let specialMs = 0;
if (jdwp.length) {
  const forward = command(["forward", "tcp:0", `jdwp:${pid}`]);
  const port = forward.data.toString().trim();
  assert.match(port, /^\d+$/);
  try {
    const started = performance.now();
    const result = await captureViewBitmaps(Number(port), { rootRef, windowName: baseline.root.attributes?.["debug-window-name"] ?? "" },
      jdwp.map(item => ({ ref: item.ref, captureOwn: true })));
    specialMs = performance.now() - started;
    for (const item of jdwp) {
      const image = result.images.get(item.ref);
      if (!image) { failures.push(`${item.ref}: ${result.failures.get(item.ref) ?? "special buffer unavailable"}`); continue; }
      if (image.width !== item.width || image.height !== item.height) { failures.push(`${item.ref}: special buffer size changed`); continue; }
      matched++;
    }
  } finally { command(["forward", "--remove", `tcp:${port}`]); }
}
const after = await getDebugTarget(serial, pkg);
assert.equal(after.component, before.component);
assert.equal(after.windowId, before.windowId);
assert.equal(command(["shell", "pidof", "-s", pkg]).data.toString().trim(), pid);
console.log(JSON.stringify({ baselineMs: baseline.captureDurationMs, sdkUpperBoundMs: Math.round(performance.now() - sdkStarted),
  treeMs: Math.round(treeReply.ms + treeRead.ms), callMs: Math.round(callMs), readMs: Math.round(readMs), specialMs: Math.round(specialMs),
  baselineImages: candidate.length, stableImages: stable.length, staleImages: candidate.length - stable.length,
  matched, samePng, batchCount: batches.length, largeCount: single.length, specialCount: jdwp.length,
  treeNodeCount: tree.nodeCount, baselineNodeCount: baseline.nodeCount, failures: failures.slice(0, 10), failureCount: failures.length }, null, 2));
