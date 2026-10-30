// Read-only checks after launching the sample's transform-isolation mode.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { createHash, randomBytes } from "node:crypto";
import { parseCaptureGeometryEvidence } from "../../../electron/capture/layer-images";
import { parseCapturedViewLayers } from "../../../electron/capture/view-protocol";
import { rectangularCapturePlacement } from "../../../shared/capture-transform";

const serial = process.argv[2];
const token = process.argv[3];
if (!serial || !/^[\w.:-]+$/.test(serial) || !token || !/^[\w-]{1,100}$/.test(token)) throw new Error("Usage: bun scripts/diagnostics/sdk/sdk-transform-probe.ts SERIAL PROBE_TOKEN");
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 15_000, maxBuffer: 16_000_000 });
const pkg = "com.androiduiinspector.sample";
let report: Record<string, unknown> | undefined;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    const candidate = JSON.parse(adb("exec-out", "run-as", pkg, "cat", "files/isolation-probe/transform-result.json").toString());
    if (candidate.probeToken === token) { report = candidate; break; }
    await wait(250);
  } catch { await wait(250); }
}
assert.ok(report, "Sample did not produce a transform report");
assert.equal(report.passed, true, JSON.stringify(report));
assert.equal(report.mergedGeometryVerified, true, "Merged chains must match legacy evidence and reject mutations");
assert.equal(report.frameRefReuseVerified, true, "Frame-scoped identity reuse must preserve geometry checks and bounds");
assert.equal(report.parentAlpha, 0.5);
assert.equal(report.childAlpha, 0.5);
assert.ok(Math.abs(Number(report.parentScale) - 0.8) < 0.0001);
// Wait for the frame after the sample's UI-task report to reach the compositor.
await wait(500);
const screenshot = adb("exec-out", "screencap", "-p");
function pixel(x: unknown, y: unknown) {
  assert.ok(typeof x === "number" && Number.isFinite(x) && x >= 0);
  assert.ok(typeof y === "number" && Number.isFinite(y) && y >= 0);
  return [...execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf",
    `format=rgba,crop=1:1:${Math.round(x)}:${Math.round(y)}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
    { input: screenshot, timeout: 10_000, maxBuffer: 1024 })];
}
const background = pixel(report.backgroundX, report.backgroundY);
const outside = pixel(report.outsideX, report.outsideY);
const inside = pixel(report.insideX, report.insideY);
// Raw own-image blue is opaque; on screen the parent alpha is applied once over white.
const expected = [134, 154, 180, 255];
assert.ok(background.length === 4 && background.every((v, i) => Math.abs(v - expected[i]) <= 3), JSON.stringify({ background, expected }));
assert.deepEqual(outside, [255, 255, 255, 255], "Parent clipping must remove the child's otherwise opaque outside pixels");
const expectedInside = [131, 196, 169, 255];
assert.ok(inside.length === 4 && inside.every((v, i) => Math.abs(v - expectedInside[i]) <= 3),
  JSON.stringify({ inside, expectedInside }));
const treeReply = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "capture").toString();
assert.match(treeReply, /result=ok/);
const tree = JSON.parse(adb("exec-out", "run-as", pkg, "cat", "no_backup/inspector-hierarchy.json").toString());
const queue = [tree.root];
let parentRef: string | undefined;
while (queue.length) {
  const node = queue.pop();
  if (node.className.endsWith("$DecoratedParent")) parentRef = node.ref;
  queue.push(...node.children);
}
assert.ok(parentRef && /^[\w.$]+@[0-9a-f]+$/.test(parentRef));
const nonce = randomBytes(8).toString("hex");
const reply = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "capture-refs",
  "--arg", `'${parentRef}'`, "--extra", `nonce:s:${nonce}`, "--extra", "geometryEvidence:b:true").toString();
const field = (key: string) => new RegExp(`\\b${key}=([^,}\\]]+)`).exec(reply)?.[1];
assert.equal(field("result"), "ok", reply);
assert.equal(field("nonce"), nonce);
const bytes = adb("exec-out", "run-as", pkg, "cat", "no_backup/inspector-ref-layers.bin");
assert.equal(bytes.length, Number(field("bytes")));
assert.equal(bytes.subarray(0, 8).toString("hex"), nonce);
assert.equal(createHash("sha256").update(bytes).digest("hex"), field("sha256"));
const images = parseCapturedViewLayers(bytes);
assert.equal(images.length, 1);
assert.equal(images[0].name, parentRef);
const context = parseCaptureGeometryEvidence(field("geometryEvidence"), [parentRef], tree.root.ref).get(parentRef);
assert.ok(context);
const placement = rectangularCapturePlacement(context, images[0].width, images[0].height);
assert.ok(placement && !placement.hidden, `Hardware own capture must qualify for the verified rectangle rendering path: ${JSON.stringify(context)}`);
assert.ok(Math.abs(placement.screen.width - images[0].width * 0.8) < 0.001);
assert.ok(Math.abs(placement.screen.height - images[0].height * 0.8) < 0.001);
assert.equal(placement.opacity, 0.5);
console.log(JSON.stringify({ passed: true, hardwareOwnIsLocal: true, alphaNotBaked: true,
  ancestorClipNotBaked: true, verifiedPlacement: placement, background, inside, outside, report }));
