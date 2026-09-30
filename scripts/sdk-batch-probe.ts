import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const serial = process.argv[2];
if (!serial) throw new Error("Usage: bun scripts/sdk-batch-probe.ts DEVICE_SERIAL");
const adb = process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : "adb";
const pkg = process.argv[3] ?? "com.androiduiinspector.sample";
if (!/^[a-z][\w]*(?:\.[a-z][\w]*)+$/.test(pkg)) throw new Error("Invalid package name");
const uri = `content://${pkg}.inspector`;

async function run(args: string[]) {
  const started = performance.now();
  const data = execFileSync(adb, ["-s", serial, ...args], { maxBuffer: 20_000_000 });
  return { data, ms: performance.now() - started };
}

function sha256(data: Buffer) { return createHash("sha256").update(data).digest("hex"); }
async function call(method: string, arg?: string) {
  if (arg) assert.match(arg, /^[\w.$@,]+$/);
  return run(["shell", "content", "call", "--uri", uri, "--method", method, ...(arg ? ["--arg", `'${arg}'`] : [])]);
}
async function privateFile(name: string) {
  return run(["exec-out", "run-as", pkg, "cat", `no_backup/${name}`]);
}
function accepted(data: Buffer) { assert.match(data.toString(), /\bresult=ok\b/); }

type Node = { ref: string; className: string; text?: string; visible: boolean; width: number; height: number; children: Node[] };
const treeCall = await call("capture"); accepted(treeCall.data);
const tree = JSON.parse((await privateFile("inspector-hierarchy.json")).data.toString()) as { root: Node; processInstance: string };
const refs: string[] = [];
function collect(node: Node) {
  if (node.className === "android.widget.TextView" && (pkg !== "com.androiduiinspector.sample" || /^[0-9]+$/.test(node.text ?? ""))
      && node.visible && node.width * node.height > 0 && node.width * node.height <= 100_000) refs.push(node.ref);
  for (const child of node.children) collect(child);
}
collect(tree.root);
assert.ok(refs.length >= 10, "Need at least 10 small visible TextViews");
if (pkg === "com.androiduiinspector.sample") {
function find(node: Node, predicate: (node: Node) => boolean): Node | undefined {
  return predicate(node) ? node : node.children.map(child => find(child, predicate)).find(Boolean);
}
const parent = find(tree.root, node => node.className.endsWith("$DecoratedParent"));
const child = find(tree.root, node => node.text === "RED CHILD");
assert.ok(parent && child && parent.width * parent.height > 100_000);
const largeRefs = [parent.ref, child.ref];
const largeHashes = [];
for (const ref of largeRefs) {
  const reply = await call("capture-own", ref); accepted(reply.data);
  largeHashes.push(sha256((await privateFile("inspector-own-image.png")).data));
}
const parentBatch = await call("capture-own-batch", largeRefs.join(",")); accepted(parentBatch.data);
const parentManifest = JSON.parse((await privateFile("inspector-own-batch.json")).data.toString());
assert.equal(parentManifest.processInstance, tree.processInstance);
assert.equal(parentManifest.rootRef, tree.root.ref);
for (let index = 0; index < largeRefs.length; index++) {
  assert.equal(parentManifest.images[index].ref, largeRefs[index]);
  assert.equal(parentManifest.images[index].sha256, largeHashes[index]);
  assert.equal(sha256((await privateFile(parentManifest.images[index].file)).data), largeHashes[index]);
}
}
const selected = refs.slice(0, 10);
const sequential = new Map<string, string>();
let sequentialCallMs = 0, sequentialReadMs = 0;
for (const ref of selected) {
  const reply = await call("capture-own", ref); accepted(reply.data);
  sequentialCallMs += reply.ms;
  const expected = /sha256=([a-f0-9]{64})/.exec(reply.data.toString())?.[1];
  const image = await privateFile("inspector-own-image.png");
  sequentialReadMs += image.ms;
  assert.equal(sha256(image.data), expected);
  sequential.set(ref, expected!);
}

const missing = await call("capture-own-batch", "android.view.View@ffffffff");
assert.doesNotMatch(missing.data.toString(), /\bresult=ok\b/);
await run(["shell", "run-as", pkg, "test", "!", "-e", "no_backup/inspector-own-batch.json"]);
const duplicate = await call("capture-own-batch", `${selected[0]},${selected[0]}`);
assert.doesNotMatch(duplicate.data.toString(), /\bresult=ok\b/);

const batches: { callMs: number; readMs: number; matching: number }[] = [];
for (let round = 0; round < 3; round++) {
  const reply = await call("capture-own-batch", selected.join(",")); accepted(reply.data);
  const manifestFile = await privateFile("inspector-own-batch.json");
  assert.equal(sha256(manifestFile.data), /sha256=([a-f0-9]{64})/.exec(reply.data.toString())?.[1]);
  const manifest = JSON.parse(manifestFile.data.toString()) as {
    processInstance: string; rootRef: string; images: { ref: string; file: string; sha256: string; width: number; height: number }[];
  };
  assert.equal(manifest.processInstance, tree.processInstance);
  assert.equal(manifest.rootRef, tree.root.ref);
  assert.equal(manifest.images.length, selected.length);
  let readMs = manifestFile.ms;
  for (let index = 0; index < selected.length; index++) {
    const item = manifest.images[index];
    assert.equal(item.ref, selected[index]);
    assert.equal(item.file, `inspector-own-batch-${index}.png`);
    const image = await privateFile(item.file);
    readMs += image.ms;
    assert.equal(sha256(image.data), item.sha256);
    assert.equal(item.sha256, sequential.get(item.ref));
    assert.equal(image.data.readUInt32BE(16), item.width);
    assert.equal(image.data.readUInt32BE(20), item.height);
  }
  batches.push({ callMs: Math.round(reply.ms), readMs: Math.round(readMs), matching: selected.length });
}
const finalTreeCall = await call("capture"); accepted(finalTreeCall.data);
const finalTree = JSON.parse((await privateFile("inspector-hierarchy.json")).data.toString());
assert.equal(finalTree.processInstance, tree.processInstance);
assert.equal(finalTree.root.ref, tree.root.ref);
console.log(JSON.stringify({ candidates: refs.length,
  sequential: { callMs: Math.round(sequentialCallMs), readMs: Math.round(sequentialReadMs), matching: sequential.size }, batches }));
