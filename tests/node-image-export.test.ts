import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { makeNode } from "../benchmarks/fixtures";
import { nodeImageExportPlan, exportableImageSize } from "../shared/node-image-export";
import { outputNodeImage, prepareNodeImage } from "../electron/desktop/node-image";
import type { NodeImageOutputRequest } from "../shared/types";
import { webpImages } from "./fixtures/webp-images";

const saved = "data:image/png;base64,aGVsbG8=";
const own = () => ({ ...makeNode("0"), layerImageDataUrl: saved, layerImageSize: { width: 2, height: 2 }, layerImageStatus: "captured" as const });
async function fixture() {
  const pixels = Buffer.from([255, 0, 0, 0, 0, 255, 0, 1, 0, 0, 255, 255]);
  const bytes = await sharp(pixels, { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();
  const request: NodeImageOutputRequest = { action: "save", dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
    size: { width: 3, height: 1 }, defaultFileName: "own-View-0.png" };
  return { request, bytes, pixels };
}
function ports(path: string | null = "/test/control.png") {
  const calls: string[] = []; let output: Buffer | null = null;
  return { calls, get output() { return output; },
    choosePath: async (name: string) => { calls.push(`dialog:${name}`); return path; },
    write: async (target: string, bytes: Buffer) => { calls.push(`write:${target}`); output = bytes; },
    copy: async (bytes: Buffer) => { calls.push("copy"); output = bytes; } };
}

test("own export keeps saved pixels and provenance even when a confirmed bitmap is transparent", () => {
  const node = own(); node.layerImageEmpty = true; node.attributes = { "image-capture-source": "sdk", alpha: "0.1" }; node.children = [own()];
  const plan = nodeImageExportPlan(node, "own");
  assert.equal(plan.kind, "own"); if (plan.kind !== "own") return;
  assert.equal(plan.dataUrl, saved); assert.deepEqual(plan.size, node.layerImageSize); assert.match(plan.label, /SDK/);
  assert.match(plan.detail, /不含子层/); assert.match(plan.detail, /外部透明度/);
  assert.equal(nodeImageExportPlan({ ...node, layerImageStatus: "style" }, "own").kind, "unavailable", "a synthetic style PNG is not a captured own bitmap");
});

test("branch prefers the saved native group and labels frame/verification limits", () => {
  const node = own(), group = { dataUrl: saved, size: { width: 20, height: 20 }, capturedAt: "2026-10-11T00:00:00Z" };
  const plan = nodeImageExportPlan(node, "branch", group);
  assert.equal(plan.kind, "group"); if (plan.kind !== "group") return;
  assert.equal(plan.dataUrl, group.dataUrl); assert.deepEqual(plan.size, group.size); assert.match(plan.detail, /不同帧/); assert.match(plan.detail, /逐像素/);
  assert.equal(nodeImageExportPlan(node, "branch", { ...group, dataUrl: "data:image/svg+xml;base64,AA==" }).kind, "unavailable");
});

test("local branch reports missing layers; skips device-invisible branches and known empty/non-drawing nodes", () => {
  const node = { ...makeNode("0"), attributes: { "skip-draw": "true" }, children: [own(), makeNode("missing"),
    { ...own(), layerImageStatus: "style" as const }, { ...makeNode("empty"), layerImageEmpty: true },
    { ...makeNode("hidden"), visibleToUser: false, children: [makeNode("hidden-child")] }] };
  const plan = nodeImageExportPlan(node, "branch");
  assert.equal(plan.kind, "composite"); if (plan.kind !== "composite") return;
  assert.equal(plan.missingCount, 2); assert.match(plan.label, /缺 2 层/); assert.match(plan.detail, /折叠或隐藏/);
  node.children = []; assert.equal(nodeImageExportPlan(node, "branch").kind, "unavailable");
  assert.match(nodeImageExportPlan(makeNode("missing"), "own").detail, /不代表透明/);
  assert.match(nodeImageExportPlan(makeNode("missing"), "branch").detail, /不会从整屏截图裁图/);
});

test("image planning rejects invalid bounds and dimensions instead of resizing exports", () => {
  for (const size of [{ width: 0, height: 1 }, { width: 1.5, height: 2 }, { width: 20_000, height: 1 }, { width: 4096, height: 4096 }])
    assert.equal(exportableImageSize(size), false);
  const node = own(); node.bounds = { left: 0, top: 0, right: 4097, bottom: 1, raw: "" };
  assert.equal(nodeImageExportPlan(node, "branch").kind, "unavailable");
  node.bounds.left = NaN; assert.equal(nodeImageExportPlan(node, "branch").kind, "unavailable");
  node.layerImageSize.width = 0; assert.equal(nodeImageExportPlan(node, "own").kind, "unavailable");
});

test("PNG export preserves dimensions, RGBA bytes, and alpha=0/1/255", async () => {
  const { request, pixels } = await fixture(); const result = await prepareNodeImage(request);
  const decoded = await sharp(result.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 3); assert.equal(decoded.info.height, 1); assert.deepEqual(decoded.data, pixels);
  assert.equal((await prepareNodeImage({ ...request, size: null })).bytes.length, result.bytes.length, "old saved bitmaps can infer dimensions");
});

test("lossless/lossy WebP becomes PNG with original alpha; JPEG becomes opaque PNG", async () => {
  for (const value of webpImages) {
    const result = await prepareNodeImage({ action: "copy", dataUrl: `data:image/webp;base64,${value.data}`, size: { width: 2, height: 2 }, defaultFileName: value.name });
    assert.equal((await sharp(result.bytes).metadata()).format, "png");
    const data = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
    assert.deepEqual([data[3], data[7], data[11], data[15]], [0, 0, 0, value.alpha], value.name);
  }
  const jpeg = await sharp({ create: { width: 2, height: 1, channels: 3, background: "red" } }).jpeg().toBuffer();
  const result = await prepareNodeImage({ action: "copy", dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`, size: null, defaultFileName: "jpeg" });
  const data = await sharp(result.bytes).ensureAlpha().raw().toBuffer(); assert.equal(data[3], 255); assert.equal(data[7], 255);
});

test("corrupt, truncated, mislabelled and oversized images fail before save dialog or clipboard", async () => {
  const { request, bytes } = await fixture();
  const invalid: unknown[] = [null, { ...request, action: "delete" }, { ...request, size: undefined }, { ...request, size: { width: 3, height: 2 } },
    { ...request, size: { width: 20_000, height: 1 } }, { ...request, dataUrl: "data:image/png;base64,aGVsbG8=" },
    { ...request, dataUrl: request.dataUrl.replace("image/png", "image/webp") }, { ...request, dataUrl: `${request.dataUrl}=` },
    { ...request, dataUrl: `data:image/png;base64,${bytes.subarray(0, 45).toString("base64")}` }, { ...request, dataUrl: "https://example.test/screen.png" },
    { ...request, dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }];
  for (const input of invalid) { const target = ports(); assert.ok((await outputNodeImage(input, target)).error); assert.deepEqual(target.calls, []); }
});

test("cancelled save never writes; save/copy use decoded PNG, and filename is safe", async () => {
  const { request, pixels } = await fixture(); const cancelled = ports(null);
  assert.deepEqual(await outputNodeImage(request, cancelled), { canceled: true, filePath: null, error: null }); assert.equal(cancelled.calls.length, 1);
  const saved = ports(); assert.deepEqual(await outputNodeImage({ ...request, defaultFileName: "../a:b?.png" }, saved), { canceled: false, filePath: "/test/control.png", error: null });
  assert.deepEqual(saved.calls, ["dialog:android-ui-a_b_.png", "write:/test/control.png"]); assert.deepEqual(await sharp(saved.output!).raw().toBuffer(), pixels);
  const copied = ports(); assert.deepEqual(await outputNodeImage({ ...request, action: "copy" }, copied), { canceled: false, filePath: null, error: null });
  assert.deepEqual(copied.calls, ["copy"]); assert.deepEqual(await sharp(copied.output!).raw().toBuffer(), pixels);
});

test("asynchronous save and clipboard failures are reported before success", async () => {
  const { request } = await fixture(); const target = ports();
  assert.match((await outputNodeImage(request, { ...target, write: async () => { throw new Error("disk full"); } })).error!, /disk full/);
  assert.match((await outputNodeImage({ ...request, action: "copy" }, { ...target, copy: async () => { throw new Error("clipboard unavailable"); } })).error!, /clipboard unavailable/);
});
