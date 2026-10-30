import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { CaptureGeometry, UiNode } from "../shared/types";
import { DEFAULT_ORBIT_CAMERA } from "../shared/orbit-camera";
import { ScreenshotPreview } from "../src/components/ScreenshotPreview";
import { NodeHoverProvider, useNodeHoverActions } from "../src/features/inspection/NodeHoverContext";
import { makeNode } from "./fixtures";

type NativeInput = { type: string; x?: number; y?: number; button?: string; clickCount?: number; keyCode?: string; modifiers?: string[] };
type Native = { input: (events: NativeInput[]) => Promise<void>; checkpoint: (name: string) => Promise<void> };
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Canvas round 5: ${message}`); }
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };
async function until(predicate: () => boolean, message: string) { const deadline = performance.now() + 7000; while (!predicate()) { assert(performance.now() < deadline, message); await tick(); } }
function node(id: string, left: number, top: number, width: number, height: number): UiNode { return { ...makeNode(id), text: id, bounds: { left, top, right: left + width, bottom: top + height, raw: "" } }; }
function pixels(width: number, height: number, color: string) { const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, width, height); return canvas; }

export async function verifyCanvasRound5(native: Native) {
  const oldApi = window.electronApi; let deviceRequests = 0;
  window.electronApi = new Proxy({} as typeof oldApi, { get: (_target, key) => () => { deviceRequests++; throw new Error(`Device access forbidden: ${String(key)}`); } });
  const host = document.createElement("div"); host.className = "app-shell inspection-active"; host.style.cssText = "width:100%;height:100vh;display:flex;flex-direction:column";
  host.innerHTML = '<div class="inspection-header"><div class="canvas-test-probes"></div><button class="canvas-test-outside" type="button">外部控件</button></div><div class="preview-pane" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>';
  document.body.append(host); const probes = host.querySelector<HTMLElement>(".canvas-test-probes")!, mount = host.querySelector<HTMLElement>(".preview-pane")!, mounted = createRoot(mount);
  const screen = pixels(400, 320, "#182029"), ownA = pixels(160, 80, "#487ddd"), ownB = pixels(160, 100, "#d88b45"), ownChild = pixels(60, 30, "#69ac87");
  const a = node("canvas-A", 20, 40, 160, 80), b = node("canvas-B", 220, 150, 160, 100), child = node("canvas-child", 40, 50, 60, 30);
  for (const [target, image] of [[a, ownA], [b, ownB], [child, ownChild]] as const) { target.layerImageDataUrl = image.toDataURL(); target.layerImageSize = { width: image.width, height: image.height }; }
  a.children = [child]; let root = node("canvas-root", 0, 16, 400, 288); root.children = [a, b]; root.layerImageEmpty = true;
  let selected: UiNode | null = a, session = 1, source = screen.toDataURL(), disabled = false;
  let geometry: CaptureGeometry | undefined = { hierarchyRotation: 0, beforeScreenshot: { width: 400, height: 320, rotation: 0 }, afterScreenshot: { width: 400, height: 320, rotation: 0 }, screenshotSize: { width: 400, height: 320 } };
  const checkedGeometry = geometry, expanded = new Set([root.id, a.id]);
  const menus: { node: UiNode | null; mode?: string }[] = [];
  function Probes() { const { publishHover, clearHover } = useNodeHoverActions(); return <>{[a, b].map(target => <button type="button" data-probe={target.id} key={target.id} onMouseEnter={() => publishHover(target.id, "tree")} onMouseLeave={() => clearHover("tree")}>{target.id}</button>)}</>; }
  const render = () => flushSync(() => mounted.render(<NodeHoverProvider root={root} sessionKey={session}>{createPortal(<Probes />, probes)}
    <ScreenshotPreview root={root} selectedNode={selected} src={source} geometry={geometry} sessionKey={session} expandedNodeIds={expanded}
      navigationDisabled={disabled} onSelect={value => { selected = value; render(); }} layerFocus={null} hiddenNodeIds={new Set()} doubleClickAction="toggle" onDoubleClick={() => {}}
      onLayerAction={() => {}} onOpenLayerMenu={(target, mode) => { menus.push({ node: target, mode }); if (target) { selected = target; render(); } }} />
  </NodeHoverProvider>));
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => { const result = host.querySelector<T>(selector) ?? document.querySelector<T>(selector); assert(result, `missing ${selector}`); return result; };
  const input = async (events: NativeInput[]) => { await native.input(events); await settle(); };
  const key = (key: string, modifiers: string[] = []) => { const keyCode = key.replace(/^Arrow/, ""); return input([{ type: "keyDown", keyCode, modifiers }, { type: "keyUp", keyCode, modifiers }]); };
  const press = (point: { x: number; y: number }, button = "left", modifiers: string[] = []) => input([{ type: "mouseMove", ...point }, { type: "mouseDown", ...point, button, clickCount: 1, modifiers }, { type: "mouseUp", ...point, button, clickCount: 1, modifiers }]);
  const click = async (selector: string) => { get(selector).scrollIntoView({ block: "nearest" }); await settle(); const r = get(selector).getBoundingClientRect(); await press({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); };
  const flatPoint = (x: number, y: number) => { const r = get<HTMLImageElement>(".screenshot-stage img").getBoundingClientRect(); return { x: r.left + r.width * x / 400, y: r.top + r.height * y / 320 }; };
  const frame = () => get(".screenshot-frame"), stage = () => get(".screenshot-stage"), pair = () => get(".measurement-card"), pairValues = () => get(".measurement-card-values").textContent;
  const angles = () => [frame().dataset.cameraPaintAzimuth, frame().dataset.cameraPaintElevation, frame().dataset.cameraPaintRoll].join("/");
  const pan = () => stage().style.getPropertyValue("--layer-live-pan");
  const ready = () => until(() => get<HTMLImageElement>(".screenshot-stage img").naturalWidth === 400 && stage().dataset.coordinateStatus === "checked", "checked screenshot not ready");
  const text = async (selector: string, value: string) => { await click(selector); get<HTMLInputElement>(selector).select(); if (!value) await key("Backspace"); else await input([...value].map(keyCode => ({ type: "char", keyCode }))); assert(get<HTMLInputElement>(selector).value === value, `native text did not enter ${value}`); };
  const gap = '[aria-label="3D 层间距数值"]', distance = '[aria-label="3D 相机视距数值"]';
  const checks: string[] = [];
  try {
    render(); await ready(); await click(".view-mode-toggle button:first-child");
    await press(flatPoint(60, 60), "right"); assert(menus.at(-1)?.node === child && menus.at(-1)?.mode === "flat", "nested 2D right click did not use actual target/mode");
    const selection = selected; await press(flatPoint(60, 3), "right"); assert(menus.at(-1)?.node === null && selected === selection, "2D image padding fell back to selected");
    const beforeDrag = menus.length, point = flatPoint(60, 60);
    await input([{ type: "mouseMove", ...point }, { type: "mouseDown", ...point, button: "right", clickCount: 1 }, { type: "mouseMove", x: point.x + 15, y: point.y + 10, modifiers: ["rightButtonDown"] }, { type: "mouseUp", x: point.x + 15, y: point.y + 10, button: "right", clickCount: 1 }]);
    assert(menus.length === beforeDrag && selected === selection, "2D right drag opened menu or changed selection");
    if (/Mac/.test(navigator.platform)) { await press(flatPoint(250, 190), "left", ["control"]); assert(menus.at(-1)?.node === b && menus.at(-1)?.mode === "flat", "Mac Control click did not hit current 2D node"); }
    selected = a; render(); frame().focus(); await key("F10", ["shift"]); assert(menus.at(-1)?.node === a && menus.at(-1)?.mode === "flat", "Shift F10 did not use selected 2D node");
    flushSync(() => frame().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ContextMenu" }))); assert(menus.at(-1)?.node === a, "menu-key DOM contract failed");
    const beforeIme = menus.length; flushSync(() => frame().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "F10", shiftKey: true, isComposing: true }))); assert(menus.length === beforeIme, "IME opened a menu");
    await native.checkpoint("2d-target"); checks.push("Native 2D right release, Mac Control click and Shift F10 bind exact nested/selected objects; blank does not fall back; drag/IME/menu-key protections");

    await click(".zoom-controls button[aria-label='放大截图']"); await press(flatPoint(60, 60), "right"); assert(menus.at(-1)?.node === child, "zoom changed 2D menu reverse lookup");
    const p = flatPoint(250, 190);
    // Keep Space pressed across the native pointer drag.
    await input([{ type: "keyDown", keyCode: "Space" }, { type: "mouseDown", ...p, button: "left", clickCount: 1 }, { type: "mouseMove", x: p.x + 18, y: p.y + 11, modifiers: ["leftButtonDown"] }, { type: "mouseUp", x: p.x + 18, y: p.y + 11, button: "left", clickCount: 1 }, { type: "keyUp", keyCode: "Space" }]);
    const movedPan = pan(), beforePanMenu = menus.length, panMatch = /^translate3d\(([-.\d]+)px,\s*([-.\d]+)px/.exec(movedPan);
    assert(panMatch && Math.abs(Number(panMatch[1]) - 18) <= 1 && Math.abs(Number(panMatch[2]) - 11) <= 1, `flat Space drag did not pan within native coordinate rounding: ${movedPan}`);
    await press(flatPoint(250, 190), "right", ["shift"]); assert(menus.length === beforePanMenu, "Shift right click bypassed pan guard");
    await press(flatPoint(250, 190), "right"); assert(menus.at(-1)?.node === b, "pan changed 2D menu reverse lookup");
    checks.push("Actual fitted image reverse lookup after native zoom and Space pan; Shift does not open a menu");

    const beforeInvalid = menus.length;
    geometry = undefined; render(); await settle(); await press(flatPoint(60, 60), "right"); assert(menus.length === beforeInvalid && stage().dataset.coordinateStatus === "unverified", "unverified geometry guessed a pointer target");
    frame().focus(); await key("F10", ["shift"]); assert(menus.at(-1)?.node === b, "unverified geometry incorrectly disabled valid keyboard target");
    geometry = { ...checkedGeometry, hierarchyRotation: 1 }; render(); await settle(); const beforeMismatch = menus.length; await press(flatPoint(60, 60), "right"); assert(menus.length === beforeMismatch && stage().dataset.coordinateStatus === "mismatch", "mismatch guessed pointer target");
    selected = { ...b }; render(); frame().focus(); await key("F10", ["shift"]); assert(menus.at(-1)?.node === null, "same-id stale selected object was reused");
    selected = b; disabled = true; render(); const beforeBusy = menus.length; frame().focus(); await key("F10", ["shift"]); assert(menus.length === beforeBusy, "busy selection opened a menu");
    disabled = false; geometry = checkedGeometry; source = "data:image/png;base64,AA=="; render(); await until(() => stage().dataset.coordinateStatus === "error", "missing image did not become unavailable");
    const beforeMissing = menus.length; await press({ x: frame().getBoundingClientRect().left + 15, y: frame().getBoundingClientRect().top + 15 }, "right"); assert(menus.length === beforeMissing, "missing image guessed pointer target");
    frame().focus(); await key("F10", ["shift"]); assert(menus.at(-1)?.node === b, "missing image disabled valid keyboard copy target");
    source = screen.toDataURL(); render(); await ready(); await click(".view-mode-toggle button:first-child");
    checks.push("Unverified/mismatched/missing images disable pointer guesses; keyboard checks real root object identity, stale object and busy state");

    selected = a; render(); await click(".pin-layer-measurement"); const probe = get('[data-probe="canvas-B"]').getBoundingClientRect(); await input([{ type: "mouseMove", x: probe.left + probe.width / 2, y: probe.top + probe.height / 2 }]); await click(".measurement-pin");
    assert(pair().dataset.measurementMode === "fixed", "A/B was not fixed"); const fixed = pairValues(); await press(flatPoint(60, 60), "right"); assert(pair().dataset.measurementMode === "fixed" && pairValues() === fixed, "2D menu changed fixed A/B");
    await click(".view-mode-3d"); await until(() => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")?.dataset.layerRenderer === "webgl" && host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")?.dataset.layerTexturePendingCount === "0", "real scene not ready");
    const rect = frame().getBoundingClientRect(), viewport = frame().dataset;
    const center = { x: rect.left + Number(viewport.viewportLeft) + Number(viewport.viewportWidth) / 2, y: rect.top + Number(viewport.viewportTop) + Number(viewport.viewportHeight) / 2 }, beforeRotate = angles(), beforeRotateMenus = menus.length;
    assert(document.elementFromPoint(center.x, center.y)?.closest(".screenshot-frame") === frame() && !document.elementFromPoint(center.x, center.y)?.closest(".measurement-card"), "native orbit point was obscured by a floating card");
    await input([{ type: "mouseMove", ...center }, { type: "mouseDown", ...center, button: "right", clickCount: 1 }, { type: "mouseMove", x: center.x + 20, y: center.y - 10, modifiers: ["rightButtonDown"] }, { type: "mouseUp", x: center.x + 20, y: center.y - 10, button: "right", clickCount: 1 }]);
    assert(angles() !== beforeRotate && menus.length === beforeRotateMenus && pairValues() === fixed, "3D right drag no longer orbits or opened a menu/changed A/B");
    frame().focus(); await key("F10", ["shift"]); assert(menus.at(-1)?.mode === "layers3d" && menus.at(-1)?.node === selected, "3D menu mode/selected target regressed");
    const inspectorPopup = document.createElement("div"); inspectorPopup.className = "inspector-group-popup"; inspectorPopup.innerHTML = '<button type="button">属性分组浮层键盘契约</button>'; document.body.append(inspectorPopup);
    let inspectorEscapes = 0; inspectorPopup.addEventListener("keydown", event => { if (event.key === "Escape") { inspectorEscapes++; event.preventDefault(); event.stopPropagation(); } });
    try { inspectorPopup.querySelector("button")!.focus(); await key("Escape"); assert(inspectorEscapes === 1 && pair().dataset.measurementMode === "fixed" && pairValues() === fixed && get(".view-mode-3d").getAttribute("aria-pressed") === "true", "property portal Escape leaked through canvas measurement/mode capture"); }
    finally { inspectorPopup.remove(); }
    const previousPan = pan(), previousAngles = angles(), previousSelection = selected, originalTree = JSON.stringify(root), textureBytes = get<HTMLCanvasElement>(".layer-webgl-canvas").dataset.layerTextureBytes;
    checks.push("Fixed A/B survives 2D target changes and property portal Escape; native 3D right-button orbit and keyboard menu remain intact");

    await click(".layer-settings > summary"); const popup = () => get(".layer-settings-body");
    await click(distance); await key("Enter"); assert(get<HTMLInputElement>(distance).value === String(DEFAULT_ORBIT_CAMERA.distance) && frame().dataset.cameraPaintDistance === String(DEFAULT_ORBIT_CAMERA.distance) && !popup().querySelector('[aria-invalid="true"]'), "unchanged default distance became invalid");
    for (const [selector, values, attribute] of [[gap, [24, 120, 240], "cameraPaintLayerGap"], [distance, [720, 1120, 1800], "cameraPaintDistance"]] as const) {
      for (const value of values) { await text(selector, String(value)); await key("Enter"); assert(frame().dataset[attribute] === String(value) && get<HTMLInputElement>(selector).value === String(value), `exact camera did not paint ${attribute}=${value}`); }
    }
    const gl = get<HTMLCanvasElement>(".layer-webgl-canvas").getContext("webgl")!, program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    const distanceUniform = gl.getUniformLocation(program, "u_distance"); assert(distanceUniform, "GPU camera uniform missing");
    const expectedSceneDistance = 1800 * screen.height / 400;
    const depths = [...host.querySelectorAll<HTMLElement>("[data-layer-z]")].map(element => Number(element.dataset.layerZ));
    assert(Math.hypot(screen.width, screen.height, Math.max(...depths) - Math.min(...depths)) * 1.1 < expectedSceneDistance, "fixture radius unexpectedly overrides the requested distance");
    const stageElement = get(".screenshot-stage"), stageWidth = Number.parseFloat(stageElement.style.width), renderScale = stageWidth / screen.width;
    assert(Math.abs(stageElement.getBoundingClientRect().width - stageWidth) <= 1 / 64, "displayed stage width diverged from its requested width");
    assert(Math.abs(Number(get<HTMLCanvasElement>(".layer-webgl-canvas").dataset.layerSceneDistance) - expectedSceneDistance) < .01
      && Math.abs(gl.getUniform(program, distanceUniform) - expectedSceneDistance * renderScale) < .01,
      `GPU distance did not follow the exact camera input at the displayed scene scale: ${JSON.stringify({ actualScene: get<HTMLCanvasElement>(".layer-webgl-canvas").dataset.layerSceneDistance, expectedSceneDistance, uniform: gl.getUniform(program, distanceUniform), renderScale })}`);
    const zGap = () => Number(get(`[data-layer-node-id="${child.id}"]`).dataset.layerZ) - Number(get(`[data-layer-node-id="${a.id}"]`).dataset.layerZ);
    assert(zGap() === 240, "max layer gap did not reach the actual layout");
    await text(gap, "120"); await key("Enter"); assert(zGap() === 120 && frame().dataset.cameraPaintLayerGap === "120", "real layout did not follow exact layer gap");
    assert(pan() === previousPan && angles() === previousAngles && selected === previousSelection && JSON.stringify(root) === originalTree && pairValues() === fixed && get<HTMLCanvasElement>(".layer-webgl-canvas").dataset.layerTextureBytes === textureBytes, "camera input changed pan/orbit/selection/tree/A/B or image cache");
    await native.checkpoint("exact-parameters"); checks.push("Native exact inputs accept endpoints/steps and the unchanged default; actual GPU distance and layout Z change while pan/orbit/selection/tree/images/fixed A/B remain");

    for (const value of ["", "NaN", "248", "121"]) { await text(gap, value); await key("Enter"); assert(frame().dataset.cameraPaintLayerGap === "120" && get<HTMLInputElement>(gap).getAttribute("aria-invalid") === "true" && popup().querySelector(".layer-camera-input-error")?.textContent, `invalid ${value} changed camera or lacked explanation`); }
    await native.checkpoint("invalid-draft"); await key("Escape"); assert(document.querySelector("body > .layer-settings-body") && get<HTMLInputElement>(gap).value === "120" && !popup().querySelector('[aria-invalid="true"]'), "first Escape did not revert just the draft");
    await key("Escape"); assert(!document.querySelector("body > .layer-settings-body") && document.activeElement === get(".layer-settings > summary") && pairValues() === fixed, "second Escape did not close tool/focus opener or changed A/B");
    await click(".layer-settings > summary"); await text(distance, "1120"); await click(".layer-appearance-help button"); assert(get<HTMLInputElement>(distance).value === "1800" && frame().dataset.cameraPaintDistance === "1800", "blur committed or retained the unsubmitted draft");
    await click('[aria-label="3D 相机视距"]'); assert(get<HTMLInputElement>(distance).value === frame().dataset.cameraPaintDistance, "slider did not synchronize numeric display after blur");
    const slider = get<HTMLInputElement>('[aria-label="3D 相机视距"]'); slider.focus(); const previousDistance = Number(frame().dataset.cameraPaintDistance); await key("ArrowRight"); assert(Number(frame().dataset.cameraPaintDistance) === Math.min(1800, previousDistance + 40) && get<HTMLInputElement>(distance).value === frame().dataset.cameraPaintDistance, `native slider did not share exact step validation and numeric display: ${JSON.stringify({ previousDistance, painted: frame().dataset.cameraPaintDistance, slider: slider.value, number: get<HTMLInputElement>(distance).value, focus: document.activeElement?.getAttribute("aria-label") })}`);
    await text(gap, "24"); flushSync(() => get(gap).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", isComposing: true }))); assert(frame().dataset.cameraPaintLayerGap === "120", "IME committed a numeric draft");
    flushSync(() => get(gap).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape", isComposing: true }))); assert(get<HTMLInputElement>(gap).value === "24" && document.querySelector("body > .layer-settings-body"), "IME cancelled numeric draft/tool");
    await click(".canvas-test-outside"); assert(!document.querySelector("body > .layer-settings-body") && pairValues() === fixed, "outside pointer retained tool or changed A/B");
    await click(".layer-settings > summary"); assert(get<HTMLInputElement>(gap).value === "120", "closing tool retained old draft");
    const bounds = popup().getBoundingClientRect(); assert(bounds.left >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1 && popup().scrollHeight >= popup().clientHeight, "numeric settings clipped the pressure window");
    await native.checkpoint("settings-window"); session++; render(); await ready(); assert(!document.querySelector("body > .layer-settings-body") && frame().dataset.cameraPaintLayerGap === "128" && frame().dataset.cameraPaintDistance === String(DEFAULT_ORBIT_CAMERA.distance), "new snapshot/session retained camera draft or tool");
    await click(".view-mode-toggle button:first-child"); const oldPress = flatPoint(60, 60), beforeReplacement = menus.length;
    await input([{ type: "mouseMove", ...oldPress }, { type: "mouseDown", ...oldPress, button: "right", clickCount: 1 }]);
    root = { ...root, children: [{ ...a, children: [{ ...child }] }, { ...b }] }; render(); await input([{ type: "mouseUp", ...oldPress, button: "right", clickCount: 1 }]);
    assert(menus.length === beforeReplacement && !frame().dataset.gesture, "new root reused a cancelled context press");
    frame().focus(); await key("F10", ["shift"]); assert(menus.at(-1)?.node === null, "replacement root reused old selected identity");
    assert(deviceRequests === 0, "local canvas interactions requested device data");
    checks.push("Native invalid/empty drafts explain without repaint; first Escape reverts, second closes/focuses; blur, IME, slider synchronization and session reset; bounded pressure-window popup");
    return { checks, deviceRequests, cssViewport: { width: innerWidth, height: innerHeight }, devicePixelRatio, scope: "Owned offline images/geometry, actual React canvas and WebGL uniforms/layout; native Electron pointers, text, Enter/Escape/Shift-F10/sliders. DOM text selection prepares replacements in the hidden window; DOM event injection covers only menu-key/IME contracts. Page zoom is separate from physical DPI." };
  } catch (error) { await native.checkpoint("failure-before-cleanup"); throw error; }
  finally { flushSync(() => mounted.unmount()); host.remove(); window.electronApi = oldApi; for (const canvas of [screen, ownA, ownB, ownChild]) canvas.width = canvas.height = 0; }
}
