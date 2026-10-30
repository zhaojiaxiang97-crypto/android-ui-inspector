import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Layer3DPreview } from "../src/features/layers/Layer3DPreview";
import { DEFAULT_LAYER_APPEARANCE } from "../src/features/layers/appearance";
import type { LayerFramingScope } from "../src/features/layers/framing";
import { cameraRotation, projectPoint } from "../src/features/layers/projection";
import type { LayerSceneHandle } from "../src/features/layers/types";
import type { UiNode } from "../shared/types";
import { makeNode } from "./fixtures";

export async function verifyOffscreenLayers() {
  const host = document.createElement("div"); host.style.cssText = "width:480px;height:320px;position:relative"; document.body.append(host);
  const mounted = createRoot(host), scene = createRef<LayerSceneHandle>();
  const check = (value: unknown, message: string) => { if (!value) throw new Error(`Offscreen layers: ${message}`); };
  const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const until = async (fn: () => boolean, message: string) => {
    const deadline = performance.now() + 7000;
    while (!fn()) { check(performance.now() < deadline, message); await tick(); }
  };
  function node(id: string, left: number, top: number, right: number, bottom: number, color?: string): UiNode {
    const n = { ...makeNode(id), bounds: { left, top, right, bottom, raw: "fixture" }, attributes: { "tree-source": "debug-sdk", "inspection-source": "debug-hybrid", "clip-children": "true" } };
    if (color) {
      const bitmap = document.createElement("canvas"); bitmap.width = right - left; bitmap.height = bottom - top;
      const context = bitmap.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, bitmap.width, bitmap.height);
      n.layerImageDataUrl = bitmap.toDataURL(); n.layerImageSize = { width: bitmap.width, height: bitmap.height };
    }
    return n;
  }
  const root = node("offscreen-root", 0, 0, 200, 200, "#666666");
  root.attributes = { ...root.attributes, "clip-to-outline": "true", "sdk-outlineLeft": "0", "sdk-outlineTop": "0", "sdk-outlineRight": "200", "sdk-outlineBottom": "200", "sdk-outlineRadius": "0" };
  const left = node("left", -160, 40, -20, 160, "#ff0000"), right = node("right", 240, 40, 380, 160, "#00ff00");
  left.layerCapturePlacement = { screen: { left: 0, top: 40, width: 0, height: 120 }, source: { left: 160, top: 0, width: 0, height: 120 }, hidden: true, opacity: 1 };
  const partial = node("partial", 60, 160, 200, 300, "#0000ff"), missing = node("missing", 220, 0, 240, 20);
  const hidden = { ...node("hidden", -140, 0, -100, 20, "#ffff00"), visibleToUser: false };
  root.children = [left, right, partial, missing, hidden];
  const before = JSON.stringify(root), size = { width: 200, height: 200 };
  const camera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
  let showOffscreen = false, expanded: ReadonlySet<string> = new Set([root.id]), manuallyHidden: ReadonlySet<string> = new Set();
  let focusedNode: UiNode | null = null, scale = .7, nextScale = scale, fits = 0;
  let framingScope: LayerFramingScope = "screen";
  const fit = (value: number) => { nextScale = value; fits++; };
  const origin = () => ({ left: 240 - size.width * scale / 2, top: 160 - size.height * scale / 2 });
  const render = () => flushSync(() => mounted.render(<Layer3DPreview ref={scene} src={root.layerImageDataUrl!} root={root}
    selectedNode={null} expandedNodeIds={expanded} hiddenNodeIds={manuallyHidden} focusedNode={focusedNode} focusKind="branch" size={size}
    origin={origin()} renderScale={scale} camera={camera} appearance={{ ...DEFAULT_LAYER_APPEARANCE, showOffscreen }} framingScope={framingScope} onSelect={() => {}} onFitScale={fit} />));
  const canvas = () => host.querySelector<HTMLCanvasElement>("canvas")!;
  const record = (id: string) => host.querySelector<HTMLElement>(`[data-layer-node-id="${id}"]`);
  const settled = () => until(() => canvas()?.dataset.layerRenderer === "webgl" && canvas().dataset.layerTexturePendingCount === "0"
    && canvas().dataset.layerAnimationProgress === "1", "scene did not settle");
  const applyFit = async () => { await tick(); scale = nextScale; render(); await settled(); };
  const point = (n: UiNode, x: number, y: number) => {
    const data = host.querySelector<HTMLElement>(".layer-scene")!.dataset;
    const center = focusedNode ? { x: -90, y: 100 } : showOffscreen && framingScope === "all" && expanded.size ? { x: 110, y: 150 } : { x: 100, y: 100 };
    const pivot = { x: Number(data.layerPivotX), y: Number(data.layerPivotY), z: Number(data.layerPivotZ) };
    const p = projectPoint(origin().left + (100 - center.x + x) * scale, origin().top + (100 - center.y + y) * scale,
      Number(record(n.id)?.dataset.layerZ ?? 0) * scale, pivot, { ...camera, distance: Number(canvas().dataset.layerCameraDistance) }, cameraRotation(camera));
    const rect = canvas().getBoundingClientRect(); return { x: rect.left + p.x, y: rect.top + p.y };
  };
  const pixel = (p: { x: number; y: number }) => {
    scene.current!.paintCamera(camera);
    const c = canvas(), rect = c.getBoundingClientRect(), gl = c.getContext("webgl")!, rgba = new Uint8Array(4);
    gl.readPixels(Math.floor((p.x - rect.left) * c.width / rect.width), c.height - 1 - Math.floor((p.y - rect.top) * c.height / rect.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    return rgba;
  };
  try {
    render(); await settled(); await applyFit();
    check(!record(left.id) && !record(right.id) && !record(missing.id), "default view exposed screen-external nodes");
    const previousFits = fits, previousScale = scale;
    showOffscreen = true; render(); await settled();
    check(fits === previousFits && scale === previousScale, "enabling offscreen content auto-fitted the entire scene");
    const currentPixel = pixel(point(partial, 120, 180));
    check(currentPixel[2] > 220, "current page moved when offscreen content was enabled");
    framingScope = "all"; render(); await settled(); await applyFit();
    check(fits === previousFits + 1 && scale < .8, "explicit overview did not fit the complete layout");
    check(record(left.id) && record(right.id) && record(partial.id) && !record(hidden.id), "full layout lost layers or exposed an actually hidden control");
    check(record(missing.id)?.dataset.layerTexture === "false", "missing image was replaced with screenshot pixels");
    for (const [n, x, y, channel] of [[left, -90, 100, 0], [right, 310, 100, 1], [partial, 120, 260, 2]] as const) {
      const p = point(n, x, y), rgba = pixel(p);
      check(rgba[channel] > 220 && rgba[(channel + 1) % 3] < 20 && rgba[3] > 220, `${n.id} pixels remained screen/ancestor clipped`);
      check(scene.current!.pick(p.x, p.y) === n, `${n.id} could not be selected after fitting`);
    }
    camera.panX = 19; camera.panY = -11; render(); await settled();
    const moved = point(right, 310, 100);
    check(scene.current!.pick(moved.x, moved.y) === right, "panned offscreen layer could not be selected");
    camera.panX = camera.panY = 0; focusedNode = left; showOffscreen = false; render(); await settled(); await applyFit();
    check(host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerFocusedId === left.id, "branch focus lost the offscreen root");
    check(pixel(point(left, -90, 100))[0] > 220, "focused offscreen bitmap disappeared");
    check(!record(right.id) && !record(partial.id), "focus retained unrelated pages");
    focusedNode = null; showOffscreen = true; manuallyHidden = new Set([right.id]); render(); await settled();
    check(!record(right.id), "option restored a manually hidden layer");
    manuallyHidden = new Set(); expanded = new Set(); render(); await settled(); await applyFit();
    check(host.querySelector<HTMLElement>(".layer-scene")!.dataset.layerRootComposite === "true", "root did not fold");
    const interior = pixel(point(root, 20, 100));
    check(Math.abs(interior[0] - 102) < 3 && Math.abs(interior[1] - 102) < 3, "folding leaked the left adjacent page into the screen");
    const below = pixel(point(root, 120, 260)); check(below[3] === 0, "folded page leaked content past the screen edge");
    expanded = new Set([root.id]); showOffscreen = false; framingScope = "screen"; render(); await settled(); await applyFit();
    check(!record(left.id) && !record(right.id), "switching off retained offscreen geometry");
    check(JSON.stringify(root) === before, "inspection mutated the snapshot");
    return ["offscreen layers: stable current-page framing, explicit full overview, full negative/right/bottom pixels, picking/panning/focus without global exposure, missing-image outlines and actual/manual visibility",
      "offscreen layers: folded pages retain native clipping; mode is reversible without changing the snapshot"];
  } finally { flushSync(() => mounted.unmount()); host.remove(); }
}
