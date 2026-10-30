import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { LayerFocus, UiNode } from "../shared/types";
import { DEFAULT_ORBIT_CAMERA } from "../shared/orbit-camera";
import { ScreenshotPreview } from "../src/components/ScreenshotPreview";
import { NodeHoverProvider } from "../src/features/inspection/NodeHoverContext";
import { DEFAULT_LAYER_APPEARANCE, LAYER_APPEARANCE_STORAGE_KEY } from "../src/features/layers/appearance";
import { makeNode } from "./fixtures";
import { chooseCanvasZoom } from "./zoom-controls-driver";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/workbench.css";
import "../src/styles/appearance.css";

type NativeInput = { type: string; x?: number; y?: number; button?: string; clickCount?: number; keyCode?: string; modifiers?: string[]; deltaY?: number; deltaX?: number; canScroll?: boolean };
type Native = { input: (events: NativeInput[]) => Promise<void>; checkpoint: (name: string) => Promise<void> };
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const nativeRaf = window.requestAnimationFrame.bind(window);
const tick = () => new Promise<void>(resolve => nativeRaf(() => resolve()));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
async function until(predicate: () => boolean, message: string) {
  const end = performance.now() + 6000;
  while (!predicate()) { assert(performance.now() < end, message); await tick(); }
}

// Hold browser frames without reaching into the component or its controller.
// Cancellation still obeys the browser contract, and released frames run once.
function holdFrames() {
  const previousRequest = window.requestAnimationFrame, previousCancel = window.cancelAnimationFrame;
  const waiting = new Map<number, FrameRequestCallback>(), cancelled: number[] = [];
  let serial = -1, restored = false;
  window.requestAnimationFrame = callback => { const id = serial--; waiting.set(id, callback); return id; };
  window.cancelAnimationFrame = id => {
    if (waiting.delete(id)) cancelled.push(id); else previousCancel.call(window, id);
  };
  return {
    waiting, cancelled,
    release() {
      if (restored) return;
      restored = true; window.requestAnimationFrame = previousRequest; window.cancelAnimationFrame = previousCancel;
      const callbacks = [...waiting.values()]; waiting.clear();
      for (const callback of callbacks) previousRequest.call(window, callback);
    },
  };
}

function fixture(background = "#182029") {
  const pixel = (width: number, height: number, color: string) => {
    const raster = document.createElement("canvas"); raster.width = width; raster.height = height;
    const context = raster.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, width, height); return raster.toDataURL();
  };
  const node = (id: string, left: number, top: number, width: number, height: number, color?: string): UiNode => ({
    ...makeNode(id), text: id, bounds: { left, top, right: left + width, bottom: top + height, raw: `[${left},${top}][${left + width},${top + height}]` },
    ...(color ? { layerImageDataUrl: pixel(width, height, color), layerImageSize: { width, height }, layerImageStatus: "captured" as const } : { layerImageEmpty: true }),
  });
  const root = node("controller-root", 0, 0, 400, 320), a = node("controller-A", 20, 40, 160, 80, "#487ddd"), b = node("controller-B", 220, 150, 160, 100, "#d88b45");
  root.attributes = { "tree-source": "debug-sdk" }; root.children = [a, b];
  return { root, a, b, src: pixel(400, 320, background) };
}

export async function verifyCanvasController(native: Native) {
  const savedAppearance = localStorage.getItem(LAYER_APPEARANCE_STORAGE_KEY), oldApi = window.electronApi;
  let deviceRequests = 0;
  window.electronApi = new Proxy({} as typeof oldApi, { get: (_target, key) => () => { deviceRequests++; throw new Error(`Device access forbidden: ${String(key)}`); } });
  localStorage.setItem(LAYER_APPEARANCE_STORAGE_KEY, JSON.stringify({ ...DEFAULT_LAYER_APPEARANCE, rotationMode: "free" }));
  const host = document.createElement("div"); host.className = "app-shell inspection-active";
  host.style.cssText = "width:100%;height:100vh;display:flex;flex-direction:column";
  host.innerHTML = '<div class="inspection-header">R5a 离线画布回归</div><div class="preview-pane" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>';
  document.body.append(host); const mount = host.querySelector<HTMLElement>(".preview-pane")!;
  let mounted = createRoot(mount), alive = true, data = fixture(), root = data.root, selected = data.a, session = 1, layerFocus: LayerFocus | null = null;
  const expanded = new Set([root.id]), hidden = new Set<string>();
  let selections = 0, doubles = 0, menus = 0, held: ReturnType<typeof holdFrames> | null = null;
  const select = (node: UiNode) => { selected = node; selections++; render(); };
  const render = () => flushSync(() => mounted.render(<NodeHoverProvider root={root} sessionKey={session}>
    <ScreenshotPreview root={root} src={data.src} selectedNode={selected} sessionKey={session} expandedNodeIds={expanded} hiddenNodeIds={hidden}
      layerFocus={layerFocus} doubleClickAction="toggle" onSelect={select} onDoubleClick={() => { doubles++; }} onOpenLayerMenu={() => { menus++; }}
      onLayerAction={action => { if (action === "exit-focus") { layerFocus = null; render(); } }} />
  </NodeHoverProvider>));
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => { const result = host.querySelector<T>(selector) ?? document.querySelector<T>(selector); assert(result, `missing ${selector}`); return result; };
  const frame = () => get(".screenshot-frame"), canvas = () => get<HTMLCanvasElement>(".layer-webgl-canvas");
  const camera = () => {
    const dataset = frame().dataset;
    return [dataset.cameraPaintAzimuth, dataset.cameraPaintElevation, dataset.cameraPaintRoll, dataset.cameraPaintDistance, dataset.cameraPaintLayerGap,
      get(".screenshot-stage").style.getPropertyValue("--layer-live-pan")].join("/");
  };
  const click = async (selector: string) => { flushSync(() => get(selector).click()); await settle(); };
  const release = () => { held?.release(); held = null; };
  const ready = async () => {
    await until(() => host.querySelector<HTMLButtonElement>(".view-mode-3d")?.disabled === false, "image not ready");
    if (!host.querySelector(".layer-webgl-canvas")) await click(".view-mode-3d");
    await until(() => canvas().dataset.layerRenderer === "webgl" && canvas().dataset.layerTexturePendingCount === "0", "scene not ready"); await settle();
  };
  const fresh = async () => {
    release(); if (alive) flushSync(() => mounted.unmount());
    mounted = createRoot(mount); alive = true; data = fixture(); root = data.root; selected = data.a; layerFocus = null; session++;
    localStorage.setItem(LAYER_APPEARANCE_STORAGE_KEY, JSON.stringify({ ...DEFAULT_LAYER_APPEARANCE, rotationMode: "free" })); render(); await ready();
  };
  const startDrag = async (move = true) => {
    const rect = frame().getBoundingClientRect(), start = { x: rect.left + Math.min(90, rect.width / 4), y: rect.top + Math.min(90, rect.height / 4) };
    let pointerId = -1;
    frame().addEventListener("pointerdown", event => { pointerId = event.pointerId; }, { once: true });
    await native.input([{ type: "mouseMove", ...start }, { type: "mouseDown", ...start, button: "left", clickCount: 1 }]);
    assert(pointerId >= 0 && frame().hasPointerCapture(pointerId), "native pointer did not acquire real capture");
    const before = camera(); held = holdFrames();
    if (move) {
      await native.input([{ type: "mouseMove", x: start.x + 34, y: start.y + 22, modifiers: ["leftButtonDown"] }]);
      assert(frame().dataset.gesture === "rotate" && held.waiting.size > 0, "drag did not queue a camera frame");
      assert(camera() === before, "held camera frame painted before release");
    }
    return { pointerId, start, before, selections };
  };
  const mouseUp = (point: { x: number; y: number }) => native.input([{ type: "mouseUp", ...point, button: "left", clickCount: 1 }]);
  const checks: { name: string; passed: boolean; error?: string }[] = [];
  const observations: Record<string, unknown> = {};
  const check = async (name: string, run: () => Promise<void>) => {
    try { await fresh(); await run(); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: String(error) }); await native.checkpoint(`${name}-failure`); }
    finally { release(); await mouseUp({ x: 2, y: 2 }); await settle(); }
  };
  try {
    await check("fixed-scene", async () => {
      await until(() => !frame().dataset.modeMotion && getComputedStyle(get(".layer-scene")).opacity === "1", "fixed scene reveal did not reach full opacity");
      await tick(); await tick();
      const rect = (element: Element) => { const value = element.getBoundingClientRect(); return { left: value.left, top: value.top, width: value.width, height: value.height }; };
      observations.baseline = { camera: camera(), opacity: getComputedStyle(get(".layer-scene")).opacity, frame: rect(frame()), stage: rect(get(".screenshot-stage")), scene: { ...get(".layer-scene").dataset },
        canvas: { ...canvas().dataset }, planes: [...host.querySelectorAll<HTMLElement>("[data-layer-node-id]")].map(element => ({ ...element.dataset })) };
      await native.checkpoint("fixed-scene");
      assert(get(".layer-scene").dataset.layerCount === "2", "fixed scene no longer contains exactly two captured layers");
    });
    for (const ending of ["pointercancel", "lostpointercapture", "blur"] as const) await check(`native-${ending}-pending-frame`, async () => {
      const drag = await startDrag();
      if (ending === "pointercancel") flushSync(() => frame().dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: drag.pointerId, isPrimary: true })));
      else if (ending === "lostpointercapture") { frame().releasePointerCapture(drag.pointerId); await native.input([{ type: "mouseMove", x: drag.start.x + 34, y: drag.start.y + 22, modifiers: ["leftButtonDown"] }]); }
      else flushSync(() => window.dispatchEvent(new Event("blur")));
      assert(!frame().dataset.gesture && !frame().classList.contains("is-3d-dragging") && !frame().hasPointerCapture(drag.pointerId), `${ending} retained gesture or pointer capture`);
      assert(camera() !== drag.before && held!.cancelled.length > 0, `${ending} failed to commit pending drag and cancel its frame`);
      const ended = camera(); await native.input([{ type: "mouseMove", x: drag.start.x + 80, y: drag.start.y + 55, modifiers: ["leftButtonDown"] }]);
      await mouseUp({ x: drag.start.x + 80, y: drag.start.y + 55 }); release(); await settle();
      assert(camera() === ended && selections === drag.selections && !frame().dataset.gesture, `${ending} allowed old input/frame to alter the view or selection`);
    });
    await check("same-session-root-replacement", async () => {
      const drag = await startDrag(); root = { ...root, children: root.children.map(node => ({ ...node })) }; selected = root.children[0]; render();
      assert(!frame().dataset.gesture && !frame().hasPointerCapture(drag.pointerId), "root replacement kept the old gesture");
      const replaced = camera(); await mouseUp({ x: drag.start.x + 34, y: drag.start.y + 22 }); release(); await settle();
      assert(camera() === replaced && selections === drag.selections, "old gesture selected a node or changed the replacement view");
    });
    await check("new-session-pending-frame", async () => {
      const drag = await startDrag(), oldFrame = frame(), queued = [...held!.waiting.keys()];
      data = fixture(); root = data.root; selected = data.a; session++; render();
      assert(!oldFrame.isConnected && queued.every(id => !held!.waiting.has(id)), "new session retained an old scheduled frame");
      release(); await ready(); const nextCamera = camera();
      await mouseUp({ x: drag.start.x + 34, y: drag.start.y + 22 }); await settle();
      assert(camera() === nextCamera && !frame().dataset.gesture, "old release changed the new session camera");
      assert(selections === drag.selections, "old release selected a node in the new session");
    });
    await check("unmount-pending-frame", async () => {
      const drag = await startDrag(), oldFrame = frame(), queued = [...held!.waiting.keys()];
      flushSync(() => mounted.unmount()); alive = false;
      assert(queued.length > 0 && queued.every(id => !held!.waiting.has(id)), "unmount retained scheduled work");
      observations.unmount = { captureReleased: !oldFrame.hasPointerCapture(drag.pointerId), gestureCleared: !oldFrame.dataset.gesture,
        draggingClassCleared: !oldFrame.classList.contains("is-3d-dragging"), cancelledFrames: queued.length };
      assert(!oldFrame.hasPointerCapture(drag.pointerId), "unmount retained native pointer capture");
      // Synchronous cleanup may clear a gesture. Only work arriving after the
      // completed unmount must leave the detached view and selection untouched.
      const oldDataset = JSON.stringify({ ...oldFrame.dataset });
      release(); await mouseUp({ x: drag.start.x + 34, y: drag.start.y + 22 }); await settle();
      assert(JSON.stringify({ ...oldFrame.dataset }) === oldDataset && selections === drag.selections, "unmounted view received a frame or selection callback");
    });
    for (const replacement of ["root", "source"] as const) await check(`reset-${replacement}-replacement`, async () => {
      frame().focus(); await native.input([{ type: "keyDown", keyCode: "Right" }, { type: "keyUp", keyCode: "Right" }]);
      held = holdFrames(); await native.input([{ type: "keyDown", keyCode: "Home" }, { type: "keyUp", keyCode: "Home" }]);
      assert(Number(frame().dataset.cameraMotionProgress) < 1 && held.waiting.size > 0, "reset did not queue a frame");
      const painted = Number(frame().dataset.cameraPaintAzimuth);
      if (replacement === "root") { root = { ...root }; render(); }
      else { data = { ...data, src: fixture("#1b2731").src }; render(); }
      assert(Math.abs(Number(frame().dataset.cameraPaintAzimuth) - painted) < .01, "context replacement jumped away from the painted camera frame");
      assert(get('[data-layer-preset="stacked"]').getAttribute("aria-pressed") === "false", "controls retained the reset target after context interruption");
      release(); for (let i = 0; i < 20; i++) await tick();
      assert(Math.abs(Number(frame().dataset.cameraPaintAzimuth) - painted) < .01 && get('[data-layer-preset="stacked"]').getAttribute("aria-pressed") === "false", "late reset or state effect overwrote the interrupted view");
    });
    for (const replacement of ["root", "source"] as const) await check(`focus-return-${replacement}-replacement`, async () => {
      await click(".view-mode-toggle button:first-child"); chooseCanvasZoom(host, 4); await settle();
      frame().scrollTo({ left: 110, top: 140 }); await settle();
      const saved = { left: frame().scrollLeft, top: frame().scrollTop, camera: camera(), zoom: get(".zoom-readout").textContent };
      assert(saved.left > 0 && saved.top > 0, "focus-return fixture was not scrollable");
      layerFocus = { kind: "branch", node: root }; render(); await ready();
      assert(frame().scrollLeft === 0 && frame().scrollTop === 0, "focus did not reset scroll");
      held = holdFrames(); layerFocus = null; render();
      assert(held.waiting.size > 0, "focus exit did not defer scroll restoration");
      if (replacement === "root") { root = { ...root }; render(); }
      else { data = { ...data, src: fixture("#1b2731").src }; render(); }
      release(); await settle();
      assert(Math.abs(frame().scrollLeft - saved.left) < 1 && Math.abs(frame().scrollTop - saved.top) < 1,
        `same-session ${replacement} replacement lost pending focus return: ${JSON.stringify({ saved, left: frame().scrollLeft, top: frame().scrollTop })}`);
      assert(camera() === saved.camera && get(".zoom-readout").textContent === saved.zoom && get(".view-mode-3d").getAttribute("aria-pressed") === "false",
        "focus return changed the previous flat view, zoom or camera");
    });
    await check("focus-reentry-pending-scroll", async () => {
      await click(".view-mode-toggle button:first-child"); chooseCanvasZoom(host, 4); await settle();
      frame().scrollTo({ left: 110, top: 140 }); await settle();
      assert(frame().scrollLeft > 0 && frame().scrollTop > 0, "flat focus-return fixture was not scrollable");
      layerFocus = { kind: "branch", node: root }; render(); await ready();
      held = holdFrames(); layerFocus = null; render();
      assert(held.waiting.size > 0, "focus exit did not defer scroll restoration");
      layerFocus = { kind: "branch", node: data.b }; render();
      assert(held.cancelled.length > 0, "new focus failed to cancel queued scroll restoration");
      release(); await ready(); await settle();
      assert(frame().scrollLeft === 0 && frame().scrollTop === 0 && get(".view-mode-3d").getAttribute("aria-pressed") === "true"
        && get(".layer-scene").dataset.layerFocusedId === data.b.id && get(".zoom-readout").textContent === "100%", "old focus-return frame overwrote the newly focused view");
    });
    await check("reduced-motion-pending-reset", async () => {
      const previousMatchMedia = window.matchMedia, preference = new EventTarget(); let reduced = false;
      const media = Object.assign(preference, { media: "(prefers-reduced-motion: reduce)", onchange: null }) as unknown as MediaQueryList;
      Object.defineProperty(media, "matches", { get: () => reduced });
      window.matchMedia = query => query.includes("prefers-reduced-motion") ? media : previousMatchMedia.call(window, query);
      try {
        await fresh(); frame().focus();
        await native.input([{ type: "keyDown", keyCode: "Right" }, { type: "keyUp", keyCode: "Right" }]);
        held = holdFrames(); await native.input([{ type: "keyDown", keyCode: "Home" }, { type: "keyUp", keyCode: "Home" }]);
        assert(Number(frame().dataset.cameraMotionProgress) < 1 && held.waiting.size > 0, "reset did not queue animation");
        flushSync(() => { reduced = true; preference.dispatchEvent(new Event("change")); });
        assert(Number(frame().dataset.cameraPaintAzimuth) === DEFAULT_ORBIT_CAMERA.azimuth && frame().dataset.cameraMotionProgress === "1", "reduced motion did not finish queued reset");
        const stopped = camera(); release(); await settle(); assert(camera() === stopped, "old reset frame overwrote reduced-motion destination");
      } finally { window.matchMedia = previousMatchMedia; }
    });
    await check("pending-wheel-root-replacement", async () => {
      await click(".view-mode-toggle button:first-child"); chooseCanvasZoom(host, 8); await settle();
      frame().scrollTo({ left: 220, top: 180 }); await settle();
      const bounds = frame().getBoundingClientRect(), point = { x: bounds.left + bounds.width * .35, y: bounds.top + bounds.height * .35 };
      const sourcePoint = () => { const image = get<HTMLImageElement>(".screenshot-stage img").getBoundingClientRect();
        return { x: (point.x - image.left) * 400 / image.width, y: (point.y - image.top) * 320 / image.height }; };
      const before = sourcePoint(), zoom = get(".zoom-readout").textContent;
      held = holdFrames();
      await native.input([{ type: "mouseMove", ...point }, { type: "mouseWheel", ...point, deltaX: 0, deltaY: -60, canScroll: true, modifiers: ["control"] }]);
      assert(held.waiting.size > 0 && get(".zoom-readout").textContent === zoom, "wheel did not defer its zoom frame");
      root = { ...root }; render(); release(); await settle(); const after = sourcePoint();
      observations.pendingWheel = { before, after };
      assert(get(".zoom-readout").textContent !== zoom, "same-session root replacement discarded pending zoom");
      assert(Math.abs(before.x - after.x) < 1 && Math.abs(before.y - after.y) < 1,
        `same-session root replacement discarded the wheel anchor: ${JSON.stringify({ before, after })}`);
    });
    await check("native-wheel-current-viewport", async () => {
      const occluder = document.createElement("aside"); occluder.className = "floating-inspector";
      const area = frame().getBoundingClientRect();
      occluder.style.cssText = `position:fixed;right:0;top:${area.top}px;width:${Math.min(240, area.width * .3)}px;height:${area.height}px;background:#17202a;pointer-events:none`;
      const image = () => get<HTMLImageElement>(".screenshot-stage img");
      const sourcePoint = (point: { x: number; y: number }) => {
        const bounds = image().getBoundingClientRect(); return { x: (point.x - bounds.left) * 400 / bounds.width, y: (point.y - bounds.top) * 320 / bounds.height };
      };
      const wheel = async (point: { x: number; y: number }) => {
        const before = get(".zoom-readout").textContent;
        await native.input([{ type: "mouseMove", ...point }, { type: "mouseWheel", ...point, deltaX: 0, deltaY: -60, canScroll: true, modifiers: ["control"] }]); await settle();
        assert(get(".zoom-readout").textContent !== before, "native wheel failed to change zoom");
      };
      try {
        await click(".view-mode-toggle button:first-child");
        chooseCanvasZoom(host, 8); await settle();
        const viewportWidth = frame().dataset.viewportWidth;
        frame().parentElement!.append(occluder);
        await until(() => frame().dataset.viewportWidth !== viewportWidth, "floating panel did not change the observed viewport"); await settle();
        const center = () => { const bounds = frame().getBoundingClientRect(); return { x: bounds.left + Number(frame().dataset.viewportLeft) + Number(frame().dataset.viewportWidth) / 2,
          y: bounds.top + Number(frame().dataset.viewportTop) + Number(frame().dataset.viewportHeight) / 2 }; };
        const point = center(), before = sourcePoint(point); await wheel(point); const after = sourcePoint(point);
        assert(Math.abs(before.x - after.x) < 1 && Math.abs(before.y - after.y) < 1, "wheel drifted from the current 2D source-pixel anchor after viewport change");
        const beforeMode = camera(); await click(".view-mode-3d"); await ready(); await wheel(center());
        assert(camera() === beforeMode && !frame().dataset.gesture, "3D wheel changed orbit/pan or started a gesture");
        await click(".view-mode-toggle button:first-child"); occluder.remove(); await settle();
        const returnedPoint = center(), returnedBefore = sourcePoint(returnedPoint); await wheel(returnedPoint); const returnedAfter = sourcePoint(returnedPoint);
        assert(Math.abs(returnedBefore.x - returnedAfter.x) < 1 && Math.abs(returnedBefore.y - returnedAfter.y) < 1,
          `wheel reused an old anchor after 3D/2D return and panel removal: ${JSON.stringify({ returnedBefore, returnedAfter, image: image().getBoundingClientRect().toJSON(), frame: frame().getBoundingClientRect().toJSON(), zoom: get(".zoom-readout").textContent })}`);
      } finally { occluder.remove(); }
    });
    assert(deviceRequests === 0 && doubles === 0 && menus === 0, "fixture performed an unrelated action");
    return { passed: checks.every(check => check.passed), checks, observations, deviceRequests,
      source: "Real ScreenshotPreview, Electron mouse/key input and pointer capture; queued browser frames held externally; pointercancel and blur dispatched because native cancellation has no Electron sendInputEvent equivalent." };
  } finally {
    release(); if (alive) flushSync(() => mounted.unmount()); host.remove(); window.electronApi = oldApi;
    if (savedAppearance === null) localStorage.removeItem(LAYER_APPEARANCE_STORAGE_KEY); else localStorage.setItem(LAYER_APPEARANCE_STORAGE_KEY, savedAppearance);
  }
}
Object.assign(window, { verifyCanvasController });
