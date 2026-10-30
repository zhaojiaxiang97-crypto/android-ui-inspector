import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { nodeImageExportPlan } from "../shared/node-image-export";
import { prepareNodeImagePreview } from "../src/features/layers/prepareNodeImagePreview";
import { prepareNodeImageExport } from "../src/features/layers/prepareNodeImageExport";

const dataUrl = "data:image/png;base64,aGVsbG8=";
const node = () => ({ ...makeNode("saved"), layerImageDataUrl: dataUrl, layerImageSize: { width: 2, height: 3 }, layerImageStatus: "captured" as const });
function decoder(width: number, height: number, decode: () => Promise<void> = async () => {}) {
  const previous = globalThis.Image;
  const instances: { src: string; sources: string[] }[] = [];
  class ImageFixture {
    naturalWidth = width; naturalHeight = height; sources: string[] = [];
    constructor() { instances.push(this); }
    set src(value: string) { this.sources.push(value); }
    get src() { return this.sources.at(-1) ?? ""; }
    decode = decode;
  }
  globalThis.Image = ImageFixture as unknown as typeof Image;
  return { instances, restore() { globalThis.Image = previous; } };
}

test("preview verifies saved pixels, infers legacy dimensions and releases the decoder", async () => {
  const fixture = decoder(2, 3);
  try {
    const current = node();
    assert.deepEqual(await prepareNodeImagePreview(current, nodeImageExportPlan(current, "own"), new AbortController().signal), { dataUrl, size: { width: 2, height: 3 } });
    const legacy = { ...current, layerImageSize: undefined };
    assert.deepEqual((await prepareNodeImagePreview(legacy, nodeImageExportPlan(legacy, "own"), new AbortController().signal)).size, { width: 2, height: 3 });
    assert.equal(fixture.instances.length, 2);
    for (const image of fixture.instances) assert.deepEqual(image.sources, [dataUrl, ""]);
  } finally { fixture.restore(); }
});

test("preview rejects mismatched and oversized decoded dimensions instead of labelling them as original pixels", async () => {
  for (const [width, height, expected] of [[3, 3, /尺寸与记录不一致/], [20_000, 1, /超过预览限制/], [0, 3, /尺寸无效/]] as const) {
    const fixture = decoder(width, height);
    try {
      const current = node();
      await assert.rejects(prepareNodeImagePreview(current, nodeImageExportPlan(current, "own"), new AbortController().signal), expected);
      assert.equal(fixture.instances[0].src, "");
    } finally { fixture.restore(); }
  }
});

test("preview reports corrupted saved images and releases their source", async () => {
  const fixture = decoder(2, 3, async () => { throw new DOMException("corrupt", "EncodingError"); });
  try {
    const current = node();
    await assert.rejects(prepareNodeImagePreview(current, nodeImageExportPlan(current, "own"), new AbortController().signal), /已保存图片无法解码/);
    assert.equal(fixture.instances[0].src, "");
  } finally { fixture.restore(); }
});

test("closing during decode aborts promptly; a late decode never returns a preview result", async () => {
  let release!: () => void;
  const fixture = decoder(2, 3, () => new Promise<void>(resolve => { release = resolve; }));
  try {
    const current = node(), controller = new AbortController();
    const pending = prepareNodeImagePreview(current, nodeImageExportPlan(current, "own"), controller.signal);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(typeof release, "function");
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(fixture.instances[0].src, "");
    release(); await Promise.resolve();
    assert.equal(fixture.instances[0].src, "");
  } finally { fixture.restore(); }
});

test("a pre-cancelled or missing bitmap is never decoded", async () => {
  const fixture = decoder(2, 3);
  try {
    const current = node(), controller = new AbortController(); controller.abort();
    await assert.rejects(prepareNodeImagePreview(current, nodeImageExportPlan(current, "own"), controller.signal), { name: "AbortError" });
    const missing = makeNode("missing");
    await assert.rejects(prepareNodeImagePreview(missing, nodeImageExportPlan(missing, "own"), new AbortController().signal), /没有保存/);
    assert.equal(fixture.instances.length, 0);
  } finally { fixture.restore(); }
});

function compositor(create: (image: ImageBitmap) => Promise<ImageBitmap>) {
  const previousDocument = globalThis.document, previousCreate = globalThis.createImageBitmap, previousBitmap = globalThis.ImageBitmap;
  const canvases: { width: number; height: number; encodes: number }[] = [];
  let bitmapCalls = 0;
  class BitmapFixture {
    width = 2; height = 3; closes = 0;
    close() { this.closes++; }
  }
  const bitmap = new BitmapFixture();
  globalThis.ImageBitmap = BitmapFixture as unknown as typeof ImageBitmap;
  globalThis.createImageBitmap = (() => { bitmapCalls++; return create(bitmap as unknown as ImageBitmap); }) as typeof createImageBitmap;
  globalThis.document = { createElement() {
    const canvas = { width: 0, height: 0, encodes: 0, toDataURL() { this.encodes++; return dataUrl; },
      getContext() { return { canvas, setTransform() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, drawImage() {} }; } };
    canvases.push(canvas); return canvas;
  } } as unknown as Document;
  return { bitmap, canvases, get bitmapCalls() { return bitmapCalls; }, restore() {
    globalThis.document = previousDocument; globalThis.createImageBitmap = previousCreate; globalThis.ImageBitmap = previousBitmap;
  } };
}
const compositeNode = () => ({ ...node(), bounds: { left: 0, top: 0, right: 2, bottom: 3, raw: "fixture" }, attributes: { alpha: "0.5" } });
async function reaches(predicate: () => boolean) {
  for (let count = 0; count < 40 && !predicate(); count++) await Promise.resolve();
  assert.equal(predicate(), true, "preparation did not reach its controlled async stage");
}
async function abortsPromptly(pending: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("cancel waited for the held operation")), 200); });
  try { await assert.rejects(Promise.race([pending, timeout]), { name: "AbortError" }); }
  finally { clearTimeout(timer!); }
}

test("composite preview aborts a held decode and releases both opacity-group and output canvases before decode returns", async () => {
  let release!: () => void;
  const decoded = decoder(2, 3, () => new Promise<void>(resolve => { release = resolve; }));
  const composed = compositor(async bitmap => bitmap);
  try {
    const current = compositeNode(), controller = new AbortController();
    const pending = prepareNodeImagePreview(current, nodeImageExportPlan(current, "branch"), controller.signal);
    await reaches(() => Boolean(release));
    assert.deepEqual(composed.canvases.map(canvas => [canvas.width, canvas.height]), [[2, 3], [2, 3]]);
    controller.abort();
    assert.equal(decoded.instances[0].src, "", "abort must clear the decoder synchronously");
    await abortsPromptly(pending);
    assert.deepEqual(composed.canvases.map(canvas => [canvas.width, canvas.height, canvas.encodes]), [[0, 0, 0], [0, 0, 0]]);
    assert.equal(composed.bitmapCalls, 0);
    release(); await reaches(() => decoded.instances[0].src === "");
    assert.equal(composed.bitmapCalls, 0, "a late decode must not begin bitmap creation");
  } finally { composed.restore(); decoded.restore(); }
});

test("composite preparation releases canvases immediately while still closing a bitmap that arrives after abort", async () => {
  let release!: (bitmap: ImageBitmap) => void;
  const decoded = decoder(2, 3);
  const composed = compositor(() => new Promise<ImageBitmap>(resolve => { release = resolve; }));
  try {
    const current = compositeNode(), controller = new AbortController();
    const pending = prepareNodeImageExport(current, nodeImageExportPlan(current, "branch"), controller.signal);
    await reaches(() => Boolean(release)); controller.abort();
    assert.equal(decoded.instances[0].src, ""); await abortsPromptly(pending);
    assert.deepEqual(composed.canvases.map(canvas => [canvas.width, canvas.height, canvas.encodes]), [[0, 0, 0], [0, 0, 0]]);
    assert.equal(composed.bitmap.closes, 0, "the unresolved bitmap has not arrived yet");
    release(composed.bitmap as unknown as ImageBitmap); await reaches(() => composed.bitmap.closes === 1);
    assert.equal(composed.bitmap.closes, 1, "a late bitmap must close exactly once");
  } finally { composed.restore(); decoded.restore(); }
});

test("successful composite output keeps original size and closes each bitmap and canvas once", async () => {
  const decoded = decoder(2, 3), composed = compositor(async bitmap => bitmap);
  try {
    const current = compositeNode();
    const output = await prepareNodeImageExport(current, nodeImageExportPlan(current, "branch"), new AbortController().signal);
    assert.deepEqual(output, { dataUrl, size: { width: 2, height: 3 } });
    assert.equal(composed.bitmap.closes, 1);
    assert.deepEqual(composed.canvases.map(canvas => [canvas.width, canvas.height, canvas.encodes]), [[0, 0, 1], [0, 0, 0]]);
    assert.equal(decoded.instances[0].src, "");
  } finally { composed.restore(); decoded.restore(); }
});

test("abort in the microtask between bitmap ownership check and composite handoff still closes the bitmap exactly once", async () => {
  const controller = new AbortController();
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(controller.signal), "aborted")!;
  const gateReads: boolean[] = []; let bitmapCreated = false;
  Object.defineProperty(controller.signal, "aborted", { get() {
    const value = descriptor.get!.call(controller.signal) as boolean;
    if (bitmapCreated) gateReads.push(value);
    return value;
  } });
  const decoded = decoder(2, 3);
  const composed = compositor(bitmap => {
    bitmapCreated = true;
    const created = Promise.resolve(bitmap);
    // This reaction precedes the loader's bitmap.then. Its queued cancellation
    // runs after that gate, but before the awaiting consumer resumes.
    void created.then(() => queueMicrotask(() => controller.abort()));
    return created;
  });
  try {
    const current = compositeNode();
    await assert.rejects(prepareNodeImageExport(current, nodeImageExportPlan(current, "branch"), controller.signal), { name: "AbortError" });
    assert.deepEqual(gateReads.slice(0, 2), [false, true], "the ownership check must pass before cancellation reaches the awaiting consumer");
    assert.equal(composed.bitmap.closes, 1);
    assert.deepEqual(composed.canvases.map(canvas => [canvas.width, canvas.height, canvas.encodes]), [[0, 0, 0], [0, 0, 0]]);
    assert.equal(decoded.instances[0].src, "");
  } finally { composed.restore(); decoded.restore(); }
});
