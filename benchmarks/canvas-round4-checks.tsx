import { createRef } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { UiNode } from "../shared/types";
import { ScreenshotPreview } from "../src/components/ScreenshotPreview";
import { EntryDialog } from "../src/components/EntryDialog";
import { NodeHoverProvider, useNodeHoverActions } from "../src/features/inspection/NodeHoverContext";
import { Layer3DPreview } from "../src/features/layers/Layer3DPreview";
import { DEFAULT_LAYER_APPEARANCE, LAYER_APPEARANCE_STORAGE_KEY, type LayerDisplayMode } from "../src/features/layers/appearance";
import { pointHitsProjectedPlane } from "../src/features/layers/projection";
import { createRenderer, disposeRenderer, drawScene, uploadLayerTexture, uploadTexture } from "../src/features/layers/webgl-renderer";
import type { LayerSceneHandle, ProjectedPlane, ScenePlane } from "../src/features/layers/types";
import { makeNode } from "./fixtures";

type NativeInput = { type: string; x?: number; y?: number; button?: string; clickCount?: number; keyCode?: string; modifiers?: string[] };
type Native = { input: (events: NativeInput[]) => Promise<void>; checkpoint: (name: string) => Promise<void> };
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Canvas round 4: ${message}`); }
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };
async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 7000;
  while (!predicate()) { assert(performance.now() < deadline, message); await tick(); }
}
function node(id: string, left: number, top: number, width: number, height: number): UiNode {
  return { ...makeNode(id), text: id, bounds: { left, top, right: left + width, bottom: top + height, raw: `[${left},${top}][${left + width},${top + height}]` } };
}
function pixels(width: number, height: number, color: string, inset = 0) {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(inset, inset, width - inset * 2, height - inset * 2);
  return canvas;
}

async function verifyWireframePixels() {
  const canvas = document.createElement("canvas"); canvas.style.cssText = "width:360px;height:280px;position:fixed;left:0;top:0;"; document.body.append(canvas);
  const renderer = createRenderer(canvas); assert(renderer, "GPU context unavailable");
  const green = pixels(140, 140, "#00aa00"), purple = pixels(100, 100, "#aa00aa", 20), screen = pixels(360, 280, "#182029");
  const image = new Image(); image.src = screen.toDataURL(); await image.decode(); assert(uploadTexture(renderer, image), "screen upload failed");
  uploadLayerTexture(renderer, "green", green, 100_000); uploadLayerTexture(renderer, "purple", purple, 100_000);
  const back = node("pixel-back", 110, 110, 140, 140), front = node("pixel-front", 80, 80, 100, 100);
  const base = (target: UiNode, textureSrc: string, width: number, height: number): ScenePlane => ({ id: target.id, node: target,
    rect: { left: target.bounds!.left, top: target.bounds!.top, width, height }, source: { left: 0, top: 0, width, height }, textureSrc,
    textureSize: { width, height }, z: 0, kind: "native", opacity: 1, hitTestable: true });
  const planes = [base(back, "green", 140, 140), base(front, "purple", 100, 100)];
  planes.push({ ...planes[1], id: "selection", kind: "selection", node: null, hitTestable: false });
  const camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 }, pivot = { x: 180, y: 140, z: 0 };
  const projected = { current: [] as ProjectedPlane[] }, appearance = { ...DEFAULT_LAYER_APPEARANCE, showOutlines: false, highlightStrength: "strong" as const };
  const read = (x: number, y: number) => {
    const values = new Uint8Array(4); renderer.gl.readPixels(Math.round(x * canvas.width / 360), Math.round(canvas.height - y * canvas.height / 280), 1, 1, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, values); return [...values];
  };
  const alphaPatch = (x: number, y: number) => {
    const values = new Uint8Array(5 * 5 * 4); renderer.gl.readPixels(Math.round(x * canvas.width / 360) - 2, Math.round(canvas.height - y * canvas.height / 280) - 2, 5, 5, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, values);
    return Math.max(...values.filter((_value, index) => index % 4 === 3));
  };
  try {
    drawScene(renderer, planes, camera, pivot, projected, appearance);
    const imagePixel = read(140, 140), prepared = renderer.preparedPlanes, texture = renderer.layerTextures.get("purple");
    assert(imagePixel[3] === 255 && imagePixel[0] > 80 && imagePixel[2] > 80 && imagePixel[1] > 0, "image/strong selection baseline missing");
    drawScene(renderer, planes, camera, pivot, projected, appearance, "wireframe");
    assert(read(140, 140)[3] === 0, "wireframe retained pixels or selected fill");
    assert(alphaPatch(80, 130) > 90, "wireframe shrank the actual boundary to alpha content");
    const pick = (x: number, y: number) => projected.current.find(plane => pointHitsProjectedPlane({ x, y }, plane))?.node.id;
    assert(pick(80, 130) === front.id && pick(110, 130) === back.id && pick(140, 140) === undefined, "wireframe front edge, rear edge and empty interior disagree");
    assert(renderer.preparedPlanes === prepared && renderer.layerTextures.get("purple") === texture && renderer.layerTextures.size === 2, "wireframe replaced image preparation or texture identity");
    const missing = { ...planes[1], id: "missing", textureSrc: "unloaded", opacity: 0, outlineOpacity: 1, rect: { left: 10, top: 20, width: 40, height: 40 } };
    drawScene(renderer, [missing], camera, pivot, projected, appearance, "wireframe");
    const missingEdge = alphaPatch(10, 40), missingInterior = read(30, 40);
    assert(missingEdge > 0 && missingInterior[3] === 0, `transparent/missing geometry lost its outline or gained a fill: ${missingEdge}/${missingInterior}`);
    drawScene(renderer, planes, camera, pivot, projected, appearance, "images");
    assert(JSON.stringify(read(140, 140)) === JSON.stringify(imagePixel) && renderer.layerTextures.get("purple") === texture, "returning to images changed original pixels or cache");
    assert(renderer.gl.getError() === renderer.gl.NO_ERROR, "GPU error in mode switch");
    return "GPU pixels: no image/highlight fill; captured alpha-margin boundaries; front/rear edge picking; missing/transparent geometry; cached texture and exact image restoration";
  } finally { disposeRenderer(renderer); canvas.remove(); green.width = green.height = purple.width = purple.height = screen.width = screen.height = 0; image.src = ""; }
}

async function verifyWireframeScope() {
  const host = document.createElement("div"); host.style.cssText = "width:500px;height:380px;position:relative"; document.body.append(host);
  const mounted = createRoot(host), scene = createRef<LayerSceneHandle>(), screen = pixels(300, 220, "#182029"), own = pixels(120, 100, "#d58e54", 20);
  const root = node("scope-root", 0, 0, 300, 220), folded = node("scope-folded", 30, 30, 120, 100), child = node("scope-child", 40, 50, 60, 40), invisible = node("scope-invisible", 10, 150, 200, 50);
  root.layerImageEmpty = true; root.attributes = { "tree-source": "debug-sdk" }; folded.layerImageEmpty = true; folded.children = [child];
  child.layerImageDataUrl = own.toDataURL(); child.layerImageSize = { width: 120, height: 100 }; invisible.visibleToUser = false; root.children = [folded, invisible];
  let displayMode: LayerDisplayMode = "images", hidden = new Set<string>(), showInvisible = false, requests = 0;
  const camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 }, source = screen.toDataURL(), expanded = new Set([root.id]);
  const captureGroup = async () => { requests++; return null; };
  const render = () => flushSync(() => mounted.render(<Layer3DPreview ref={scene} src={source} root={root} selectedNode={folded} expandedNodeIds={expanded}
    hiddenNodeIds={hidden} displayMode={displayMode} appearance={{ ...DEFAULT_LAYER_APPEARANCE, showInvisible }} size={{ width: 300, height: 220 }} origin={{ left: 80, top: 60 }} renderScale={1} camera={camera}
    onSelect={() => {}} onCaptureGroup={captureGroup} />));
  const canvas = () => host.querySelector<HTMLCanvasElement>("canvas")!;
  try {
    render(); await until(() => canvas()?.dataset.layerRenderer === "webgl" && canvas().dataset.layerTexturePendingCount === "0", "folded local texture did not settle");
    const requestsBefore = requests, identity = canvas().dataset.layerTextureBytes, count = host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerCount;
    displayMode = "wireframe"; render(); scene.current!.paintCamera(camera);
    assert(!host.querySelector('[data-layer-node-id="scope-child"]') && !host.querySelector('[data-layer-node-id="scope-invisible"]'), "wireframe expanded folded children or device invisible scope");
    assert(canvas().dataset.layerTextureBytes === identity && host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerCount === count && requests === requestsBefore, "wireframe changed folded scope, cache or capture demand");
    // Hidden empty parents change framing; consume an edge from the painted
    // wireframe instead of assuming that the captured origin is its center.
    const rect = canvas().getBoundingClientRect(), point = { x: Number(canvas().dataset.layerProbeX), y: Number(canvas().dataset.layerProbeY) };
    assert(Number.isFinite(point.x) && Number.isFinite(point.y), "folded wireframe has no painted edge probe");
    assert(scene.current!.pick(rect.left + point.x, rect.top + point.y) === folded && scene.current!.quickSelectAt(rect.left + point.x, rect.top + point.y).message?.includes("切回图片"), "folded wireframe pretended to contain child pixels");
    showInvisible = true; render(); assert(host.querySelector('[data-layer-node-id="scope-invisible"][data-layer-device-invisible="true"]'), "wireframe lost opt-in invisible boundary provenance");
    hidden = new Set([folded.id]); render(); assert(!host.querySelector('[data-layer-node-id="scope-folded"]'), "wireframe restored a hidden layer");
    return "Actual Layer3DPreview: folded parent remains one plane; local image cache and capture count preserved; device-invisible option, manual hiding and truthful internal selection hint";
  } finally { flushSync(() => mounted.unmount()); host.remove(); screen.width = screen.height = own.width = own.height = 0; }
}

export async function verifyCanvasRound4(native: Native) {
  const saved = localStorage.getItem(LAYER_APPEARANCE_STORAGE_KEY), oldApi = window.electronApi;
  let deviceRequests = 0; window.electronApi = new Proxy({} as typeof oldApi, { get: (_target, key) => () => { deviceRequests++; throw new Error(`Device access forbidden: ${String(key)}`); } });
  const host = document.createElement("div"); host.className = "app-shell inspection-active"; host.style.cssText = "width:100%;height:100vh;display:flex;flex-direction:column";
  host.innerHTML = '<div class="inspection-header"><div class="canvas-test-probes"></div><button class="canvas-test-outside" type="button">外部控件</button></div><div class="preview-pane" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>';
  document.body.append(host); const probes = host.querySelector<HTMLElement>(".canvas-test-probes")!, mount = host.querySelector<HTMLElement>(".preview-pane")!;
  const mounted = createRoot(mount), image = pixels(400, 320, "#182029");
  const a = node("canvas-A", 20, 40, 160, 80), b = node("canvas-B", 220, 150, 160, 100), ownA = pixels(160, 80, "#487ddd"), ownB = pixels(160, 100, "#d88b45");
  a.layerImageDataUrl = ownA.toDataURL(); a.layerImageSize = { width: 160, height: 80 }; b.layerImageDataUrl = ownB.toDataURL(); b.layerImageSize = { width: 160, height: 100 };
  let root = node("canvas-root", 0, 0, 400, 320); root.children = [a, b]; root.layerImageEmpty = true;
  let selected: UiNode = a, session = 1, suspended = false, modal = false; const source = image.toDataURL(), expanded = new Set([root.id]);
  function Probes() { const { publishHover, clearHover } = useNodeHoverActions(); return <>{[a, b].map(target => <button type="button" data-probe={target.id} key={target.id} onMouseEnter={() => publishHover(target.id, "tree")} onMouseLeave={() => clearHover("tree")}>{target.id}</button>)}</>; }
  const render = () => flushSync(() => mounted.render(<NodeHoverProvider root={root} sessionKey={session}>{createPortal(<Probes />, probes)}
    <ScreenshotPreview root={root} selectedNode={selected} src={source} sessionKey={session} expandedNodeIds={expanded} onSelect={value => { selected = value; render(); }}
      toolsSuspended={suspended} layerFocus={null} hiddenNodeIds={new Set()} doubleClickAction="toggle" onDoubleClick={() => {}} onLayerAction={() => {}} onOpenLayerMenu={() => {}} />
    {modal && <EntryDialog className="canvas-test-modal" labelledBy="canvas-test-modal-title" onClose={() => { modal = false; render(); }}><h2 id="canvas-test-modal-title">离线模态样例</h2><button type="button" onClick={() => { modal = false; render(); }}>关闭</button></EntryDialog>}
  </NodeHoverProvider>));
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => { const result = host.querySelector<T>(selector) ?? document.querySelector<T>(selector); assert(result, `missing ${selector}`); return result; };
  const input = async (events: NativeInput[]) => { await native.input(events); await settle(); };
  const click = async (selector: string) => { await settle(); get(selector).scrollIntoView({ block: "nearest", inline: "nearest" }); const rect = get(selector).getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2; await input([{ type: "mouseMove", x, y }, { type: "mouseDown", x, y, button: "left", clickCount: 1 }, { type: "mouseUp", x, y, button: "left", clickCount: 1 }]); };
  const key = (keyCode: string) => input([{ type: "keyDown", keyCode }, { type: "keyUp", keyCode }]);
  const chooseMode = async (value: LayerDisplayMode) => { flushSync(() => { const select = get<HTMLSelectElement>('[aria-label="3D 显示内容"]'); select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }); await settle(); };
  const toolCount = () => document.querySelectorAll("body > .canvas-tool-popup").length;
  const frame = () => get(".screenshot-frame"), camera = () => [frame().dataset.cameraPaintAzimuth, frame().dataset.cameraPaintElevation, frame().dataset.cameraPaintRoll].join("/");
  const pair = () => get(".measurement-card").dataset, values = () => get(".measurement-card-values").textContent;
  const checks: string[] = [];
  try {
    localStorage.setItem(LAYER_APPEARANCE_STORAGE_KEY, JSON.stringify({ ...DEFAULT_LAYER_APPEARANCE, showOutlines: false, highlightStrength: "strong" })); render();
    await until(() => get<HTMLImageElement>(".screenshot-stage img").naturalWidth > 0 && !get<HTMLButtonElement>(".view-mode-3d").disabled, "canvas image not ready");
    await click(".view-mode-3d"); await until(() => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")?.dataset.layerRenderer === "webgl" && host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")?.dataset.layerTexturePendingCount === "0", "real scene not ready");
    for (const selector of [".zoom-continuous-toggle", ".canvas-help > summary", ".layer-settings > summary"]) { await click(selector); assert(toolCount() === 1, "tools overlapped or did not open"); const rect = get(".canvas-tool-popup").getBoundingClientRect(); assert(rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= get(".inspection-header").getBoundingClientRect().bottom && rect.bottom <= innerHeight + 1, "popup clipped the window"); }
    const popup = get(".layer-settings-body"); flushSync(() => popup.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true }))); assert(toolCount() === 1, "internal portal click dismissed settings");
    flushSync(() => popup.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", isComposing: true }))); assert(toolCount() === 1, "IME dismissed settings");
    const before = camera(); await key("Escape"); assert(toolCount() === 0 && document.activeElement === get(".layer-settings > summary") && camera() === before, "Escape failed opener focus or changed camera");
    await click(".canvas-help > summary"); await click(".canvas-test-outside"); assert(toolCount() === 0 && document.activeElement === get(".canvas-test-outside"), "outside click stole focus or lost normal click");
    checks.push("Native tools: mutually exclusive portals, internal pointer/IME, window bounds, Escape opener focus and normal outside-click focus");

    await click(".view-mode-toggle button:first-child"); await click(".pin-layer-measurement"); flushSync(() => get('[data-probe="canvas-B"]').dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))); await settle(); await click(".measurement-pin");
    assert(pair().measurementMode === "fixed", "actual A/B did not pin"); const fixed = values();
    await click(".canvas-help > summary"); await key("Escape"); assert(pair().measurementMode === "fixed" && values() === fixed, "closing help cleared A/B");
    await click(".zoom-continuous-toggle"); const range = get<HTMLInputElement>(".zoom-continuous-popup input"), rangeRect = range.getBoundingClientRect();
    await input([{ type: "mouseMove", x: rangeRect.left + 10, y: rangeRect.top + rangeRect.height / 2 }, { type: "mouseDown", x: rangeRect.left + 10, y: rangeRect.top + rangeRect.height / 2, button: "left", clickCount: 1 },
      { type: "mouseMove", x: rangeRect.left + rangeRect.width * .22, y: rangeRect.top + rangeRect.height / 2, modifiers: ["leftButtonDown"] }, { type: "mouseUp", x: rangeRect.left + rangeRect.width * .22, y: rangeRect.top + rangeRect.height / 2, button: "left", clickCount: 1 }]);
    assert(toolCount() === 1 && !frame().dataset.gesture && values() === fixed, "slider drag dismissed tools, started a canvas gesture or changed A/B");
    flushSync(() => window.dispatchEvent(new Event("blur"))); await settle(); assert(toolCount() === 0 && pair().measurementMode === "fixed", "blur retained tools or cleared A/B");
    await click(".zoom-fit"); await click(".view-mode-3d"); await until(() => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")?.dataset.layerTexturePendingCount === "0", "mode texture queue unsettled");
    checks.push("Native slider drag and blur preserve fixed A/B; help Escape isolates the underlying measurement");

    await click(".canvas-help > summary"); suspended = true; render(); await settle(); assert(toolCount() === 0, "explicit modal suspension retained tool"); suspended = false; render();
    await click(".layer-settings > summary"); modal = true; render(); await settle(); assert(toolCount() === 0 && document.querySelector("dialog[open]"), "native modal did not close tool");
    await key("Escape"); assert(!document.querySelector("dialog[open]") && pair().measurementMode === "fixed" && values() === fixed, "Escape did not close only the native dialog or changed fixed A/B");
    checks.push("Explicit suspension and observed native dialog close tools; native Escape handles the top modal");

    await click(".layer-settings > summary"); const mode = get<HTMLSelectElement>('[aria-label="3D 显示内容"]'), gl = get<HTMLCanvasElement>(".layer-webgl-canvas").getContext("webgl")!, upload = gl.texImage2D;
    let uploads = 0; gl.texImage2D = ((...args: unknown[]) => { uploads++; Reflect.apply(upload, gl, args); }) as typeof upload;
    try {
      const identity = get<HTMLCanvasElement>(".layer-webgl-canvas").dataset.layerTextureBytes, oldCamera = camera(), selectedBefore = selected;
      mode.focus(); await chooseMode("wireframe"); assert(mode.value === "wireframe" && get(".layer-scene").dataset.layerDisplayMode === "wireframe", `controlled mode selection did not reach WebGL: ${mode.value}/${get(".layer-scene").dataset.layerDisplayMode}`);
      assert(get<HTMLInputElement>('[aria-label="显示普通轮廓"]').disabled && !get<HTMLInputElement>('[aria-label="显示普通轮廓"]').checked, "wireframe overwrote the saved outline preference");
      await native.checkpoint("wireframe-settings"); mode.focus(); await chooseMode("images");
      assert(String(mode.value) === "images" && !get<HTMLInputElement>('[aria-label="显示普通轮廓"]').checked && get<HTMLSelectElement>('[aria-label="选中强调强度"]').value === "strong", "image mode lost original appearance");
      assert(uploads === 0 && get<HTMLCanvasElement>(".layer-webgl-canvas").dataset.layerTextureBytes === identity && camera() === oldCamera && selected === selectedBefore && values() === fixed, "mode switch changed cache, camera, selection or fixed A/B");
      mode.focus(); await chooseMode("wireframe"); await key("Escape"); await native.checkpoint("wireframe-workbench");
      const stale = get(".layer-settings > summary"); await click(".canvas-help > summary"); root = { ...root, children: [...root.children] }; render(); await settle();
      assert(toolCount() === 0 && get(".layer-scene").dataset.layerDisplayMode === "images" && stale.isConnected, "new root retained old mode or tool body");
      await click(".layer-settings > summary"); get<HTMLSelectElement>('[aria-label="3D 显示内容"]').focus(); await chooseMode("wireframe"); session++; render(); await settle();
      assert(toolCount() === 0, "new session retained a tool body");
      await until(() => !get<HTMLButtonElement>(".view-mode-3d").disabled, "new session image not ready"); await click(".view-mode-3d");
      await until(() => Boolean(host.querySelector('.layer-scene[data-layer-display-mode="images"]')), "new session retained wireframe");
    } finally { gl.texImage2D = upload; }
    checks.push("Controlled image/wireframe select + native Escape restores saved appearance; no upload/camera/selection/A/B change; root and session reset");

    checks.push(await verifyWireframePixels(), await verifyWireframeScope());
    assert(deviceRequests === 0, "local interactions requested device data");
    return { checks, deviceRequests, cssViewport: { width: innerWidth, height: innerHeight }, devicePixelRatio, scope: "Actual React canvas/portals, native Electron input (controlled change for system selects in a hidden window) and actual WebGL pixel/pick checks on owned offline images; page zoom separate from physical DPI." };
  } catch (error) { await native.checkpoint("failure-before-cleanup"); throw error; }
  finally { flushSync(() => mounted.unmount()); host.remove(); window.electronApi = oldApi; if (saved === null) localStorage.removeItem(LAYER_APPEARANCE_STORAGE_KEY); else localStorage.setItem(LAYER_APPEARANCE_STORAGE_KEY, saved); image.width = image.height = ownA.width = ownA.height = ownB.width = ownB.height = 0; }
}
