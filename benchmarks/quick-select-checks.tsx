import { resetCanvasView } from "./zoom-controls-driver";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { LayerFocus, UiNode } from "../shared/types";
import { ScreenshotPreview } from "../src/components/ScreenshotPreview";
import { Layer3DPreview } from "../src/features/layers/Layer3DPreview";
import type { LayerCamera, LayerSceneHandle } from "../src/features/layers/types";
import { filterQuickSelectResult, findQuickSelectCandidates, type QuickSelectCandidate, type QuickSelectResult } from "../src/features/layers/quick-select";
import { QuickSelectPanel } from "../src/features/layers/QuickSelectPanel";
import { makeNode } from "./fixtures";

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(`Quick select: ${message}`); }
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 5000;
  while (!predicate()) { check(performance.now() < deadline, message); await tick(); }
}
function image(w: number, h: number, color: string, trim = false) {
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!; ctx.fillStyle = color;
  if (trim) ctx.fillRect(40, 25, w - 80, h - 50); else ctx.fillRect(0, 0, w, h);
  return canvas.toDataURL("image/png");
}
function fixture(paging = false, trim = false) {
  const node = (id: string, label: string, l: number, t: number, r: number, b: number, color: string): UiNode => ({
    ...makeNode(id), text: label, className: "android.widget.TextView", bounds: { left: l, top: t, right: r, bottom: b, raw: `[${l},${t}][${r},${b}]` },
    layerImageDataUrl: image(r - l, b - t, color, trim), layerImageSize: { width: r - l, height: b - t },
  });
  const root = node("quick-root", "快速选择根", 0, 0, 400, 320, "#162030"); root.layerImageEmpty = true;
  const branch = node("folded-branch", "折叠业务容器", 60, 40, 360, 280, "#224938"); branch.className = "android.widget.FrameLayout";
  const container = node("inner-container", "内部信息容器", 100, 80, 280, 220, "#275e46"); container.className = "android.widget.LinearLayout";
  const text = node("inner-text", "深层标题文字", 140, 120, 220, 160, "#db9453"); container.children = [text]; branch.children = [container];
  if (paging) for (let i = 0; i < 71; i++) branch.children.push(node(`overlap-${i}`, `重叠候选 ${i}`, 130, 110, 240, 180, "#224938"));
  const other = node("other-control", "另一控件", 10, 280, 80, 315, "#486caa"); root.children = [branch, other];
  return { root, branch, text, other, src: image(400, 320, "#162030") };
}

async function verifyPaintedQuickSelection() {
  const host = document.createElement("div"); Object.assign(host.style, { width: "680px", height: "450px", position: "relative" }); document.body.append(host);
  const mounted = createRoot(host), scene = createRef<LayerSceneHandle>(), original = fixture(), sourceBefore = JSON.stringify(original.root);
  let root = original.root, expanded: ReadonlySet<string> = new Set([root.id]), hidden: ReadonlySet<string> = new Set(), session = 1;
  const camera: LayerCamera = { distance: 1100, azimuth: 37, elevation: -17, roll: 12, panX: 14, panY: -9, layerGap: 96 };
  const render = () => flushSync(() => mounted.render(<Layer3DPreview ref={scene} sessionKey={session} src={original.src} root={root} selectedNode={root.children[0]}
    expandedNodeIds={expanded} hiddenNodeIds={hidden} size={{ width: 400, height: 320 }} renderScale={.84} origin={{ left: 90, top: 40 }} camera={camera} onSelect={() => { throw new Error("Preview selected a control"); }} />));
  const canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
  const point = (x: number, y: number, id = root.children[0].id) => {
    const record = host.querySelector<HTMLElement>(`[data-layer-node-id="${id}"]`)!, metadata = host.querySelector<HTMLElement>(".layer-scene")!;
    const pivot = { x: Number(metadata.dataset.layerPivotX), y: Number(metadata.dataset.layerPivotY), z: Number(metadata.dataset.layerPivotZ) };
    const yaw = -camera.azimuth * Math.PI / 180, pitch = -camera.elevation * Math.PI / 180, roll = -camera.roll * Math.PI / 180;
    // The confirmed-empty root is omitted by default. Frame the two remaining
    // content bounds; their descendants stay inside these same bounds.
    const visible = root.children.filter(child => !hidden.has(child.id)).map(child => child.bounds!);
    const centerX = (Math.min(...visible.map(b => b.left)) + Math.max(...visible.map(b => b.right))) / 2;
    const centerY = (Math.min(...visible.map(b => b.top)) + Math.max(...visible.map(b => b.bottom))) / 2;
    const cx = (x - centerX) * .84, cy = (centerY - y) * .84, cz = Number(record.dataset.layerZ) * .84 - pivot.z;
    const ry = Math.cos(pitch) * cy - Math.sin(pitch) * cz, rz = Math.sin(pitch) * cy + Math.cos(pitch) * cz;
    const rx = Math.cos(yaw) * cx + Math.sin(yaw) * rz, dz = -Math.sin(yaw) * cx + Math.cos(yaw) * rz;
    const r = canvas().getBoundingClientRect(), distance = Number(canvas().dataset.layerCameraDistance), perspective = distance / (distance - dz);
    return { x: r.left + pivot.x + (Math.cos(roll) * rx - Math.sin(roll) * ry) * perspective,
      y: r.top + pivot.y - (Math.sin(roll) * rx + Math.cos(roll) * ry) * perspective };
  };
  let result!: QuickSelectResult;
  const query = () => { const p = point(180.25, 140.75); return scene.current!.quickSelectAt(p.x, p.y); };
  try {
    render(); await until(() => canvas()?.dataset.layerRenderer === "webgl" && Number(canvas().dataset.layerTextureCount) >= 2 && canvas().dataset.layerTexturePendingCount === "0", "folded WebGL textures did not load");
    result = query(); check(result.status === "ready" && result.branch === original.branch && result.candidates[0].node === original.text, `rotated painted plane mapped incorrectly: ${result.status} ${result.message}`);
    check(Math.abs(result.point!.x - 180.25) < .06 && Math.abs(result.point!.y - 140.75) < .06, "source coordinates changed after yaw/pitch/roll/pan or page zoom");
    const otherPoint = point(45, 297, original.other.id);
    flushSync(() => scene.current!.hover(otherPoint.x, otherPoint.y));
    flushSync(() => { check(scene.current!.toggleMeasurementPin(), "measurement setup could not be pinned"); });
    await until(() => Boolean(host.querySelector<HTMLElement>(".layer-measurement-status[data-measure-pinned='true']")), "pinned measurement did not render");
    const measureBefore = host.querySelector<HTMLElement>(".layer-measurement-status")!.dataset.measureAnchor + ":" + host.querySelector<HTMLElement>(".layer-measurement-status")!.dataset.measureTarget;
    const gl = canvas().getContext("webgl")!, upload = gl.texImage2D, renderVersion = canvas().dataset.layerRenderVersion; let uploads = 0;
    gl.texImage2D = ((...args: unknown[]) => { uploads++; Reflect.apply(upload, gl, args); }) as WebGLRenderingContext["texImage2D"];
    try {
      flushSync(() => scene.current!.previewQuickSelect(result, result.candidates[0]));
      check(host.querySelector<SVGElement>('[data-quick-select-node-id="inner-text"]')?.style.visibility === "visible", "candidate hover did not draw its source rectangle");
      check(Number(getComputedStyle(host.querySelector(".layer-quick-select-outline")!).zIndex) > Number(getComputedStyle(canvas()).zIndex), "candidate outline was painted behind the GPU canvas");
      await tick(); check(uploads === 0 && canvas().dataset.layerRenderVersion === renderVersion && JSON.stringify(original.root) === sourceBefore, "candidate hover painted GPU textures, expanded or modified the tree");
      const measure = host.querySelector<HTMLElement>(".layer-measurement-status")!;
      check(measure.dataset.measurePinned === "true" && `${measure.dataset.measureAnchor}:${measure.dataset.measureTarget}` === measureBefore, "candidate preview changed the pinned measurement pair");
      flushSync(() => scene.current!.previewQuickSelect(null, null));
      check(host.querySelector<SVGElement>(".layer-quick-select-outline")?.style.visibility === "hidden", "cancel retained a candidate outline");
    } finally { gl.texImage2D = upload; }

    expanded = new Set([root.id, original.branch.id, original.branch.children[0].id]); render();
    await until(() => canvas().dataset.layerAnimationProgress === "1" && canvas().dataset.layerTexturePendingCount === "0", "expanded child motion did not settle");
    const childPoint = point(180.25, 140.75, original.text.id);
    check(scene.current!.pick(childPoint.x, childPoint.y) === original.text, "expanded child was not actually pickable before folding");
    expanded = new Set([root.id]); render();
    check(Number(canvas().dataset.layerRetiringCount) > 0 && Number(canvas().dataset.layerAnimationProgress) < 1, "folding test did not retain a painted outgoing child");
    check(scene.current!.pick(childPoint.x, childPoint.y) !== original.text, "retiring child remained normally pickable");
    const during = scene.current!.quickSelectAt(childPoint.x, childPoint.y);
    check(!during.branch || during.branch === original.branch, "quick select queried a retiring child plane");
    await until(() => canvas().dataset.layerAnimationProgress === "1", "folded parent motion did not settle");

    const trimmed = fixture(false, true); root = trimmed.root; render();
    await until(() => Number(canvas().dataset.layerTrimmedCount) > 0 && Number(canvas().dataset.layerTextureCount) >= 2, "trimmed composites did not settle");
    result = query(); check(result.status === "ready" && Math.abs(result.point!.x - 180.25) < .06 && Math.abs(result.point!.y - 140.75) < .06, "alpha trimming shifted the source coordinate map");
    const old = result; session++; render();
    check(scene.current!.quickSelectPage(old, 0).status === "stale", "same-object new session accepted old candidates");
    flushSync(() => scene.current!.previewQuickSelect(old, old.candidates[0]));
    check(host.querySelector<SVGElement>(".layer-quick-select-outline")?.style.visibility === "hidden", "old session preview returned");
    const empty = fixture(); for (const n of [empty.branch, empty.branch.children[0], empty.text]) { delete n.layerImageDataUrl; delete n.layerImageSize; }
    root = empty.root; render(); await tick();
    check(query().status === "no-plane", "missing folded pixels intercepted an empty interior");
    const missingEdge = point(61, 140);
    check(scene.current!.quickSelectAt(missingEdge.x, missingEdge.y).status === "missing-image", "missing folded outline lost its image explanation");
    const hiddenPoint = point(180.25, 140.75); hidden = new Set([root.children[0].id]); render();
    check(scene.current!.quickSelectAt(hiddenPoint.x, hiddenPoint.y).status === "no-plane", "hidden folded branch could be queried");
    return ["actual WebGL: painted yaw/pitch/roll/pan source coordinates, alpha-trim mapping and page zoom", "candidate SVG preview leaves tree, GPU uploads and pinned measurements untouched; retiring planes, missing/hidden pixels and reused-session callbacks rejected"];
  } finally { flushSync(() => mounted.unmount()); host.remove(); }
}

async function verifyQuickSelectControls() {
  const host = document.createElement("div"); host.className = "app-shell inspection-active"; Object.assign(host.style, { width: "760px", height: "620px", position: "relative" }); document.body.append(host);
  const mounted = createRoot(host), initial = fixture(true), sourceBefore = JSON.stringify(initial.root);
  let root = initial.root, expanded: ReadonlySet<string> = new Set([root.id]), session = 1, blocked = false, focus: LayerFocus | null = null;
  let selected: UiNode | null = initial.branch, navigations = 0, ordinarySelections = 0, doubles = 0, menus = 0;
  const navigate = (target: UiNode, sourceRoot: UiNode) => {
    check(sourceRoot === root, "navigation used a different root"); navigations++; selected = target;
    expanded = new Set([root.id, initial.branch.id, "inner-container"]); renderStable(); return true;
  };
  // Keep presentation inputs stable; unrelated renders must not fabricate a new
  // visibility revision in this component-only fixture.
  const hidden: ReadonlySet<string> = new Set();
  const renderStable = () => flushSync(() => mounted.render(<div className="preview-pane"><ScreenshotPreview sessionKey={session} src={initial.src} root={root} selectedNode={selected}
    expandedNodeIds={expanded} onSelect={() => { ordinarySelections++; }} onNavigateNode={navigate} navigationDisabled={blocked}
    layerFocus={focus} hiddenNodeIds={hidden} doubleClickAction="toggle" onDoubleClick={() => { doubles++; }} onLayerAction={() => {}} onOpenLayerMenu={() => { menus++; }} /></div>));
  const click = (selector: string) => { const el = host.querySelector<HTMLElement>(selector); check(el, `missing ${selector}`); flushSync(() => el.click()); };
  const frame = () => host.querySelector<HTMLElement>(".screenshot-frame")!, canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
  const panel = () => host.querySelector<HTMLElement>(".quick-select-panel");
  const open = async () => {
    await until(() => Boolean(host.querySelector<HTMLButtonElement>(".view-mode-3d") && !host.querySelector<HTMLButtonElement>(".view-mode-3d")!.disabled), "3D view control unavailable after image decode");
    if (!canvas()) click(".view-mode-3d");
    await until(() => canvas()?.dataset.layerRenderer === "webgl" && Number(canvas().dataset.layerTextureCount) >= 1 && canvas().dataset.layerTexturePendingCount === "0", "ScreenshotPreview folded scene unavailable").catch(error => {
      throw new Error(`${error.message}: ${JSON.stringify({ frame: frame()?.getBoundingClientRect().toJSON(), canvas: canvas()?.getBoundingClientRect().toJSON(), data: canvas()?.dataset, scene: host.querySelector<HTMLElement>(".layer-scene")?.dataset, active: host.querySelector(".view-mode-toggle .active")?.textContent })}`);
    });
    click(".quick-select-tool"); check(panel(), "tool did not open its instruction panel"); click('[data-select-mode="inside"]');
  };
  const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
  const syntheticPointerGesture = (action: () => void) => {
    // Synthetic PointerEvents do not register a native pointer-capture ID.
    const currentFrame = frame(), capture = currentFrame.setPointerCapture;
    currentFrame.setPointerCapture = () => {};
    try { action(); } finally { currentFrame.setPointerCapture = capture; }
  };
  const pointSelect = (x: number, y: number, keys: MouseEventInit = {}) => {
    const target = canvas(), rect = target.getBoundingClientRect();
    const px = rect.left + x, py = rect.top + y;
    syntheticPointerGesture(() => flushSync(() => { target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 71, button: 0, clientX: px, clientY: py, pointerType: "mouse", isPrimary: true, ...keys }));
      // Releasing the modifier before the button must still finish this click.
      target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 71, button: 0, clientX: px, clientY: py, pointerType: "mouse", isPrimary: true })); }));
  };
  const findCandidates = async () => {
    // Normal candidate checks need the folded plane to finish replacing its
    // outgoing children. The separate middle-frame check below keeps testing
    // selection during motion without snapping the animation.
    await until(() => canvas().dataset.layerAnimationProgress === "1" && canvas().dataset.layerTexturePendingCount === "0", "candidate search fold did not settle");
    // Real GPU-pick probes, without assuming a flattened screen coordinate.
    const rect = canvas().getBoundingClientRect();
    for (let y = 40; y < rect.height - 20; y += 20) for (let x = 30; x < rect.width - 20; x += 20) {
      // Each probe starts from the tool's initial panel position. A previous
      // miss now anchors the panel beside that click and can cover the next
      // grid point, even though the real intended target remains pickable.
      if (panel()) click(".quick-select-close");
      click(".quick-select-tool"); click('[data-select-mode="inside"]');
      if (panel()?.contains(document.elementFromPoint(rect.left + x, rect.top + y))) continue;
      pointSelect(x, y);
      if (host.querySelector('[data-quick-select-id="inner-text"]')) return { x, y };
    }
    throw new Error(`Quick select: collapsed text could not be reached through real pointer gestures: ${JSON.stringify({ panel: panel()?.textContent, panelRect: panel()?.getBoundingClientRect().toJSON(), frame: frame().getBoundingClientRect().toJSON(), canvas: canvas().getBoundingClientRect().toJSON(), canvasData: canvas().dataset, scene: host.querySelector<HTMLElement>(".layer-scene")?.dataset, quick: host.querySelector(".quick-select-tool")?.getAttribute("aria-pressed"), active: host.querySelector(".view-mode-toggle .active")?.textContent })}`);
  };
  try {
    renderStable(); await until(() => Boolean(host.querySelector<HTMLImageElement>("img")?.naturalWidth), "preview image did not load");
    await open(); const shortcutPoint = await findCandidates();
    check(host.querySelectorAll(".quick-select-candidate").length === 30 && panel()!.textContent!.includes("73 个匹配"), "candidate count/page bound was lost");
    check(ordinarySelections === 0 && doubles === 0 && expanded.size === 1, "opening candidates selected, expanded or double-clicked a plane");
    click(".quick-select-close");
    pointSelect(shortcutPoint.x, shortcutPoint.y, modifier);
    check(panel() && host.querySelector('[data-quick-select-id="inner-text"]') && ordinarySelections === 0 && expanded.size === 1,
      "modifier click required the tool, selected a plane or failed after modifier release");
    flushSync(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })));
    check(!panel() && canvas(), "modifier selection Escape left 3D");
    pointSelect(shortcutPoint.x, shortcutPoint.y, { ...modifier, shiftKey: true });
    check(!panel() && ordinarySelections === 0, "modified pan opened candidates");
    if (/Mac/.test(navigator.platform)) {
      pointSelect(shortcutPoint.x, shortcutPoint.y, { ctrlKey: true });
      check(menus === 1 && !panel(), "Mac control-click lost its context menu");
    }
    const c = canvas(), r = c.getBoundingClientRect(), oldYaw = frame().dataset.cameraPaintAzimuth;
    syntheticPointerGesture(() => flushSync(() => {
      for (const [type, dx] of [["pointerdown", 0], ["pointermove", 24], ["pointerup", 24]] as const) {
        c.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 74, button: 0, isPrimary: true,
          clientX: r.left + shortcutPoint.x + dx, clientY: r.top + shortcutPoint.y, ...modifier }));
      }
    }));
    check(!panel() && frame().dataset.cameraPaintAzimuth !== oldYaw, "modifier drag opened candidates or blocked orbit");
    resetCanvasView(host); await until(() => !frame().hasAttribute("data-camera-motion-progress") || frame().dataset.cameraMotionProgress === "1", "reset after modifier drag");
    await open(); await findCandidates();
    const yaw = frame().dataset.cameraPaintAzimuth;
    flushSync(() => host.querySelector<HTMLButtonElement>(".quick-select-candidate")!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })));
    check(frame().dataset.cameraPaintAzimuth === yaw && document.activeElement?.classList.contains("quick-select-candidate"), "candidate keyboard navigation rotated the camera");
    click(".quick-select-pages button:last-child"); check(host.querySelectorAll(".quick-select-candidate").length === 30 && panel()!.textContent!.includes("2 / 3"), "next page did not expose the remaining candidates");
    click(".quick-select-pages button:first-child");
    for (const width of [760, 300, 248]) {
      host.style.width = `${width}px`; await tick(); await tick(); const p = panel()!.getBoundingClientRect(), f = frame().getBoundingClientRect();
      check(p.left >= f.left - 1 && p.right <= f.right + 1 && panel()!.scrollWidth <= panel()!.clientWidth + 1, `candidate panel overflowed ${width}px`);
      const pager = host.querySelector<HTMLElement>(".quick-select-pages")!.getBoundingClientRect();
      check(pager.bottom <= p.bottom + 1 && pager.top >= p.top, `candidate pager was clipped at ${width}px`);
    }
    host.style.width = "760px"; await tick(); await tick();
    const checkpoint = (window as typeof window & { quickSelectVisualCheckpoint?: () => Promise<void> }).quickSelectVisualCheckpoint;
    if (checkpoint) await checkpoint();
    click('[data-quick-select-id="inner-text"]'); check(navigations === 1 && selected?.id === "inner-text" && !panel(), "confirmation did not use workspace navigation and close");
    check(JSON.stringify(initial.root) === sourceBefore, "quick selection changed captured source data");
    expanded = new Set([root.id]); renderStable(); await open(); await findCandidates();
    const escapedView = host.querySelector<HTMLElement>(".view-mode-toggle .active")?.textContent;
    flushSync(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    check(!panel() && host.querySelector<HTMLElement>(".view-mode-toggle .active")?.textContent === escapedView && document.activeElement?.classList.contains("quick-select-tool"), "Escape changed the view or failed to restore tool focus");
    await open(); await findCandidates(); blocked = true; renderStable();
    check(!panel() && host.querySelector<HTMLButtonElement>(".quick-select-tool")!.disabled, "refresh/busy state retained an actionable candidate list");
    pointSelect(shortcutPoint.x, shortcutPoint.y, modifier); check(!panel(), "busy state accepted modifier selection");
    blocked = false; expanded = new Set([root.id, initial.branch.id, "inner-container"]); renderStable();
    await until(() => canvas().dataset.layerAnimationProgress === "1" && canvas().dataset.layerTexturePendingCount === "0", "expanded tool scene did not settle");
    expanded = new Set([root.id]); renderStable();
    check(Number(canvas().dataset.layerRetiringCount) > 0 && Number(canvas().dataset.layerAnimationProgress) < 1, "tool animation fixture did not retain a painted middle frame");
    click(".quick-select-tool"); click('[data-select-mode="inside"]'); const beforePointer = Number(canvas().dataset.layerAnimationProgress), actualCanvas = canvas(), rect = actualCanvas.getBoundingClientRect();
    const px = rect.left + Number(actualCanvas.dataset.layerProbeX), py = rect.top + Number(actualCanvas.dataset.layerProbeY);
    syntheticPointerGesture(() => {
      flushSync(() => actualCanvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 72, button: 0, clientX: px, clientY: py, pointerType: "mouse", isPrimary: true })));
      check(Number(canvas().dataset.layerAnimationProgress) < 1 && Number(canvas().dataset.layerAnimationProgress) - beforePointer < .1 && Number(canvas().dataset.layerRetiringCount) > 0,
        `quick-select pointerdown snapped the painted middle frame to its destination: ${JSON.stringify({ beforePointer, afterPointer: canvas().dataset.layerAnimationProgress, retiring: canvas().dataset.layerRetiringCount, active: host.querySelector(".quick-select-tool")?.getAttribute("aria-pressed"), px, py })}`);
      flushSync(() => actualCanvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 72, button: 0, clientX: px, clientY: py, pointerType: "mouse", isPrimary: true })));
    });
    click(".quick-select-close"); await until(() => canvas().dataset.layerAnimationProgress === "1", "tool frame motion did not finish");
    await open(); flushSync(() => window.dispatchEvent(new Event("blur"))); check(!panel(), "window blur retained quick-select state");
    await open(); await findCandidates(); const oldButton = host.querySelector<HTMLButtonElement>('[data-quick-select-id="inner-text"]')!;
    session++; renderStable(); flushSync(() => oldButton.click()); check(!panel() && navigations === 1, "same-object new session accepted an old candidate button");
    focus = { node: initial.branch, kind: "layer" }; renderStable();
    await until(() => !host.querySelector<HTMLButtonElement>(".view-mode-3d")!.disabled, "isolated image did not decode"); click(".view-mode-3d");
    check(host.querySelector<HTMLButtonElement>(".quick-select-tool")!.disabled, "single-plane isolation permitted out-of-focus descendants");
    pointSelect(shortcutPoint.x, shortcutPoint.y, modifier); check(!panel(), "modifier selection escaped single-plane focus");
    root = structuredClone(root); session++; focus = null; renderStable(); check(!panel(), "same-ID replacement root leaked candidate UI");
    return ["actual ScreenshotPreview: explicit tool → painted fold → 30-candidate paging → workspace navigation; ordinary selection/double-click unchanged",
      "modifier click: direct candidates, release before mouse-up, Mac context menu, pan/orbit and busy/isolation guards",
      "candidate keyboard/hover, 760/300/248px panel/pager bounds, painted middle-frame pointerdown, Esc view/focus preservation, busy/blur/new session/isolation cleanup"];
  } finally { flushSync(() => mounted.unmount()); host.remove(); }
}

export async function verifyQuickSelect() {
  try { return [...await verifyPaintedQuickSelection(), ...await verifyQuickSelectControls(), ...await verifyQuickSelectDiscovery()]; }
  catch (error) { throw new Error(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)); }
}

export async function verifyQuickSelectDiscovery() {
  const host = document.createElement("div"); Object.assign(host.style, { width: "760px", height: "620px", position: "relative" }); document.body.append(host);
  const mounted = createRoot(host), initial = fixture(true);
  initial.branch.children.at(-1)!.resourceId = "app:id/deep_target";
  const source = JSON.stringify(initial.root);
  let result = findQuickSelectCandidates({ context: {}, root: initial.root, branch: initial.branch, point: { x: 180, y: 140 }, hidden: new Set() });
  let width = 760, closed = false, confirmed = 0, preview: QuickSelectCandidate | null = null;
  const previews: string[] = [];
  const render = () => flushSync(() => mounted.render(closed ? null : <QuickSelectPanel result={result}
    viewport={{ left: 0, top: 0, width, height: 620 }} anchor={{ x: 380, y: 150 }}
    onPreview={candidate => { preview = candidate; previews.push(`${candidate?.node.id ?? "clear"}:${document.activeElement?.className}`); }} onConfirm={() => { confirmed++; }}
    onFilter={query => { result = filterQuickSelectResult(result, query); render(); }}
    onPage={page => { result = filterQuickSelectResult(result, result.query, page); render(); }} onClose={() => { closed = true; render(); }} />));
  const input = () => host.querySelector<HTMLInputElement>(".quick-select-filter")!;
  const type = (value: string) => flushSync(() => {
    input().focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  try {
    render(); await tick();
    check(host.textContent!.includes("当前分支") && host.textContent!.includes("按布局边界匹配") && host.textContent!.includes("本页 1–30"), "branch/bounds/page explanation missing");
    type("deep_target");
    check(result.total === 73 && result.filteredTotal === 1 && host.querySelectorAll(".quick-select-candidate").length === 1, "filter searched only current page or hid total");
    check(document.activeElement === input() && preview === null && confirmed === 0, "filter stole focus, changed preview or confirmed a control");
    check(host.querySelector(".quick-select-resource")?.textContent === "app:id/deep_target" && Boolean(host.querySelector(".quick-select-path em")), "resource or relative branch position absent");
    flushSync(() => input().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" })));
    // Hidden Electron runners can update activeElement without emitting focusin.
    // Deliver the same focus event a foreground keyboard interaction receives.
    if (!document.hasFocus()) flushSync(() => document.activeElement?.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    check(document.activeElement?.classList.contains("quick-select-candidate") && preview !== null && confirmed === 0,
      `ArrowDown did not preview the filtered candidate: ${JSON.stringify({ active: document.activeElement?.className, preview: (preview as QuickSelectCandidate | null)?.node.id, confirmed, previews })}`);
    type("no matches"); check(host.querySelector(".quick-select-empty") && Number(result.filteredTotal) === 0 && result.total === 73, "empty filter lost honest count/message");
    type(""); check(Number(result.filteredTotal) === 73 && result.page === 0, "clearing filter failed to restore all candidates");
    flushSync(() => host.querySelector<HTMLButtonElement>(".quick-select-pages button:last-child")!.click());
    check(Number(result.page) === 1 && host.textContent!.includes("本页 31–60"), "page range not updated");
    for (width of [760, 300, 248]) {
      host.style.width = `${width}px`; render(); await tick();
      const panel = host.querySelector<HTMLElement>(".quick-select-panel")!, p = panel.getBoundingClientRect(), r = host.getBoundingClientRect();
      check(p.left >= r.left && p.right <= r.right + 1 && p.top >= r.top && p.bottom <= r.bottom + 1 && panel.scrollWidth <= panel.clientWidth + 1, `filtered panel overflow at ${width}`);
      if (width === 760) check(p.right < r.left + 380 || p.left > r.left + 380, `panel covers the click point despite free side space: ${JSON.stringify({ panel: p.toJSON(), host: r.toJSON() })}`);
      const pager = host.querySelector<HTMLElement>(".quick-select-pages")!.getBoundingClientRect();
      check(pager.bottom <= p.bottom + 1, `filtered pager clipped at ${width}`);
    }
    width = 760; host.style.width = "760px"; type("deep_target"); await tick(); await tick();
    const checkpoint = (window as typeof window & { quickSelectDiscoveryVisualCheckpoint?: () => Promise<void> }).quickSelectDiscoveryVisualCheckpoint;
    if (checkpoint) await checkpoint();
    flushSync(() => host.querySelector<HTMLButtonElement>(".quick-select-candidate")!.click()); check(Number(confirmed) === 1, "explicit confirmation not delivered");
    flushSync(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    check(closed && !host.querySelector(".quick-select-panel") && JSON.stringify(initial.root) === source, "Escape/filtering mutated captured source");
    return ["internal selection: current branch, layout-bounds explanation, text/ID/type/relative position and true total/page counts",
      "full-candidate filtering beyond page one, empty/reset/paging, focus/preview/confirmation separation and 760/300/248px placement"];
  } finally { flushSync(() => mounted.unmount()); host.remove(); }
}
