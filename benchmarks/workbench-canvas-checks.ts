import type { UiNode } from "../shared/types";

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
