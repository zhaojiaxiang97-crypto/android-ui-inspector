import type { UiNode } from "../shared/types";
import { createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ScreenshotPreview } from "./screenshot-preview-fixture";
import { NodeHoverProvider, useNodeHoverActions } from "../src/features/inspection/NodeHoverContext";
import { makeNode } from "./fixtures";

const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Canvas: ${message}`); }
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector); assert(value, `missing ${selector}`); return value;
}

export async function verifyWorkbenchCanvas(act: (action: () => void) => void, root: UiNode) {
  const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
  const click = async (selector: string) => { act(() => element(selector).click()); await settle(); };
  const frame = () => element(".screenshot-frame"), panel = () => element(".floating-inspector");
  const nodes = new Map<string, UiNode>();
  const collect = (node: UiNode) => { nodes.set(node.id, node); node.children.forEach(collect); }; collect(root);
  const intersects = (a: DOMRect | { left: number; right: number; top: number; bottom: number }, b: DOMRect) =>
    a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
  const checkFit = () => {
    const scene = element(".layer-scene"), canvas = element<HTMLCanvasElement>(".layer-webgl-canvas"), bounds = canvas.getBoundingClientRect();
    const view = frame().getBoundingClientRect(), obstruction = panel().hidden ? null : panel().getBoundingClientRect();
    const records = [...document.querySelectorAll<HTMLElement>(".layer-plane")].map(plane => ({ node: nodes.get(plane.dataset.layerNodeId!)!, z: Number(plane.dataset.layerZ) }));
    assert(records.length > 0 && scene.dataset.layerMode === "focus", "expected a focused branch");
    const centerX = (Math.min(...records.map(r => r.node.bounds!.left)) + Math.max(...records.map(r => r.node.bounds!.right))) / 2;
    const centerY = (Math.min(...records.map(r => r.node.bounds!.top)) + Math.max(...records.map(r => r.node.bounds!.bottom))) / 2;
    const scale = element<HTMLImageElement>(".screenshot-stage img").getBoundingClientRect().width / 360;
    const px = bounds.left + Number(scene.dataset.layerPivotX), py = bounds.top + Number(scene.dataset.layerPivotY), centerZ = Number(scene.dataset.layerPivotZ);
    const yaw = -40 * Math.PI / 180, pitch = -12 * Math.PI / 180;
    for (const record of records) {
      const b = record.node.bounds!, projected: Array<{ x: number; y: number }> = [];
      for (const x of [b.left, b.right]) for (const y of [b.top, b.bottom]) {
        const cx = (x - centerX) * scale, cy = (centerY - y) * scale, cz = record.z * scale - centerZ;
        const rx = Math.cos(yaw) * cx + Math.sin(yaw) * cz, rz = -Math.sin(yaw) * cx + Math.cos(yaw) * cz;
        const ry = Math.cos(pitch) * cy - Math.sin(pitch) * rz, depth = Math.sin(pitch) * cy + Math.cos(pitch) * rz;
        projected.push({ x: px + rx * 1100 / (1100 - depth), y: py - ry * 1100 / (1100 - depth) });
      }
      const box = { left: Math.min(...projected.map(p => p.x)), right: Math.max(...projected.map(p => p.x)), top: Math.min(...projected.map(p => p.y)), bottom: Math.max(...projected.map(p => p.y)) };
      assert(box.left >= view.left - 1 && box.right <= view.right + 1 && box.top >= view.top - 1 && box.bottom <= view.bottom + 1, "projected layer is outside the visible frame");
      assert(!obstruction || !intersects(box, obstruction), `fitted layer ${record.node.id} is covered by properties`);
    }
    return { pivot: { x: px, y: py }, imageWidth: element(".screenshot-stage img").getBoundingClientRect().width };
  };
  element<HTMLDetailsElement>(".tree-interaction-settings").open = false;
  await click(".zoom-fit"); const docked = checkFit();
  const frameBounds = frame().getBoundingClientRect(), panelBounds = panel().getBoundingClientRect();
  assert(Math.abs(docked.pivot.x - (frameBounds.left + panelBounds.left - 8) / 2) < 1, "docked focus is not centered in the clear part of the canvas");
  await click(".inspector-collapse"); await click(".zoom-fit"); const collapsed = checkFit();
  assert(collapsed.imageWidth >= docked.imageWidth - 1, "collapsed properties reduced framing space");
  await click(".inspector-close"); await click(".zoom-fit"); checkFit();
  await click(".inspector-toggle"); await click(".zoom-fit"); checkFit();
  await click(".inspector-detach");
  const handle = element(".inspector-drag-handle"); handle.focus({ preventScroll: true });
  for (let i = 0; i < 4; i++) act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowLeft", shiftKey: true })));
  await settle(); await click(".zoom-fit"); checkFit();
  await click(".inspector-detach"); await click(".zoom-fit"); checkFit();

  const canvas = element<HTMLCanvasElement>(".layer-webgl-canvas"), r = canvas.getBoundingClientRect();
  const x = r.left + Number(canvas.dataset.layerProbeX), y = r.top + Number(canvas.dataset.layerProbeY);
  assert(frame().contains(document.elementFromPoint(x, y)), "rendered pick point is covered by another control");
  const capture = frame().setPointerCapture; frame().setPointerCapture = () => {};
  const pointer = (type: string, dx = 0) => act(() => frame().dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, pointerId: 42, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x + dx, clientY: y })));
  try {
    pointer("pointermove"); await settle();
    const hovered = element(".layer-hover-label").dataset.nodeId;
    pointer("pointerdown"); pointer("pointerup"); await settle();
    assert(panel().dataset.nodeId === hovered && element('.tree-row.selected').dataset.treeId === hovered, "fitted scene click disagrees with tree/properties");
    const selected = panel().dataset.nodeId, orbit = element(".orbit-readout").textContent;
    pointer("pointerdown"); pointer("pointerup", 20); await settle();
    assert(panel().dataset.nodeId === selected && element(".orbit-readout").textContent !== orbit && !frame().dataset.gesture, "fast drag selected a layer or lost its final movement");
  } finally { frame().setPointerCapture = capture; }
  await click(".zoom-fit"); checkFit();
  await click(".view-mode-toggle button:first-child"); await click(".zoom-fit");
  const image = element(".screenshot-stage img").getBoundingClientRect(), view = frame().getBoundingClientRect();
  assert(image.left >= view.left - 1 && image.right <= view.right + 1 && image.top >= view.top - 1 && image.bottom <= view.bottom + 1
    && !intersects(image, panel().getBoundingClientRect()), "2D fit is clipped or covered by properties");
  await click(".view-mode-toggle button:last-child");
  return { scenarios: ["branch corners avoid docked properties", "collapse/close/reopen updates available space", "floating move/dock updates framing", "visible GPU pick agrees with tree/properties", "fast drag preserves selection and paints release movement", "2D screenshot avoids properties"], docked, collapsed, fixtureOnly: true };
}

// Synthetic bounds-only capture: exercise the shared controller without needing
// native layer images, a connected device or desktop clipboard access.
export async function verifyFlatMeasurementControls(onCheckpoint?: (name: string) => Promise<void>) {
  const host = document.createElement("div"), toolbar = document.createElement("div");
  Object.assign(host.style, { width: "680px", position: "relative" }); document.body.append(toolbar, host);
  const mounted = createRoot(host), previousApi = window.electronApi;
  const make = (id: string, left: number, top: number, right: number, bottom: number) => ({ ...makeNode(id), text: id,
    bounds: { left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` } });
  const root = make("flat-root", 0, 0, 400, 320), a = make("flat-A", 20, 40, 180, 120), b = make("flat-B", 220, 150, 380, 250);
  root.children = [a, b];
  const bitmap = document.createElement("canvas"); bitmap.width = 400; bitmap.height = 320;
  const paint = bitmap.getContext("2d")!; paint.fillStyle = "#182029"; paint.fillRect(0, 0, 400, 320);
  for (const [node, color] of [[a, "#4e8aff"], [b, "#e69252"]] as const) { paint.fillStyle = color; const r = node.bounds!; paint.fillRect(r.left, r.top, r.right - r.left, r.bottom - r.top); }
  const src = bitmap.toDataURL("image/png"), expanded = new Set([root.id]);
  let selected: UiNode | null = a, sessionKey = 1, fast = true, disabled = false, copied = "", failCopy = false;
  window.electronApi = { ...previousApi, copyText: async value => { if (failCopy) throw new Error("unavailable"); copied = value; } };
  function TreeProbe() {
    const { publishHover, clearHover } = useNodeHoverActions();
    return createElement("div", { className: "measurement-tree-probe" }, ...[a, b].map(node => createElement("button", { key: node.id, "data-hover-node": node.id,
      onMouseEnter: () => publishHover(node.id, "tree"), onMouseLeave: () => clearHover("tree"), onClick: () => { selected = node; render(); } }, node.id)));
  }
  const render = () => flushSync(() => mounted.render(createElement(NodeHoverProvider, { root, sessionKey,
    children: createElement(Fragment, null, createElement(TreeProbe), createElement(ScreenshotPreview, {
      root, selectedNode: selected, src, sessionKey, expandedNodeIds: expanded, toolbarHost: toolbar,
      layersAvailable: !fast, navigationDisabled: disabled, measurementSnapshot: { id: "measurement-fixture", capturedAt: "2026-10-13T01:00:00Z" },
      onSelect: node => { selected = node; render(); }, onNavigateNode: node => { selected = node; render(); return true; },
    })) })));
  const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };
  const until = async (condition: () => boolean, message: string) => { const end = performance.now() + 5000; while (!condition()) { assert(performance.now() < end, message); await tick(); } };
  const find = <T extends HTMLElement = HTMLElement>(selector: string) => host.querySelector<T>(selector) ?? toolbar.querySelector<T>(selector);
  const click = async (selector: string) => { const control = find(selector); assert(control, `missing ${selector}`); flushSync(() => control.click()); await settle(); };
  const card = () => find(".measurement-card"), frame = () => find(".screenshot-frame")!;
  const image = () => find<HTMLImageElement>(".screenshot-stage img")!;
  const key = async (key: string, type = "keydown", target: EventTarget = frame(), extra: KeyboardEventInit = {}) => {
    flushSync(() => target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...extra }))); await settle();
  };
  const at = (node: UiNode) => { const r = image().getBoundingClientRect(), b = node.bounds!; return { clientX: r.left + (b.left + b.right) / 800 * r.width, clientY: r.top + (b.top + b.bottom) / 640 * r.height }; };
  const pointer = async (node: UiNode, clickNode = false) => {
    const point = at(node); const target = frame(), capture = target.setPointerCapture; target.setPointerCapture = () => {};
    try { for (const type of clickNode ? ["pointerdown", "pointerup"] : ["pointermove"]) flushSync(() => target.dispatchEvent(new PointerEvent(type, {
      ...point, bubbles: true, isPrimary: true, pointerType: "mouse", pointerId: 48, button: 0, buttons: type === "pointerdown" ? 1 : 0,
    }))); } finally { target.setPointerCapture = capture; }
    await settle();
  };
  const values = () => card()?.querySelector(".measurement-card-values")?.textContent?.replace(/\s/g, "");
  const pair = () => `${card()?.dataset.measurementAnchor}/${card()?.dataset.measurementTarget}`;
  try {
    render(); await until(() => Boolean(image()?.naturalWidth && find<HTMLButtonElement>(".pin-layer-measurement") && !find<HTMLButtonElement>(".pin-layer-measurement")!.disabled), "flat capture measurement entry did not become ready");
    assert(find<HTMLButtonElement>(".view-mode-3d")?.disabled && !find(".layer-webgl-canvas"), "fast capture exposed 3D");
    const reason = toolbar.querySelector<HTMLElement>(".canvas-disabled-control[tabindex='0']")!; reason.focus();
    assert(reason.getAttribute("aria-describedby") && document.activeElement === reason && reason.querySelector(".canvas-disabled-reason")?.textContent?.includes("快速采集"), "unavailable reason cannot be read using keyboard focus");
    await click(".pin-layer-measurement"); await pointer(b);
    assert(pair() === `${a.id}/${b.id}` && values() === "水平40px垂直30px", "2D hover did not use the two original bounds");
    assert(!card()!.querySelector("image") && card()!.textContent?.includes("仅测量外框"), "bounds-only capture fabricated a control image");
    await click(".measurement-pin"); assert(card()?.dataset.measurementMode === "fixed", "2D pair did not pin");
    await onCheckpoint?.("flat-pinned");
    await click(".measurement-copy"); assert(copied.includes("快照 ID：measurement-fixture") && copied.includes("A 右边 → B 左边：40 px") && copied.includes("A 下边 → B 上边：30 px"), "clipboard result lost source identity or edges");
    assert(card()?.textContent?.includes("测距结果已复制"), "copy completion did not report success");
    failCopy = true; await click(".measurement-copy"); assert(card()?.textContent?.includes("复制失败"), "clipboard error reported success"); failCopy = false;
    await click('[aria-label="放大截图"]'); assert(values() === "水平40px垂直30px", "2D zoom changed physical values");
    fast = false; render(); await settle(); await click(".view-mode-3d");
    await until(() => find<HTMLCanvasElement>(".layer-webgl-canvas")?.dataset.layerRenderer === "webgl", "3D did not render");
    assert(pair() === `${a.id}/${b.id}` && values() === "水平40px垂直30px", "2D to 3D changed the pair or values");
    await click(".quick-select-tool"); assert(find(".quick-select-panel"), "internal selection did not open in 3D");
    for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
      await key("Escape", "keydown", frame(), composing); await key("m", "keydown", frame(), composing);
      assert(find(".quick-select-panel") && find(".layer-measurement-status")?.dataset.measurePinned === "true", "IME shortcut closed candidates or changed a fixed pair");
    }
    await key("Escape"); assert(!find(".quick-select-panel") && card()?.dataset.measurementMode === "fixed", "ordinary Escape did not only close candidates");
    for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
      await key("Escape", "keydown", frame(), composing); await key("m", "keydown", frame(), composing);
      assert(card()?.dataset.measurementMode === "fixed" && pair() === `${a.id}/${b.id}`, "IME shortcut cleared a fixed measurement");
    }
    await click(".view-mode-toggle button:first-child"); assert(pair() === `${a.id}/${b.id}` && values() === "水平40px垂直30px", "3D to 2D changed the pair or values");
    await click(".canvas-help summary"); await key("Escape"); assert(!find<HTMLDetailsElement>(".canvas-help")?.open && card()?.dataset.measurementMode === "fixed", "Escape closed help and measurement together");
    const dialog = document.createElement("dialog"); host.append(dialog); dialog.showModal(); await key("Escape", "keydown", dialog); assert(card()?.dataset.measurementMode === "fixed", "modal Escape released the pair"); dialog.close(); dialog.remove();
    await key("Escape"); assert(!card() && !find(".layer-webgl-canvas"), "Escape did not only finish flat measurement");
    await key("Alt"); await pointer(b); assert(card()?.dataset.measurementMode === "temporary", "2D Alt did not temporarily measure");
    await key("Alt", "keyup"); assert(!card(), "releasing Alt retained a temporary flat measurement");
    await key("Alt"); flushSync(() => window.dispatchEvent(new Event("blur"))); await settle(); assert(!card(), "window blur retained temporary measurement");
    await click(".pin-layer-measurement");
    const row = find(`[data-hover-node="${b.id}"]`)!; flushSync(() => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))); await settle();
    assert(pair() === `${a.id}/${b.id}`, "tree hover did not reach flat measurement");
    flushSync(() => row.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }))); await settle();
    await key("Escape"); selected = null; render(); await settle(); await click(".pin-layer-measurement"); await click('[data-measurement-pick="anchor"]'); await pointer(a, true);
    assert(card()?.dataset.measurementPicking === "target" && !find(".layer-webgl-canvas"), "flat A selection switched views or failed to advance");
    await pointer(b, true); assert(pair() === `${a.id}/${b.id}` && card()?.dataset.measurementMode === "fixed", "2D click did not complete B");
    await click(".quick-select-tool"); assert(!find(".quick-select-panel"), "disabled 2D internal selection opened candidates");
    await key("Escape"); await click(".pin-layer-measurement"); await click('[data-measurement-pick="target"]'); disabled = true; render(); await settle();
    assert(!card(), "busy state retained an unfinished pair"); disabled = false; render(); await settle();
    await click(".pin-layer-measurement"); await pointer(a); await click(".measurement-pin"); sessionKey++; render(); await settle(); assert(!card(), "new snapshot retained old measurement");
    return ["2D bounds-only hover/click/tree A/B; no crop-as-control image", "copy uses actual snapshot metadata, compared edges, original px and truthful success/failure", "2D/3D and zoom preserve pair; new snapshot, busy draft, Alt release and blur clear state", "keyboard-accessible unavailable reason; help/modal/Esc handle one layer at a time; IME Esc/M preserves candidate and measurement state"];
  } finally { flushSync(() => mounted.unmount()); host.remove(); toolbar.remove(); window.electronApi = previousApi; bitmap.width = bitmap.height = 0; }
}
