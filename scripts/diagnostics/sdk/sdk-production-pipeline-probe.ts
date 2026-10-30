// The same host checks run against baseline and refactored production SDKs.
// Only the owned sample App is launched; successful captures are never retried.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import sharp from "sharp";
import { parseCapturedViewLayers } from "../../../electron/capture/view-protocol";
import { parseCaptureGeometryFile, parseCaptureGeometryEvidence } from "../../../electron/capture/layer-images";

const serial = process.argv[2];
assert.ok(serial && /^[\w.:-]+$/.test(serial), "Usage: bun scripts/diagnostics/sdk/sdk-production-pipeline-probe.ts SERIAL");
const pkg = "com.androiduiinspector.sample";
const extended = process.argv.includes("--fixture");
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 75_000, maxBuffer: 65_000_000, stdio: ["ignore", "pipe", "pipe"] });
const base = join(import.meta.dirname, "../../../.benchmarks/sdk-production-pipeline");
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, "run-"));
const checks: Record<string, unknown>[] = [];
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const save = (passed: boolean, error?: unknown) => writeFileSync(join(directory, "result.json"), JSON.stringify({
  passed, scope: "actual capture-visible/capture-refs on owned sample", extended, checks, ...(error ? { error: String(error) } : {}),
}, null, 2));
const previous = /(?:mResumedActivity:|topResumedActivity=).*?\s([\w.]+\/[\w.$]+)\s/.exec(adb("shell", "dumpsys", "activity", "activities").toString())?.[1];
const launch = async (mode: string) => {
  const reply = adb("shell", "am", "start", "-S", "-W", "-n", `${pkg}/.MainActivity`, "--es", "mode", mode).toString();
  assert.match(reply, /Status: ok/);
  await wait(750); // Fixture layout/buffer readiness only, never a capture retry.
};
function capture(method: "capture-visible" | "capture-refs", refs: string[], extras: string[] = []) {
  const nonce = randomBytes(8).toString("hex");
  for (const ref of refs) assert.match(ref, /^[\w.$]+@[0-9a-f]+$/);
  const reply = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", method,
    "--arg", method === "capture-visible" ? nonce : `'${refs.join(";")}'`,
    ...(method === "capture-refs" ? ["--extra", `nonce:s:${nonce}`] : []), ...extras.flatMap(value => ["--extra", value])).toString();
  const field = (key: string) => new RegExp(`\\b${key}=([^,}\\]]+)`).exec(reply)?.[1];
  assert.equal(field("result"), "ok", reply);
  assert.equal(field("nonce"), nonce);
  const processInstance = field("processInstance"), rootRef = field("rootRef");
  assert.ok(processInstance && rootRef, "Capture identity required");
  const name = method === "capture-visible" ? "visible" : "ref";
  const bytes = adb("exec-out", "run-as", pkg, "cat", `no_backup/inspector-${name}-layers.bin`);
  assert.equal(bytes.length, Number(field("bytes")));
  assert.ok(bytes.length <= 64_000_000);
  assert.equal(bytes.subarray(0, 8).toString("hex"), nonce);
  assert.equal(sha(bytes), field("sha256"));
  const layers = parseCapturedViewLayers(bytes);
  assert.equal(layers.length, Number(field("count")));
  assert.equal(adb("shell", "run-as", pkg, "sh", "-c", `'test ! -e no_backup/inspector-${name}-layers.bin.tmp && echo clean'`).toString().trim(), "clean");
  let geometryCount = 0;
  if (field("geometrySha256")) {
    const geometry = adb("exec-out", "run-as", pkg, "cat", `no_backup/inspector-geometry-${nonce}.json`);
    assert.equal(geometry.length, Number(field("geometryBytes")));
    assert.equal(sha(geometry), field("geometrySha256"));
    geometryCount = parseCaptureGeometryFile(geometry, nonce, processInstance, rootRef, layers).size;
    adb("shell", "run-as", pkg, "rm", "-f", `no_backup/inspector-geometry-${nonce}.json`);
  } else if (field("geometryEvidence")) {
    geometryCount = parseCaptureGeometryEvidence(field("geometryEvidence"), refs, rootRef).size;
  }
  const manifest = layers.map(layer => [layer.name.replace(/@[0-9a-f]+$/, ""), layer.x, layer.y,
    layer.width, layer.height, sha(layer.imageDataUrl ?? "")]);
  const summary = { method, count: layers.length, geometryCount, nonceVerified: true, digestVerified: true,
    temporaryFileRemoved: true, imageManifest: sha(JSON.stringify(manifest)),
    special: field("special") ?? field("specialRefs") ?? "-", geometry: field("geometrySha256") ? "file" : field("geometryEvidence") ? "inline" : "none" };
  checks.push(summary); save(false);
  return { field, layers, summary, processInstance, rootRef };
}
function readTree() {
  const reply = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "capture").toString();
  assert.match(reply, /result=ok/);
  const tree = JSON.parse(adb("exec-out", "run-as", pkg, "cat", "no_backup/inspector-hierarchy.json").toString());
  const stack = [tree.root], nodes: Array<{ ref: string; className: string }> = [];
  while (stack.length) { const node = stack.pop(); nodes.push(node); stack.push(...node.children); }
  return nodes;
}
async function awaitFixture(token: string, phase: string) {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    let report: { probeToken: string; phase: string; error?: string } | undefined;
    try { report = JSON.parse(adb("exec-out", "run-as", pkg, "cat", "files/pipeline-contract.json").toString()); } catch {}
    if (report?.probeToken === token) {
      assert.notEqual(report.phase, "failed", report.error);
      if (report.phase === phase) return;
    }
    await wait(100);
  }
  throw new Error(`Fresh fixture ${phase} missing`);
}
async function launchFixture(timeout: boolean) {
  const token = randomBytes(8).toString("hex");
  assert.match(adb("shell", "am", "start", "-S", "-W", "-n", `${pkg}/.PipelineContractActivity`,
    "--es", "probeToken", token, "--ez", "captureTimeout", String(timeout)).toString(), /Status: ok/);
  await awaitFixture(token, "ready");
  return token;
}
function noCaptureFiles(method: "capture-visible" | "capture-refs", nonce: string) {
  const name = method === "capture-visible" ? "visible" : "ref";
  for (const file of [`inspector-${name}-layers.bin`, `inspector-${name}-layers.bin.tmp`, `inspector-geometry-${nonce}.json`])
    assert.equal(adb("shell", "run-as", pkg, "sh", "-c", `'test ! -e no_backup/${file} && echo clean'`).toString().trim(), "clean", file);
}
async function failedCapture(method: "capture-visible" | "capture-refs") {
  const token = await launchFixture(true);
  const nodes = readTree();
  const delayed = nodes.find(node => node.className.endsWith("$DelayedText"));
  const text = nodes.find(node => node.className === "android.widget.TextView");
  assert.ok(delayed && text);
  const nonce = randomBytes(8).toString("hex");
  const reply = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", method,
    "--arg", method === "capture-visible" ? nonce : `'${text.ref};${delayed.ref}'`,
    "--extra", method === "capture-visible" ? "geometryFile:b:true" : `nonce:s:${nonce}`).toString();
  assert.match(reply, /error=[^}]*timed out/i, "Expected one genuine capture timeout, without replay");
  assert.doesNotMatch(reply, /result=ok/);
  noCaptureFiles(method, nonce);
  await awaitFixture(token, "capture-released");
  noCaptureFiles(method, nonce);
  const recovery = capture(method, method === "capture-visible" ? [] : [delayed.ref]);
  assert.ok(recovery.layers.length > 0);
  checks.push({ method, failure: "ui-capture-timeout", failedCaptureCount: 1,
    finalAndTemporaryFilesRemoved: true, lateUiResultDidNotPublish: true, subsequentCaptureRecovered: true });
  save(false);
}
async function pixels(dataUrl: string) {
  return sharp(Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
try {
  await launch("stress-rectangle");
  const visible = capture("capture-visible", [], ["geometryFile:b:true"]);
  assert.equal(visible.layers.length, 407); assert.equal(visible.summary.geometryCount, 405);
  const repeated = capture("capture-visible", [], ["geometryFile:b:true"]);
  assert.equal(repeated.processInstance, visible.processInstance); assert.equal(repeated.rootRef, visible.rootRef);
  assert.deepEqual(repeated.layers.map(layer => layer.name), visible.layers.map(layer => layer.name), "Visible order changed");
  assert.equal(repeated.summary.imageManifest, visible.summary.imageManifest, "Visible pixels/order changed");
  const refs = visible.layers.filter(layer => layer.name.includes("TextView@")).slice(0, 12).map(layer => layer.name).reverse();
  assert.equal(refs.length, 12);
  const batch = capture("capture-refs", refs, ["geometryFile:b:true"]);
  assert.deepEqual(batch.layers.map(layer => layer.name), refs, "Requested order must survive parallel encoders");
  assert.equal(batch.summary.geometryCount, 12); assert.equal(batch.summary.geometry, "file");
  const single = capture("capture-refs", [refs[0]], ["geometryEvidence:b:true"]);
  assert.equal(single.summary.geometryCount, 1); assert.equal(single.summary.geometry, "inline");
  assert.equal(single.layers[0].imageDataUrl, batch.layers[0].imageDataUrl, "Same own bitmap changed across ref paths");
  const canvas = capture("capture-refs", [refs[0]], ["debugCanvas:b:true", "geometryEvidence:b:true"]);
  assert.equal(canvas.field("debugCanvas"), "true"); assert.equal(canvas.layers.length, 1);
  assert.match(canvas.layers[0].imageDataUrl!, /^data:image\/png;base64,/);
  const decoded = await pixels(canvas.layers[0].imageDataUrl!);
  let transparent = 0, partial = 0, visiblePixels = 0;
  for (let i = 3; i < decoded.data.length; i += 4) {
    const alpha = decoded.data[i]; if (!alpha) transparent++; else { visiblePixels++; if (alpha < 255) partial++; }
  }
  assert.ok(visiblePixels > 0, "Debug canvas must contain text pixels");
  assert.ok(transparent > 0 && partial > 0, "Debug canvas must preserve transparent background and antialiased alpha");
  const canvasAgain = capture("capture-refs", [refs[0]], ["debugCanvas:b:true", "geometryEvidence:b:true"]);
  assert.equal(canvasAgain.layers[0].imageDataUrl, canvas.layers[0].imageDataUrl, "Debug canvas PNG/alpha must be repeatable");
  checks.push({ debugCanvas: "png", transparent, partial, visiblePixels, rgbaSha256: sha(decoded.data) });
  await launch("surface");
  const surfacePage = capture("capture-visible", []);
  // A SurfaceView may have skip-draw set and be omitted by the visible selection.
  // Ref capture must still follow its independent buffer-copy policy.
  const surfaceRef = readTree().find(node => node.className === "android.view.SurfaceView")?.ref;
  assert.ok(surfaceRef, "Surface fixture missing from actual tree");
  const surface = capture("capture-refs", [surfaceRef]);
  assert.equal(surface.field("special"), `S:${surfaceRef}`); assert.equal(surface.layers.length, 1);
  const frame = await pixels(surface.layers[0].imageDataUrl!);
  let green = 0;
  for (let i = 0; i < frame.data.length; i += 4) if (frame.data[i] < 20 && frame.data[i + 1] > 150 && frame.data[i + 2] < 70 && frame.data[i + 3] > 240) green++;
  assert.ok(green > frame.info.width * frame.info.height * .9, "Surface buffer pixels differ");
  checks.push({ surfacePixels: green, visibleSpecialRefs: surfacePage.field("specialRefs"), scope: "live SurfaceView copied through capture-refs" });
  if (extended) {
    await launchFixture(false);
    const page = capture("capture-visible", [], ["geometryFile:b:true"]);
    const nodes = readTree();
    const texture = nodes.find(node => node.className === "android.view.TextureView");
    const surface = nodes.find(node => node.className === "android.view.SurfaceView");
    assert.ok(texture && surface);
    const buffers = capture("capture-refs", [texture.ref, surface.ref]);
    assert.deepEqual(buffers.layers.map(layer => layer.name), [texture.ref, surface.ref]);
    assert.equal(buffers.field("special"), `T:${texture.ref};S:${surface.ref}`);
    for (const [index, expected] of [[0, [40, 90, 220]], [1, [0, 180, 40]]] as const) {
      const decoded = await pixels(buffers.layers[index].imageDataUrl!);
      let matching = 0;
      for (let i = 0; i < decoded.data.length; i += 4)
        if (expected.every((value, channel) => Math.abs(decoded.data[i + channel] - value) <= 2) && decoded.data[i + 3] > 240) matching++;
      assert.ok(matching > decoded.info.width * decoded.info.height * .9, "Special buffer pixels differ");
      checks.push({ buffer: index ? "surface" : "texture", matching, rgbaSha256: sha(decoded.data),
        visibleSpecialRefs: page.field("specialRefs"), refPath: "independent-buffer-copy" });
    }
    await failedCapture("capture-visible");
    await failedCapture("capture-refs");
  }
  save(true); console.log(JSON.stringify({ passed: true, directory, checks }, null, 2));
} catch (error) { save(false, error); throw error; }
finally { if (previous && !previous.startsWith(`${pkg}/`)) adb("shell", "am", "start", "-n", previous); }
