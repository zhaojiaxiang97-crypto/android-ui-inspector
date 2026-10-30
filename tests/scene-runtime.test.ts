import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { QmlGroupImage, UiNode } from "../shared/types";
import type { LayerRecord } from "../shared/layer-layout";
import { DEFAULT_LAYER_APPEARANCE } from "../src/features/layers/appearance";
import { LayerSceneRuntime } from "../src/features/layers/scene-runtime";
import { SceneTextureRuntime, MAX_LAYER_TEXTURE_PIXELS, type TextureDemand } from "../src/features/layers/scene-texture-runtime";
import { SceneGroupRuntime, type SceneGroups } from "../src/features/layers/scene-group-runtime";
import type { SceneFrameInput } from "../src/features/layers/scene-frame-runtime";
import type { SceneRuntimePorts, SceneScheduler } from "../src/features/layers/scene-runtime-ports";
import type { LayerCamera, Renderer, ScenePlane, TextureContent } from "../src/features/layers/types";
import { cameraRotation, pickProjectedPlane, projectPlane } from "../src/features/layers/projection";
import { pointOnPaintedPlane } from "../src/features/layers/quick-select";
import { LAYER_MOTION_FALLBACK_LIMIT } from "../src/features/layers/motion";

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function node(id: string): UiNode {
  return { id, index: 0, className: "View", package: "test", text: null, resourceId: null, contentDesc: null,
    bounds: { left: 0, top: 0, right: 100, bottom: 100, raw: "" }, clickable: false, enabled: true, focusable: false,
    focused: false, scrollable: false, selected: false, visibleToUser: true, children: [], layerImageDataUrl: id };
}
function bitmap(width = 100, height = 100) { return { width, height, closed: 0, close() { this.closed++; } } as ImageBitmap & { closed: number }; }
const camera: LayerCamera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 96, panX: 0, panY: 0 };
function plane(item: UiNode, z = 0, key = item.id): ScenePlane {
  return { id: item.id, node: item, rect: { left: 0, top: 0, width: 100, height: 100 }, source: { left: 0, top: 0, width: 100, height: 100 },
    textureSrc: key, textureSize: { width: 100, height: 100 }, z, kind: "native", opacity: 1, hitTestable: true, hitPolicy: "content",
    quickSelect: { collapsed: false, screen: { left: 0, top: 0, width: 100, height: 100 } } };
}
function input(planes: ScenePlane[], motionContext: object, expanded: ReadonlySet<string> = new Set()): SceneFrameInput {
  const pivot = { x: 50, y: 50, z: 0 };
  return { target: { planes, presentation: { depths: new Map(planes.map(p => [p.id.replace(/:parent$/, ""), p.z])), center: pivot, pivot, scale: 1 } },
    motionContext, expanded, parents: new Map([["root", null], ["child", "root"]]), size: { width: 100, height: 100 },
    framingFrames: [], appearance: DEFAULT_LAYER_APPEARANCE, displayMode: "images" };
}
function demand(item: UiNode, key = item.id, group: QmlGroupImage | null = null): TextureDemand {
  return { key, record: { id: item.id, node: item, isCollapsed: Boolean(group), renderBounds: item.bounds } as unknown as LayerRecord,
    group, clips: [], hidden: new Set(), maxPixels: 2_000_000 };
}
function harness(src = "screen") {
  let now = 0, next = 1, reduced = false;
  const frames = new Map<number, () => void>(), timers = new Map<number, () => void>(), canceled = new Set<number>();
  const scheduler: SceneScheduler = {
    now: () => now, reducedMotion: () => reduced,
    requestFrame(callback) { const id = next++; frames.set(id, callback); return id; }, cancelFrame(id) { canceled.add(id); },
    setTimer(callback) { const id = next++; timers.set(id, callback); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimer(id) { canceled.add(id as unknown as number); },
  };
  const canvas = Object.assign(new EventTarget(), { dataset: {}, clientWidth: 100, clientHeight: 100 }) as unknown as HTMLCanvasElement;
  const renderers: Renderer[] = [], disposed: Renderer[] = [], deleted: unknown[] = [], screenshots: Array<{ src: string; ready(image: HTMLImageElement): void; failed(): void }> = [];
  const uploaded: string[] = [], states: string[] = [], warnings: Array<string | null> = [], groups: SceneGroups[] = [];
  let screenshotUploads = 0, draws = 0, paints = 0, decodes = 0;
  const ports: SceneRuntimePorts = {
    scheduler,
    createRenderer() {
      const renderer = { canvas, textureReady: false, cssWidth: 100, cssHeight: 100, gl: { deleteTexture(texture: unknown) { deleted.push(texture); } },
        layerTextures: new Map(), layerTextureBytes: new Map(), layerAlphaScans: new Map(), layerAlphaMasks: new Map(), layerContentRects: new Map(), sourcePlanes: null } as unknown as Renderer;
      renderers.push(renderer); return renderer;
    },
    disposeRenderer(renderer) { disposed.push(renderer); },
    loadScreenshot(src, ready, failed) { screenshots.push({ src, ready, failed }); return () => {}; },
    uploadScreenshot(renderer) { screenshotUploads++; renderer.textureReady = true; return true; },
    decode: async () => { decodes++; return bitmap(); }, compose: async () => { throw new Error("unexpected local composition"); }, clip: (_node, _clips, image) => image,
    uploadLayer(renderer, key, image, budget) {
      uploaded.push(key); renderer.layerTextures.set(key, {} as WebGLTexture); renderer.layerTextureBytes.set(key, Math.min(image.width * image.height, budget) * 4);
      return { uploaded: true, scan: null };
    },
    draw(renderer, planes, view, pivot, projected) {
      draws++; renderer.cssWidth = 100; renderer.cssHeight = 100;
      projected.current = planes.filter(p => p.node && p.hitTestable).map(p => {
        const projection = projectPlane(p, pivot, view, cameraRotation(view));
        return { node: p.node!, ...projection, painted: { plane: p, camera: view, pivot, cornerDepths: projection.corners.map(c => c.depth), visible: true, kind: p.kind } };
      });
    },
  };
  const scene = new LayerSceneRuntime(canvas, ports, { status: value => states.push(value), warning: value => warnings.push(value), groups: value => groups.push(value), painted: () => paints++ });
  const root = node("root"), scope = {};
  const context = { root, src, savedGroups: new Map<string, QmlGroupImage>() };
  scene.setContext(context); scene.setFrame(input([plane(root)], scope), camera);
  scene.setDemand({ textures: new Map(), groups: new Map(), visibility: "[]", viewport: { left: 0, top: 0, width: 100, height: 100 } });
  const ready = () => screenshots.at(-1)!.ready({} as HTMLImageElement);
  return { scene, ports, canvas, root, scope, context, renderers, disposed, deleted, screenshots, uploaded, states, warnings, groups, ready, frames, timers, canceled,
    counts: () => ({ screenshotUploads, draws, paints, decodes }), advance: (time: number) => { now = time; }, reduce: () => { reduced = true; } };
}

describe("scene renderer lifetime", () => {
  test("independent layers render without requesting a missing screen and accept a later screen", async () => {
    const h = harness("");
    assert.equal(h.screenshots.length, 0); assert.equal(h.states.at(-1), "webgl");
    h.scene.setDemand({ textures: new Map([[h.root.id, demand(h.root)]]), groups: new Map(), visibility: "[]", viewport: { left: 0, top: 0, width: 100, height: 100 } });
    h.scene.draw(); await tick();
    assert.ok(h.uploaded.includes(h.root.id)); assert.ok(h.scene.painted);
    const renderer = h.renderers[0];
    h.scene.setContext({ ...h.context, src: "late-screen" });
    assert.equal(h.screenshots.length, 1); h.ready();
    assert.equal(h.renderers[0], renderer); assert.equal(h.states.at(-1), "webgl");
    h.scene.dispose();
  });
  test("root and session replacement reuse an unchanged full screenshot", () => {
    const h = harness(); h.ready();
    h.scene.setContext({ ...h.context, root: node("replacement"), sessionKey: "new-session" }); h.scene.draw();
    assert.equal(h.screenshots.length, 1); assert.equal(h.counts().screenshotUploads, 1); h.scene.dispose();
  });

  test("late screenshot callbacks cannot upload or overwrite a replacement scene", () => {
    const h = harness(), old = h.screenshots[0];
    h.scene.setContext({ ...h.context, src: "new-screen" }); h.ready();
    const before = h.counts(); old.ready({} as HTMLImageElement); old.failed();
    assert.deepEqual(h.counts(), before); assert.equal(h.states.at(-1), "webgl");
    h.scene.dispose(); h.scene.dispose();
    h.screenshots.at(-1)!.failed(); h.screenshots.at(-1)!.ready({} as HTMLImageElement);
    assert.deepEqual(h.counts(), before); assert.equal(h.disposed.length, 1);
  });

  test("loss invalidates decode and repaint callbacks; repeated restore creates one renderer", async () => {
    const h = harness(), late = deferred<ImageBitmap>(), image = bitmap();
    h.ports.decode = () => late.promise;
    h.scene.setDemand({ textures: new Map([[h.root.id, demand(h.root)]]), groups: new Map(), visibility: "[]", viewport: { left: 0, top: 0, width: 100, height: 100 } });
    h.ready(); h.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    const old = h.screenshots[0], before = h.counts();
    late.resolve(image); await tick(); old.ready({} as HTMLImageElement); old.failed();
    assert.equal(image.closed, 1); assert.equal(h.uploaded.length, 0); assert.deepEqual(h.counts(), before); assert.equal(h.scene.painted, null);
    h.canvas.dispatchEvent(new Event("webglcontextrestored")); h.canvas.dispatchEvent(new Event("webglcontextrestored"));
    assert.equal(h.renderers.length, 2); assert.equal(h.disposed.length, 1);
    h.ports.decode = async () => bitmap(); h.ready(); await tick(); assert.deepEqual(h.uploaded, ["root"]);
    const queued = [...h.frames.values()]; h.scene.dispose(); const disposed = h.counts();
    for (const callback of queued) callback();
    assert.deepEqual(h.counts(), disposed); assert.equal(h.disposed.length, 2);
  });

  test("a pending alpha texture is removed on source replacement and its old scan cannot publish", async () => {
    const h = harness(), scan = deferred<TextureContent>();
    const upload = h.ports.uploadLayer;
    let first = true;
    h.ports.uploadLayer = (...args) => { const value = upload(...args); return first ? (first = false, { uploaded: true, scan: () => scan.promise }) : value; };
    h.scene.setDemand({ textures: new Map([["root", demand(h.root)]]), groups: new Map(), visibility: "[]", viewport: { left: 0, top: 0, width: 100, height: 100 } });
    h.ready(); await tick(); assert.equal(h.renderers[0].layerTextures.size, 1);
    h.scene.setContext({ ...h.context, src: "new-source" });
    assert.equal(h.renderers[0].layerTextures.size, 0);
    h.ready(); await tick(); assert.deepEqual(h.uploaded, ["root", "root"]);
    scan.resolve({ rect: { left: 77, top: 77, width: 1, height: 1 } }); await tick();
    assert.equal(h.renderers[0].layerContentRects.has("root"), false);
    h.scene.dispose();
  });

  test("context loss blocks alpha publication and releases the bitmap when scanning finishes", async () => {
    const h = harness(), scan = deferred<TextureContent>(), image = bitmap();
    h.ports.decode = async () => image;
    const upload = h.ports.uploadLayer;
    h.ports.uploadLayer = (...args) => { upload(...args); return { uploaded: true, scan: () => scan.promise }; };
    h.scene.setDemand({ textures: new Map([["root", demand(h.root)]]), groups: new Map(), visibility: "[]", viewport: { left: 0, top: 0, width: 100, height: 100 } });
    h.ready(); await tick(); const queued = [...h.frames.values()];
    h.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    const before = h.counts(); scan.resolve({ rect: null }); await tick(); for (const callback of queued) callback();
    assert.equal(image.closed, 1); assert.equal(h.renderers[0].layerContentRects.size, 0); assert.deepEqual(h.counts(), before); h.scene.dispose();
  });
});

describe("texture demands and resource budget", () => {
  test("withdrawn native and group decodes close their late bitmap without uploading", async () => {
    for (const grouped of [false, true]) {
      const h = harness(), wait = deferred<ImageBitmap>(), image = bitmap(); h.ports.decode = () => wait.promise;
      const textures = new SceneTextureRuntime(h.renderers[0], h.ports, () => {}, () => {}); h.renderers[0].textureReady = true;
      const group = grouped ? { dataUrl: "group", size: { width: 100, height: 100 }, capturedAt: "2026-10-14" } as QmlGroupImage : null;
      textures.update(new Map([["root", demand(h.root, "root", group)]])); textures.schedule(["root"], "[]"); textures.schedule([], "[]");
      wait.resolve(image); await tick(); assert.equal(image.closed, 1); assert.equal(h.uploaded.length, 0); textures.dispose(); h.scene.dispose();
    }
  });

  test("pruning retains outgoing pixels, then budget pressure evicts only retired textures", async () => {
    const h = harness(), renderer = h.renderers[0]; renderer.textureReady = true;
    const textures = new SceneTextureRuntime(renderer, h.ports, () => {}, () => {});
    renderer.layerTextures.set("retired", {} as WebGLTexture); renderer.layerTextureBytes.set("retired", MAX_LAYER_TEXTURE_PIXELS * 4);
    textures.update(new Map([["root", demand(h.root)]])); textures.prune([plane(h.root, 0, "retired")]); assert.equal(renderer.layerTextures.has("retired"), true);
    textures.schedule(["root"], "[]"); await tick();
    assert.equal(renderer.layerTextures.has("retired"), false); assert.equal(renderer.layerTextures.has("root"), true);
    textures.update(new Map()); textures.prune([]); assert.equal(renderer.layerTextures.size, 0); textures.dispose(); h.scene.dispose();
  });

  test("selection and hover frames do not decode or upload an unchanged texture again", async () => {
    const h = harness(); h.scene.setDemand({ textures: new Map([["root", demand(h.root)]]), groups: new Map(), visibility: "[]", viewport: { left: 0, top: 0, width: 100, height: 100 } });
    h.ready(); await tick(); const before = h.counts();
    for (const kind of ["selection", "hover"] as const) {
      const base = plane(h.root); h.scene.setFrame(input([base, { ...base, id: `root:${kind}`, node: null, kind, hitTestable: false, textureSrc: null }], h.scope), camera); h.scene.draw();
    }
    await tick(); assert.equal(h.counts().decodes, before.decodes); assert.equal(h.uploaded.length, 1); h.scene.dispose();
  });
});

describe("painted frame ownership", () => {
  test("folding retains outgoing children until the parent image is ready, using one frame for paint/pick/quick mapping", () => {
    const h = harness(), child = node("child"), expanded = input([plane(h.root, -20), plane(child, 20)], h.scope, new Set(["root"]));
    h.scene.setFrame(expanded, camera); h.ready();
    const folded = { ...plane(h.root, 0, "folded"), id: "root:parent", kind: "composite" as const, quickSelect: { collapsed: true, screen: { left: 0, top: 0, width: 100, height: 100 } } };
    h.scene.setFrame(input([folded], h.scope), camera); h.advance(220); h.scene.draw();
    assert.ok(h.scene.painted!.frame.planes.some(p => p.id === "child:motion"));
    const painted = h.scene.painted!, picked = pickProjectedPlane({ x: 50, y: 50 }, painted.projected)!;
    assert.equal(picked.painted!.plane, painted.frame.planes.find(p => p.id === "root:parent"));
    assert.equal(picked.painted!.camera, painted.camera); assert.deepEqual(pointOnPaintedPlane(picked, { x: 50, y: 50 }), { x: 50, y: 50 });
    h.renderers[0].layerTextures.set("folded", {} as WebGLTexture); h.scene.draw();
    assert.equal(h.scene.painted!.frame.planes.some(p => p.id.endsWith(":motion")), false); h.scene.dispose();
  });

  test("fallback is bounded, while canceled animation and fallback callbacks cannot repaint", () => {
    const h = harness(); h.scene.setFrame(input([plane(h.root), plane(node("child"), 20)], h.scope, new Set(["root"])), camera); h.ready();
    h.scene.setFrame(input([{ ...plane(h.root, 0, "folded"), kind: "composite" }], h.scope), camera); h.scene.draw();
    const lateFrames = [...h.frames.values()], fallback = [...h.timers.values()].at(-1)!;
    h.advance(LAYER_MOTION_FALLBACK_LIMIT); fallback();
    assert.equal(h.scene.frames.moving, false); assert.equal(h.scene.painted!.frame.planes.length, 1);
    const before = h.counts(); for (const callback of lateFrames) callback(); fallback(); assert.deepEqual(h.counts(), before);
    h.scene.dispose();
  });

  test("reversals start from the last painted geometry and keep the imperative camera", () => {
    const h = harness(), child = node("child"), opened = input([plane(h.root, -20), plane(child, 20)], h.scope, new Set(["root"]));
    h.scene.setFrame(opened, camera); h.ready(); h.scene.setFrame(input([plane(h.root, 0, "folded")], h.scope), camera); h.advance(110); h.scene.draw();
    const outgoing = h.scene.painted!.frame.planes.find(p => p.id === "child:motion")!.z;
    const actual = { ...camera, azimuth: 31, panX: 24 }; h.scene.paintCamera(actual); h.scene.setFrame(opened, actual); h.scene.draw();
    assert.equal(h.scene.painted!.frame.planes.find(p => p.id === "child")!.z, outgoing);
    assert.equal(h.scene.painted!.camera.azimuth, 31); h.reduce(); h.scene.interruptMotion(); assert.equal(h.scene.frames.moving, false); h.scene.dispose();
  });
});

describe("group capture scope", () => {
  test("groups are demanded while the screenshot is pending and when WebGL is unavailable", async () => {
    for (const fallback of [false, true]) {
      const h = harness(); h.scene.dispose(); let captures = 0;
      const scene = new LayerSceneRuntime(h.canvas, { ...h.ports, createRenderer: fallback ? () => null : h.ports.createRenderer },
        { status() {}, warning() {}, groups() {}, painted() {} });
      scene.setContext({ ...h.context, capture: async () => { captures++; return null; } });
      scene.setFrame(input([plane(h.root)], h.scope), camera);
      scene.setDemand({ textures: new Map(), groups: new Map([["root", h.root]]), visibility: "[]", viewport: { left: 0, top: 0, width: 100, height: 100 } });
      scene.draw(); await tick(); assert.equal(captures, 1); scene.dispose();
    }
  });

  test("a group arriving after loss and scene replacement cannot overwrite restored groups", async () => {
    const h = harness(), old = deferred<QmlGroupImage | null>();
    h.scene.setContext({ ...h.context, capture: () => old.promise });
    h.scene.setDemand({ textures: new Map(), groups: new Map([["root", h.root]]), visibility: "[]", viewport: { left: 0, top: 0, width: 100, height: 100 } }); h.scene.draw();
    h.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    const fresh = { dataUrl: "fresh", capturedAt: "2026-10-14", size: { width: 100, height: 100 } } as QmlGroupImage;
    h.scene.setContext({ ...h.context, root: node("root"), sessionKey: "new", savedGroups: new Map([["root", fresh]]) });
    h.canvas.dispatchEvent(new Event("webglcontextrestored"));
    const before = h.groups.length; old.resolve({ ...fresh, dataUrl: "old" }); await tick();
    assert.equal(h.groups.length, before); assert.equal(h.groups.at(-1)!.images.get("root"), fresh); h.scene.dispose();
  });

  test("context loss retains a capture without republishing while lost or recapturing on restore", async () => {
    const h = harness(), captured = deferred<QmlGroupImage | null>(); let captures = 0;
    h.scene.setContext({ ...h.context, capture: () => { captures++; return captured.promise; } });
    h.scene.setDemand({ textures: new Map(), groups: new Map([["root", h.root]]), visibility: "[]", viewport: { left: 0, top: 0, width: 100, height: 100 } });
    h.ready(); assert.equal(captures, 1); h.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true })); const before = h.groups.length;
    const image = { dataUrl: "group", capturedAt: "2026-10-14", size: { width: 100, height: 100 } } as QmlGroupImage;
    captured.resolve(image); await tick(); assert.equal(h.groups.length, before);
    h.canvas.dispatchEvent(new Event("webglcontextrestored")); h.ready(); await tick(); assert.equal(captures, 1); assert.equal(h.groups.at(-1)!.images.get("root"), image); h.scene.dispose();
  });

  test("late captures from an old root/session never enter the replacement scene", async () => {
    const wait = deferred<QmlGroupImage | null>(), root = node("root"), output: SceneGroups[] = [];
    const groups = new SceneGroupRuntime({ root, src: "screen", sessionKey: "old", savedGroups: new Map(), capture: () => wait.promise }, state => output.push(state));
    groups.schedule(["root"], new Map([["root", root]])); groups.dispose(); const before = output.length;
    wait.resolve({ dataUrl: "old" } as QmlGroupImage); await tick(); groups.dispose(); assert.equal(output.length, before);
  });
});
