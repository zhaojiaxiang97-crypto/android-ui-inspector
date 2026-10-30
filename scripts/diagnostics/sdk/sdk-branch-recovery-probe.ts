// Real sample pixels through the production SDK adapter; no business App rebuild or capture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { captureSdkRefLayers, readSdkBranchGeometry } from "../../../electron/capture/sdk-images";
import { createProviderSessionPool } from "../../../electron/sdk/provider-session";
import { recoverSdkGeometryBranch } from "../../../electron/capture/layer-images";
import { makeNode } from "../../../benchmarks/fixtures";
import type { UiNode } from "../../../shared/types";
const serial = process.argv[2]; assert.ok(serial && /^[\w.:-]+$/.test(serial), "Usage: bun scripts/diagnostics/sdk/sdk-branch-recovery-probe.ts SERIAL");
const app = "com.androiduiinspector.sample", adbPath = execFileSync("which", ["adb"]).toString().trim();
const adb = (...args: string[]) => execFileSync(adbPath, ["-s", serial, ...args], { timeout: 15000, maxBuffer: 4_000_001 }).toString();
const output = join(import.meta.dirname, "../../../.benchmarks/branch-recovery", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const previous = /(?:mResumedActivity:|topResumedActivity=).*?\s([\w.]+\/[\w.$]+)\s/.exec(adb("shell", "dumpsys", "activity", "activities"))?.[1];
function colors(dataUrl: string) {
  // Decode either native PNG or WebP in memory. This is analysis only; no conversion or pixel editing.
  return JSON.parse(execFileSync("python3", ["-c", `
import io,json,sys
from PIL import Image
image=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGBA")
counts=dict(width=image.width,height=image.height,red=0,green=0,blue=0,yellow=0,cornerAlpha=image.getpixel((0,0))[3])
for r,g,b,a in image.getdata():
 if not a: continue
 if r>200 and g<80 and b<80: counts["red"]+=1
 if r<80 and g>170 and b<100: counts["green"]+=1
 if r<40 and 30<g<80 and 80<b<130: counts["blue"]+=1
 if r>200 and g>200 and b<80: counts["yellow"]+=1
print(json.dumps(counts))
`], { input: Buffer.from(dataUrl.split(",")[1], "base64"), timeout: 10000 }).toString()) as { width: number; height: number; red: number; green: number; blue: number; yellow: number; cornerAlpha: number };
}
const provider = createProviderSessionPool();
try {
  adb("shell", "am", "force-stop", app);
  adb("shell", "am", "start", "-n", `${app}/.MainActivity`, "--es", "mode", "resize"); await wait(1500);
  assert.match(adb("shell", "content", "call", "--uri", `content://${app}.inspector`, "--method", "capture"), /result=ok/);
  const sdk = JSON.parse(adb("exec-out", "run-as", app, "cat", "no_backup/inspector-hierarchy.json"));
  assert.equal(sdk.branchGeometryVersion, 1);
  const convert = (source: any, id: string): UiNode => ({ ...makeNode(id), package: app, className: source.className,
    bounds: { left: source.screenX, top: source.screenY, right: source.screenX + source.width, bottom: source.screenY + source.height,
      raw: `[${source.screenX},${source.screenY}][${source.screenX + source.width},${source.screenY + source.height}]` },
    visibleToUser: source.visible, attributes: { "view-ref": source.ref }, children: source.children.map((n: any, i: number) => convert(n, `${id}/${i}`)) });
  const root = makeNode("0"); root.package = app; root.children = [convert(sdk.root, "0/0")];
  root.attributes = { "debug-process-id": String(sdk.pid), "sdk-visible-process-instance": sdk.processInstance };
  const nodes = [root]; for (let i = 0; i < nodes.length; i++) nodes.push(...nodes[i].children);
  const branch = nodes.find(n => n.className?.endsWith("$DecoratedParent"))!, target = branch.children.find(n => n.className === "android.widget.TextView")!;
  assert.ok(branch && target);
  // Acquire a real pre-mutation image for the branch, not a screenshot crop.
  const old = await captureSdkRefLayers(provider, adbPath, serial, app, root, branch.children.map(n => n.attributes!["view-ref"]), false, "sdk-enhanced");
  assert.equal(old.failures.size, 0);
  for (const child of branch.children) { const image = old.images.get(child.attributes!["view-ref"]); assert.ok(image); child.layerImageDataUrl = image.imageDataUrl; child.layerImageStatus = "captured"; }
  const before = structuredClone(root), b = target.bounds!;
  adb("shell", "input", "tap", String(Math.round((b.left + b.right) / 2)), String(Math.round((b.top + b.bottom) / 2))); await wait(1000);
  delete target.layerImageDataUrl; target.layerImageStatus = "failed";
  target.attributes!["image-capture-error"] = "采集期间控件尺寸变化，请重新采集";
  let captures = 0;
  const result = await recoverSdkGeometryBranch(root, [target], (path, branchRef) => readSdkBranchGeometry(provider, adbPath, serial,
    { packageName: app, pid: sdk.pid, processInstance: sdk.processInstance, rootRef: sdk.root.ref, branchRef }, path, "sdk-enhanced"),
    async refs => { captures++; const reply = await captureSdkRefLayers(provider, adbPath, serial, app, root, refs, false, "sdk-enhanced"); writeFileSync(join(output, "capture-summary.json"), JSON.stringify({ refs,
      failures: [...reply.failures], pure: [...reply.skipDraw], images: [...reply.images].map(([ref, img]) => ({ ref, x: img.x, y: img.y, width: img.width, height: img.height })) }, null, 2)); return reply; },
    async () => { assert.equal(Number(adb("shell", "pidof", "-s", app).trim()), sdk.pid); assert.ok(adb("shell", "dumpsys", "activity", "activities").includes(`${app}/.MainActivity`)); });
  assert.equal(result.recovered, 1); assert.equal(captures, 1);
  const updated = (() => { let node = root; for (const p of target.id.split("/").slice(1)) node = node.children[Number(p)]; return node; })();
  assert.equal(updated.layerImageStatus, "captured"); assert.notEqual(updated.bounds!.raw, target.bounds!.raw);
  assert.equal(updated.attributes!["image-capture-error"], undefined);
  const updatedBranch = (() => { let node = root; for (const p of branch.id.split("/").slice(1)) node = node.children[Number(p)]; return node; })();
  const parentPixels = colors(updatedBranch.layerImageDataUrl!), textPixels = colors(updated.layerImageDataUrl!);
  const decorationPixels = colors(updatedBranch.children.find(n => n !== updated)!.layerImageDataUrl!);
  assert.ok(parentPixels.blue > 0 && parentPixels.yellow > 0); assert.equal(parentPixels.red, 0); assert.equal(parentPixels.green, 0);
  assert.ok(textPixels.red > 0); assert.equal(textPixels.blue, 0); assert.equal(textPixels.green, 0); assert.equal(textPixels.cornerAlpha, 0);
  assert.ok(decorationPixels.green > 0); assert.equal(decorationPixels.blue, 0); assert.equal(decorationPixels.red, 0);
  assert.equal(textPixels.width, updated.bounds!.right - updated.bounds!.left); assert.equal(textPixels.height, updated.bounds!.bottom - updated.bounds!.top);
  const bytes = Buffer.from(updated.layerImageDataUrl!.split(",")[1], "base64");
  assert.ok(bytes.length > 100); writeFileSync(join(output, updated.layerImageDataUrl!.startsWith("data:image/webp") ? "recovered-target.webp" : "recovered-target.png"), bytes);
  writeFileSync(join(output, "result.json"), JSON.stringify({ passed: true, result, captures, oldBounds: target.bounds, newBounds: updated.bounds,
    oldImageSize: before.children[0].bounds, branchId: branch.id, bitmapBytes: bytes.length, parentPixels, textPixels, decorationPixels }, null, 2));
  console.log(JSON.stringify({ passed: true, result, captures, ownPixelsIsolated: true, oldBounds: target.bounds!.raw, newBounds: updated.bounds!.raw, bitmapBytes: bytes.length, output }));
} catch (error) { writeFileSync(join(output, "failure.txt"), String(error)); throw error; }
finally { await provider.dispose(); if (previous && !previous.startsWith(`${app}/`)) adb("shell", "am", "start", "-n", previous); }
