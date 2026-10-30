import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { makeNode } from "./fixtures";
import type { UiNode } from "../shared/types";
import { ScreenshotPreview } from "../src/components/ScreenshotPreview";
import { createRenderer, disposeRenderer, drawScene, uploadLayerTexture, uploadTexture } from "../src/features/layers/webgl-renderer";
import { cameraRotation, pickProjectedPlane, projectPoint } from "../src/features/layers/projection";
import { alphaMaskContains } from "../src/features/layers/texture-alpha";
import type { LayerCamera, ProjectedPlane, ScenePlane } from "../src/features/layers/types";
import { DEFAULT_LAYER_APPEARANCE, LAYER_APPEARANCE_STORAGE_KEY } from "../src/features/layers/appearance";

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(`Transparent layers: ${message}`); }
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 6000;
  while (!predicate()) { check(performance.now() < deadline, message); await tick(); }
}
function bitmap(size: number, color: string, hole = false) {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!; ctx.fillStyle = color; ctx.fillRect(0, 0, size, size);
  if (hole) ctx.clearRect(size * .2, size * .2, size * .6, size * .6);
  return canvas;
}

async function verifyAlphaUploads() {
  const canvas = document.createElement("canvas"); canvas.style.width = "560px"; canvas.style.height = "420px"; document.body.append(canvas);
  const renderer = createRenderer(canvas); check(renderer, "WebGL unavailable");
  const backImage = bitmap(64, "#0000ff"), frontImage = bitmap(1024, "#ff0000", true);
  const camera: LayerCamera = { distance: 1100, azimuth: 36, elevation: -19, roll: 13, panX: 0, panY: 0, layerGap: 64 };
  const pivot = { x: 250, y: 200, z: 0 }, projected = { current: [] as ProjectedPlane[] };
  const plane = (id: string): ScenePlane => ({ id, node: makeNode(id), rect: { left: 100, top: 50, width: 300, height: 300 },
    source: { left: 0, top: 0, width: 1024, height: 1024 }, textureSize: { width: 1024, height: 1024 }, textureSrc: id,
    kind: "native", z: 0, opacity: 1, hitTestable: true, hitPolicy: "content", outlinePolicy: "normal" });
  const back = plane("alpha-back"), front = plane("alpha-front"), scene = [back, front];
  const pixel = (x: number, y: number) => {
    drawScene(renderer, scene, camera, pivot, projected);
    const p = projectPoint(x, y, 0, pivot, camera, cameraRotation(camera)), gl = renderer.gl, rgba = new Uint8Array(4);
    gl.readPixels(Math.floor(p.x * canvas.width / canvas.clientWidth), canvas.height - 1 - Math.floor(p.y * canvas.height / canvas.clientHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    return { rgba, picked: pickProjectedPlane(p, projected.current)?.node?.id };
  };
  try {
    const screenshot = new Image(); screenshot.src = backImage.toDataURL(); await screenshot.decode(); check(uploadTexture(renderer, screenshot), "base upload failed");
    check(uploadLayerTexture(renderer, back.id, backImage, 1_000_000), "back upload failed");
    const uploaded = uploadLayerTexture(renderer, front.id, frontImage, 600_000); check(uploaded && uploaded.scan, "large texture did not use sliced scan");
    check(!renderer.layerAlphaMasks.has(front.id), "partial alpha mask was published");
    const content = await uploaded.scan(); check(content.mask && content.rect, "sliced mask missing");
    check(content.mask.width < 1024 && content.mask.width * content.mask.height <= 600_000, "mask did not follow downsampled GPU texture");
    renderer.layerAlphaMasks.set(front.id, content.mask); renderer.layerContentRects.set(front.id, content.rect); renderer.sourcePlanes = null;
    check(!alphaMaskContains(content.mask, .5, .5) && alphaMaskContains(content.mask, .1, .5), "sliced texture lost hole/edge alpha");
    const hole = pixel(250, 200), edge = pixel(125, 200);
    check(hole.rgba[2] > 240 && hole.rgba[0] < 10 && hole.picked === back.id, "GPU hole and hit testing disagree");
    check(edge.rgba[0] > 240 && edge.rgba[2] < 10 && edge.picked === front.id, "opaque frame and hit testing disagree");
    const semi = bitmap(64, "rgba(255,0,0,.25)");
    check(uploadLayerTexture(renderer, front.id, semi, 4096), "semi-transparent replacement failed");
    const overlay = pixel(250, 200); check(overlay.picked === front.id && overlay.rgba[0] > 50 && overlay.rgba[2] > 170, "semi-transparent overlay was skipped");
    const empty = bitmap(64, "transparent"); check(uploadLayerTexture(renderer, front.id, empty, 4096), "empty upload failed");
    check(pixel(250, 200).picked === back.id, "empty texture intercepted actual pixels");
    // Compare the actual rendered border, not only the assigned style value.
    const only = [front], measureBorder = (structureMode: "regular" | "complete") => {
      drawScene(renderer, only, camera, pivot, projected, { ...DEFAULT_LAYER_APPEARANCE, showEmpty: true, structureMode });
      const rgba = new Uint8Array(canvas.width * canvas.height * 4), gl = renderer.gl;
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      let total = 0; for (let i = 3; i < rgba.length; i += 4) total += rgba[i]; return total;
    };
    const quiet = measureBorder("regular"), complete = measureBorder("complete");
    check(quiet > 0 && quiet < complete * .5, "empty outlines were not visually quieter");
    const ctx = semi.getContext("2d")!, read = ctx.getImageData;
    ctx.getImageData = () => { throw new Error("fixture read failure"); };
    check(uploadLayerTexture(renderer, front.id, semi, 4096), "read failure discarded valid GPU texture"); ctx.getImageData = read;
    check(!renderer.layerAlphaMasks.has(front.id) && !renderer.layerContentRects.has(front.id) && pixel(250, 200).picked === front.id, "failed scan was misclassified as empty");
    semi.width = semi.height = empty.width = empty.height = 0;
    return ["transparent picking: real GPU pixels and perspective picking agree for an interior hole, downsampled sliced scans and semi-transparent overlays; scan failures remain unknown; empty outlines dim"];
  } finally {
    disposeRenderer(renderer); check(renderer.layerAlphaMasks.size === 0, "renderer retained alpha masks");
    backImage.width = backImage.height = frontImage.width = frontImage.height = 0; canvas.remove();
  }
}

async function verifyPositionSelector() {
  const savedAppearance = localStorage.getItem(LAYER_APPEARANCE_STORAGE_KEY);
  const host = document.createElement("div"); host.className = "app-shell inspection-active";
  Object.assign(host.style, { width: "900px", height: "650px", position: "relative" }); document.body.append(host);
  const mounted = createRoot(host), background = bitmap(320, "#2255cc"), ring = bitmap(240, "#cc5522", true);
  const node = (id: string, from: number, to: number, image?: HTMLCanvasElement): UiNode => ({ ...makeNode(id), text: id,
    bounds: { left: from, top: from, right: to, bottom: to, raw: `[${from},${from}][${to},${to}]` },
    ...(image ? { layerImageDataUrl: image.toDataURL(), layerImageSize: { width: image.width, height: image.height } } : { layerImageEmpty: true }), children: [] });
  const back = node("visible-button", 0, 320, background), front = node("transparent-frame", 40, 280, ring), empty = node("clickable-container", 20, 300);
  const root = node("page", 0, 320); root.children = [back, front, empty];
  const before = JSON.stringify(root), expanded = new Set([root.id]);
  let hidden: ReadonlySet<string> = new Set(), session = 1, selected: UiNode | null = null, navigations = 0;
  const navigate = (target: UiNode, source: UiNode) => { check(source === root, "wrong navigation source"); selected = target; navigations++; render(); return true; };
  const render = () => flushSync(() => mounted.render(<div className="preview-pane"><ScreenshotPreview sessionKey={session} root={root} src={background.toDataURL()}
    expandedNodeIds={expanded} hiddenNodeIds={hidden} selectedNode={selected} onSelect={n => { selected = n; }} onNavigateNode={navigate} layerFocus={null} doubleClickAction="toggle" onDoubleClick={() => {}} onLayerAction={() => {}} onOpenLayerMenu={() => {}} /></div>));
  const click = (selector: string) => { const target = host.querySelector<HTMLElement>(selector); check(target, `missing ${selector}`); flushSync(() => target.click()); };
  const canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!, panel = () => host.querySelector<HTMLElement>(".quick-select-panel");
  const ready = () => until(() => canvas()?.dataset.layerRenderer === "webgl" && canvas().dataset.layerTexturePendingCount === "0" && canvas().dataset.layerAnimationProgress === "1", "selector scene not ready");
  const gesture = (x: number, y: number) => {
    const frame = host.querySelector<HTMLElement>(".screenshot-frame")!, capture = frame.setPointerCapture; frame.setPointerCapture = () => {};
    const rect = canvas().getBoundingClientRect();
    try { for (const type of ["pointerdown", "pointerup"]) flushSync(() => canvas().dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0,
      pointerId: 92, isPrimary: true, pointerType: "mouse", clientX: rect.left + x, clientY: rect.top + y }))); } finally { frame.setPointerCapture = capture; }
  };
  try {
    localStorage.removeItem(LAYER_APPEARANCE_STORAGE_KEY);
    render(); await until(() => Boolean(host.querySelector<HTMLButtonElement>(".view-mode-3d") && !host.querySelector<HTMLButtonElement>(".view-mode-3d")!.disabled), "preview decode");
    click(".view-mode-3d"); await ready();
    check(!host.querySelector('[data-layer-node-id="clickable-container"]'), "empty container was visible by default");
    const toggleEmpty = () => {
      click(".layer-settings summary");
      const input = document.querySelector<HTMLInputElement>('.layer-settings-body [aria-label="显示空图层"]'); check(input, "empty-layer setting missing");
      flushSync(() => input.click()); click(".layer-settings summary");
    };
    toggleEmpty(); await ready();
    let target: { x: number; y: number } | null = null;
    const rect = canvas().getBoundingClientRect();
    search: for (let y = 60; y < rect.height - 20; y += 18) for (let x = 40; x < rect.width - 20; x += 18) {
      if (panel()) click(".quick-select-close"); click(".quick-select-tool");
      check(panel()?.dataset.selectionScope === "position", "toolbar did not default to layers at position");
      if (panel()?.contains(document.elementFromPoint(rect.left + x, rect.top + y))) continue;
      gesture(x, y);
      if (host.querySelector('[data-quick-select-id="transparent-frame"] [data-layer-kind="transparent"]')
        && host.querySelector('[data-quick-select-id="clickable-container"] [data-layer-kind="structure"]')) { target = { x, y }; break search; }
    }
    check(target, "transparent position could not be inspected");
    check(host.querySelector(".quick-select-candidate")?.getAttribute("data-quick-select-id") === back.id, "painted control was not first");
    const container = host.querySelector<HTMLButtonElement>('[data-quick-select-id="clickable-container"]')!;
    // A hidden Electron test window updates activeElement without native focus events.
    flushSync(() => { container.focus(); container.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    check(host.querySelector<SVGElement>('.layer-quick-select-outline[data-quick-select-node-id="clickable-container"]')?.style.visibility === "visible" && Number(navigations) === 0, `hover/focus did not preview empty container without selecting: ${JSON.stringify({ outline: host.querySelector(".layer-quick-select-outline")?.outerHTML, active: document.activeElement?.getAttribute("data-quick-select-id"), navigations, panel: panel()?.dataset })}`);
    toggleEmpty(); await ready();
    check(!panel() && !host.querySelector('[data-layer-node-id="clickable-container"]'), "hiding empty layers retained old candidates or geometry");
    flushSync(() => container.click()); check(Number(navigations) === 0, "stale empty candidate navigated after hiding");
    toggleEmpty(); await ready(); click(".quick-select-tool"); gesture(target.x, target.y);
    click('[data-quick-select-id="clickable-container"]'); check(Boolean(selected === empty) && Number(navigations) === 1 && !panel(), "empty container confirmation did not navigate");
    click(".quick-select-tool"); gesture(target.x, target.y);
    flushSync(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })));
    check(!panel(), "Escape retained position list");
    click(".quick-select-tool"); gesture(target.x, target.y); const stale = host.querySelector<HTMLButtonElement>('[data-quick-select-id="clickable-container"]')!;
    session++; render(); check(!panel(), "new snapshot retained candidates"); flushSync(() => stale.click()); check(Number(navigations) === 1, "stale candidate navigated");
    await until(() => Boolean(host.querySelector<HTMLButtonElement>(".view-mode-3d") && !host.querySelector<HTMLButtonElement>(".view-mode-3d")!.disabled), "new snapshot decode");
    if (!canvas()) click(".view-mode-3d"); await ready(); hidden = new Set([empty.id]); render(); await ready(); click(".quick-select-tool"); gesture(target.x, target.y);
    check(!host.querySelector('[data-quick-select-id="clickable-container"]'), "manually hidden node was reintroduced");
    click(".quick-select-close"); selected = null; gesture(target.x, target.y); check(selected === back, "ordinary click did not pass through hole");
    check(JSON.stringify(root) === before, "selection changed captured hierarchy");
    return ["position selector: toolbar default, pixel-first candidates including transparent clickable containers, hover boundary, navigation, Escape, stale snapshot rejection and manual hiding; ordinary clicks pass through holes"];
  } finally {
    flushSync(() => mounted.unmount()); host.remove(); background.width = background.height = ring.width = ring.height = 0;
    if (savedAppearance === null) localStorage.removeItem(LAYER_APPEARANCE_STORAGE_KEY); else localStorage.setItem(LAYER_APPEARANCE_STORAGE_KEY, savedAppearance);
  }
}

export async function verifyTransparentLayers() { return [...await verifyAlphaUploads(), ...await verifyPositionSelector()]; }
