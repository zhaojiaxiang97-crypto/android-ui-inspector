import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { UiNode } from "../shared/types";
import { Layer3DPreview } from "../src/features/layers/Layer3DPreview";
import type { LayerSceneHandle } from "../src/features/layers/types";
import { DEFAULT_LAYER_APPEARANCE } from "../src/features/layers/appearance";
import { makeNode } from "./fixtures";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/workbench.css";
import "../src/styles/appearance.css";

type Native = { checkpoint: (name: string) => Promise<void> };
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const settle = async () => { for (let index = 0; index < 5; index++) await tick(); };
async function until(predicate: () => boolean, message: string) {
  const end = performance.now() + 7000;
  while (!predicate()) { assert(performance.now() < end, message); await tick(); }
}
function pixels(size: number, color: string, inset = 0) {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(inset, inset, size - inset * 2, size - inset * 2);
  const value = canvas.toDataURL(); canvas.width = canvas.height = 0; return value;
}
const bounds = { left: 0, top: 0, right: 600, bottom: 600, raw: "[0,0][600,600]" };
function fixture(color: string, bitmapSize: number, identity: string) {
  const leaf: UiNode = { ...makeNode(`scene-${identity}`), text: identity, bounds, layerImageDataUrl: pixels(bitmapSize, color),
    layerImageSize: { width: bitmapSize, height: bitmapSize }, layerImageStatus: "captured" };
  const root: UiNode = { ...makeNode("scene-root"), bounds, layerImageEmpty: true, children: [leaf] };
  return { root, leaf, src: pixels(600, "#182029") };
}
function gpuResources() {
  const prototype = WebGLRenderingContext.prototype;
  const created = { texture: new Set<WebGLTexture>(), buffer: new Set<WebGLBuffer>(), program: new Set<WebGLProgram>() };
  const deleted = { texture: new Set<WebGLTexture>(), buffer: new Set<WebGLBuffer>(), program: new Set<WebGLProgram>() };
  const previous = { createTexture: prototype.createTexture, deleteTexture: prototype.deleteTexture,
    createBuffer: prototype.createBuffer, deleteBuffer: prototype.deleteBuffer, createProgram: prototype.createProgram, deleteProgram: prototype.deleteProgram };
  prototype.createTexture = function () { const result = previous.createTexture.call(this); if (result) created.texture.add(result); return result; };
  prototype.deleteTexture = function (value) { if (value) deleted.texture.add(value); previous.deleteTexture.call(this, value); };
  prototype.createBuffer = function () { const result = previous.createBuffer.call(this); if (result) created.buffer.add(result); return result; };
  prototype.deleteBuffer = function (value) { if (value) deleted.buffer.add(value); previous.deleteBuffer.call(this, value); };
  prototype.createProgram = function () { const result = previous.createProgram.call(this); if (result) created.program.add(result); return result; };
  prototype.deleteProgram = function (value) { if (value) deleted.program.add(value); previous.deleteProgram.call(this, value); };
  const counts = () => Object.fromEntries((Object.keys(created) as (keyof typeof created)[]).map(kind => [kind, { created: created[kind].size, deleted: deleted[kind].size }]));
  return { created, deleted, counts, restore: () => Object.assign(prototype, previous),
    assertReleased: () => { for (const kind of Object.keys(created) as (keyof typeof created)[]) for (const item of created[kind])
      assert((deleted[kind] as Set<unknown>).has(item), `${kind} resource leaked: ${JSON.stringify(counts())}`); } };
}

// Delay an actual decoded bitmap at the browser boundary. No controller internals are read.
function holdBitmap(src: string) {
  const previous = window.createImageBitmap, close = ImageBitmap.prototype.close;
  const waiting: { bitmap: ImageBitmap; resolve: (bitmap: ImageBitmap) => void }[] = [], closed = new Set<ImageBitmap>();
  let enabled = true;
  ImageBitmap.prototype.close = function () { closed.add(this); close.call(this); };
  window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
    const source = args[0], bitmap = await previous.apply(window, args);
    if (enabled && source instanceof HTMLImageElement && source.src === src) return await new Promise<ImageBitmap>(resolve => waiting.push({ bitmap, resolve }));
    return bitmap;
  }) as typeof createImageBitmap;
  return { waiting, closed, release: () => { enabled = false; for (const entry of waiting.splice(0)) entry.resolve(entry.bitmap); },
    restore: () => { window.createImageBitmap = previous; ImageBitmap.prototype.close = close; } };
}

// Hold the zero-delay yield immediately after a real sliced alpha read.
function holdAlpha() {
  const read = CanvasRenderingContext2D.prototype.getImageData, timeout = window.setTimeout;
  let started = false, holdNext = false, callback: (() => void) | null = null;
  CanvasRenderingContext2D.prototype.getImageData = function (...args: Parameters<typeof read>) {
    const result = read.apply(this, args);
    if (!started && this.canvas.width === 600 && this.canvas.height === 600 && args[3] === 256) {
      started = true; holdNext = true;
    }
    return result;
  };
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (holdNext && delay === 0 && typeof handler === "function") { holdNext = false; callback = () => Reflect.apply(handler, window, args); return -900001; }
    return Reflect.apply(timeout, window, [handler, delay, ...args]);
  }) as typeof window.setTimeout;
  return { started: () => started && Boolean(callback), release: () => { const pending = callback; callback = null; pending?.(); },
    restore: () => { CanvasRenderingContext2D.prototype.getImageData = read; window.setTimeout = timeout; } };
}

export async function verifySceneRuntime(native: Native) {
  const oldApi = window.electronApi; let deviceRequests = 0;
  window.electronApi = new Proxy({} as typeof oldApi, { get: (_target, name) => () => { deviceRequests++; throw new Error(`Device access forbidden: ${String(name)}`); } });
  const checks: { name: string; passed: boolean; detail?: unknown; error?: string }[] = [];
  async function check(name: string, body: () => Promise<unknown>) {
    try { checks.push({ name, passed: true, detail: await body() }); }
    catch (error) { checks.push({ name, passed: false, error: String(error) }); await native.checkpoint(`${name}-failure`); }
  }
  function mountedScene() {
    const host = document.createElement("div"); host.style.cssText = "position:relative;width:720px;height:720px"; document.body.append(host);
    const mounted = createRoot(host), scene = createRef<LayerSceneHandle>(); let alive = true, data = fixture("#00aa00", 600, "old"), session = 1;
    const camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
    const draw = () => flushSync(() => mounted.render(<Layer3DPreview ref={scene} sessionKey={session} root={data.root} src={data.src}
      selectedNode={null} expandedNodeIds={new Set([data.root.id])} size={{ width: 600, height: 600 }} renderScale={1}
      origin={{ left: 60, top: 60 }} camera={camera} appearance={DEFAULT_LAYER_APPEARANCE} onSelect={() => {}} />));
    const canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
    const ready = () => until(() => canvas()?.dataset.layerRenderer === "webgl" && canvas()?.dataset.layerTextureCount === "1"
      && canvas()?.dataset.layerTexturePendingCount === "0" && canvas()?.dataset.layerAnimationProgress === "1", `scene did not settle: ${JSON.stringify(canvas()?.dataset)}`);
    const probe = () => {
      scene.current!.paintCamera(camera); const c = canvas(), rect = c.getBoundingClientRect(), gl = c.getContext("webgl")!;
      const x = Number(c.dataset.layerProbeX), y = Number(c.dataset.layerProbeY), pixel = new Uint8Array(4);
      gl.readPixels(Math.round(x * c.width / rect.width), Math.round(c.height - y * c.height / rect.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return { node: scene.current!.pick(rect.left + x, rect.top + y)?.id, pixel: [...pixel], bytes: Number(c.dataset.layerTextureBytes) };
    };
    return { host, scene, canvas, draw, ready, probe, getData: () => data,
      replace: (kind: "root" | "root-copy" | "source" | "session") => {
        if (kind === "root") data = fixture("#0000ff", 120, "replacement");
        if (kind === "root-copy") data = { ...data, root: { ...data.root, children: [...data.root.children] } };
        if (kind === "source") data = { ...data, src: pixels(600, "#263443") };
        if (kind === "session") { data = fixture("#0000ff", 120, "replacement"); session++; }
        draw();
      },
      unmount: () => { if (alive) { flushSync(() => mounted.unmount()); alive = false; } },
      dispose: () => { if (alive) { flushSync(() => mounted.unmount()); alive = false; } host.remove(); },
    };
  }
  try {
    await check("fixed-scene-resources", async () => {
      const resources = gpuResources(), view = mountedScene();
      try {
        view.draw(); await view.ready();
        const canvas = view.canvas(), gl = canvas.getContext("webgl")!, draw = gl.drawArrays.bind(gl); let drawCalls = 0;
        gl.drawArrays = (...args) => { drawCalls++; draw(...args); };
        let result;
        try { result = view.probe(); } finally { gl.drawArrays = draw; }
        const details = { geometryRevision: Number(view.host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerGeometryRevision),
          textureCount: Number(canvas.dataset.layerTextureCount), textureBytes: Number(canvas.dataset.layerTextureBytes), drawCalls, probe: result };
        assert(details.textureCount === 1 && details.textureBytes <= 64_000_000 && drawCalls > 0, `fixed resources invalid: ${JSON.stringify(details)}`);
        await native.checkpoint("fixed-scene"); view.unmount(); resources.assertReleased(); return details;
      } finally { view.dispose(); resources.restore(); }
    });
    for (const change of ["root", "root-copy", "source", "session", "unmount"] as const) await check(`late-bitmap-${change}`, async () => {
      const resources = gpuResources(), view = mountedScene(), held = holdBitmap(view.getData().leaf.layerImageDataUrl!);
      let delayed: ImageBitmap[] = [];
      try {
        view.draw(); await until(() => held.waiting.length > 0, "bitmap decode was not held"); delayed = held.waiting.map(entry => entry.bitmap);
        const oldCanvas = view.canvas();
        if (change === "unmount") view.unmount(); else view.replace(change);
        const afterUnmount = change === "unmount" ? JSON.stringify({ ...oldCanvas.dataset }) : null;
        held.release(); await settle();
        if (change !== "unmount") {
          await view.ready(); const result = view.probe();
          assert(result.node === view.getData().leaf.id, `late bitmap published an old node: ${JSON.stringify(result)}`);
          const expected = (change === "source" || change === "root-copy") ? [0, 170, 0] : [0, 0, 255];
          assert(expected.every((value, index) => Math.abs(result.pixel[index] - value) < 3) && result.pixel[3] === 255, `late bitmap replaced current pixels: ${JSON.stringify(result)}`);
          assert(result.bytes <= 64_000_000, "texture budget exceeded");
        } else assert(JSON.stringify({ ...oldCanvas.dataset }) === afterUnmount, "late bitmap repainted detached canvas");
        await until(() => delayed.every(bitmap => held.closed.has(bitmap)), "cancelled decoded bitmap was not closed");
        view.unmount(); resources.assertReleased(); return { releasedBitmaps: delayed.length, gpu: resources.counts() };
      } finally { held.release(); await settle(); view.dispose(); held.restore(); resources.restore(); }
    });
    for (const change of ["root", "root-copy", "source", "session", "unmount"] as const) await check(`late-alpha-${change}`, async () => {
      const resources = gpuResources(), view = mountedScene(), held = holdAlpha();
      try {
        view.draw(); await until(held.started, "sliced alpha scan was not held"); const oldCanvas = view.canvas();
        if (change === "unmount") view.unmount(); else view.replace(change);
        const afterUnmount = change === "unmount" ? JSON.stringify({ ...oldCanvas.dataset }) : null;
        held.release(); await settle();
        if (change !== "unmount") {
          await view.ready(); const result = view.probe();
          assert(result.node === view.getData().leaf.id, `late alpha retained an old pick: ${JSON.stringify(result)}`);
          const expected = (change === "source" || change === "root-copy") ? [0, 170, 0] : [0, 0, 255];
          assert(expected.every((value, index) => Math.abs(result.pixel[index] - value) < 3) && result.pixel[3] === 255, `late alpha corrupted current pixels: ${JSON.stringify(result)}`);
        } else assert(JSON.stringify({ ...oldCanvas.dataset }) === afterUnmount, "late alpha repainted detached canvas");
        view.unmount(); resources.assertReleased(); return resources.counts();
      } finally { held.release(); await settle(); view.dispose(); held.restore(); resources.restore(); }
    });
    for (const delayed of ["bitmap", "alpha"] as const) await check(`context-loss-pending-${delayed}`, async () => {
      const resources = gpuResources(), view = mountedScene();
      const bitmap = delayed === "bitmap" ? holdBitmap(view.getData().leaf.layerImageDataUrl!) : null;
      const alpha = delayed === "alpha" ? holdAlpha() : null;
      try {
        view.draw(); await until(() => bitmap ? bitmap.waiting.length > 0 : alpha!.started(), `${delayed} work was not held`);
        const oldBitmaps = bitmap?.waiting.map(entry => entry.bitmap) ?? [];
        const canvas = view.canvas(), extension = canvas.getContext("webgl")!.getExtension("WEBGL_lose_context");
        assert(extension, "WEBGL_lose_context is unavailable"); extension.loseContext();
        await until(() => canvas.dataset.layerRenderer === "fallback", "pending context loss did not enter fallback");
        extension.restoreContext(); bitmap?.release(); alpha?.release();
        await view.ready(); const result = view.probe();
        assert(result.node === view.getData().leaf.id && result.pixel.join(",") === "0,170,0,255", `old ${delayed} work corrupted restored renderer: ${JSON.stringify(result)}`);
        if (bitmap) await until(() => oldBitmaps.every(item => bitmap.closed.has(item)), "context loss leaked decoded bitmap");
        view.unmount(); resources.assertReleased(); return { probe: result, gpu: resources.counts() };
      } finally { bitmap?.release(); alpha?.release(); await settle(); view.dispose(); bitmap?.restore(); alpha?.restore(); resources.restore(); }
    });
    await check("context-loss-restore", async () => {
      const resources = gpuResources(), view = mountedScene();
      try {
        view.draw(); await view.ready(); const before = view.probe(), canvas = view.canvas(), gl = canvas.getContext("webgl")!;
        const extension = gl.getExtension("WEBGL_lose_context"); assert(extension, "WEBGL_lose_context is unavailable");
        const initial = resources.counts(); extension.loseContext();
        await until(() => canvas.dataset.layerRenderer === "fallback", "context loss did not enter fallback");
        const rect = canvas.getBoundingClientRect();
        assert(view.scene.current!.pick(rect.left + 360, rect.top + 360) === null, "lost context retained stale picking");
        extension.restoreContext(); await view.ready(); const restored = view.probe();
        assert(restored.node === before.node && restored.pixel.join(",") === before.pixel.join(","), `restore changed pixels or pick: ${JSON.stringify({ before, restored })}`);
        assert(resources.created.program.size >= 2 && resources.deleted.program.size >= 1, "context restore did not replace and release renderer resources");
        view.unmount(); resources.assertReleased(); return { initial, final: resources.counts(), probe: restored };
      } finally { view.dispose(); resources.restore(); }
    });
    assert(deviceRequests === 0, "fixture reached device API");
    return { passed: checks.every(item => item.passed), checks, deviceRequests,
      scope: "Real Layer3DPreview + WebGL; browser bitmap/alpha completion gates; root/source/session/unmount identity, bitmap close, GPU resource disposal, actual context loss/restore. Existing coordinates covers animation/pick, retiring textures and GPU budget." };
  } finally { window.electronApi = oldApi; }
}
Object.assign(window, { verifySceneRuntime });
