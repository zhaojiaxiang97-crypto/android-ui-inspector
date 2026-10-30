import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { UiTree } from "../src/components/UiTree";
import { Layer3DPreview } from "../src/features/layers/Layer3DPreview";
import { NodeHoverProvider, useNodeHoverActions } from "../src/features/inspection/NodeHoverContext";
import type { LayerSceneHandle } from "../src/features/layers/types";
import type { UiNode, UiSnapshot } from "../shared/types";
import { filterTree } from "../shared/tree-utils";
import { makeNode } from "./fixtures";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Workbench hover: ${message}`);
}
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 4000;
  while (!predicate()) { check(performance.now() < deadline, message); await tick(); }
}
function fixture(): UiSnapshot {
  const image = (width: number, height: number, color: string) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/png");
  };
  const node = (id: string, text: string, left: number, top: number, right: number, bottom: number, color: string): UiNode => ({
    ...makeNode(id), text, className: "android.view.ViewGroup",
    bounds: { left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` },
    layerImageDataUrl: image(right - left, bottom - top, color), layerImageSize: { width: right - left, height: bottom - top },
  });
  const root = node("0", "悬停根", 0, 0, 400, 320, "#152030");
  const a = node("0/0", "左侧控件", 20, 40, 180, 120, "#408b68");
  const b = node("0/1", "右侧容器", 220, 150, 380, 250, "#486caa");
  b.children = [node("0/1/0", "右侧子控件", 240, 170, 320, 210, "#d88b45")]; root.children = [a, b];
  return { root, serial: "hover-fixture", nodeCount: 4, xmlSize: 0, rawXml: null,
    screenshotDataUrl: image(400, 320, "#152030"), warning: null, error: null };
}

// Exercise the real App provider and 2D image coordinates; component-only 3D
// checks below additionally verify the actual WebGL hit/measurement path.
export async function verifyWorkbenchHover() {
  const previousApi = window.electronApi;
  const storageBefore = Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!; return [key, localStorage.getItem(key)!] as const;
  });
  const host = document.createElement("div"); document.body.append(host);
  const reactRoot = createRoot(host), current = fixture();
  let captures = 0;
  window.electronApi = {
    runtime: { sandboxed: true, contextIsolated: true },
    probeAdb: async () => ({ adbPath: "fixture", adbVersion: "fixture", error: null,
      devices: [{ serial: current.serial, state: "device", model: "fixture", androidVersion: "15", product: null, transportId: null }] }),
    inspectDevice: async () => { captures++; return structuredClone(current); }, cancelInspection: async () => {},
    captureGroup: async () => { throw new Error("Unexpected hover group capture"); },
    refreshViewNode: async () => { throw new Error("Unexpected hover refresh"); },
    readViewStyle: async () => { throw new Error("Unexpected hover style request"); }, copyText: async () => {},
    exportSnapshot: async () => ({ canceled: true, filePath: null, error: null }),
    showLayerMenu: async () => null, onInspectionProgress: () => () => {}, onInspectionPreview: () => () => {},
    loadSnapshots: async () => ({ snapshots: [], error: null }), saveSnapshot: async () => ({ snapshots: [], error: null }),
    clearSnapshots: async () => ({ snapshots: [], error: null }),
  };
  const click = (selector: string) => {
    const control = host.querySelector<HTMLElement>(selector); check(control, `missing control ${selector}`);
    flushSync(() => control.click());
  };
  const row = (id: string) => host.querySelector<HTMLElement>(`.tree-row[data-tree-id="${id}"]`)!;
  const hovered = () => host.querySelector<HTMLElement>(".tree-row[data-hovered='true']")?.dataset.treeId;
  const image = () => host.querySelector<HTMLImageElement>(".screenshot-stage img")!;
  const hoverImage = (fx: number, fy: number) => {
    const rect = image().getBoundingClientRect();
    flushSync(() => image().dispatchEvent(new PointerEvent("pointermove", { bubbles: true,
      clientX: rect.left + rect.width * fx, clientY: rect.top + rect.height * fy, pointerType: "mouse", isPrimary: true })));
  };
  const hoverRow = (id: string) => flushSync(() => row(id).dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  const selected = () => host.querySelector<HTMLElement>(".tree-row[aria-selected='true']")?.dataset.treeId;
  const tree = () => host.querySelector<HTMLElement>(".ui-tree-scroll")!;
  try {
    localStorage.clear(); flushSync(() => reactRoot.render(<App />));
    await until(() => Boolean(host.querySelector<HTMLButtonElement>(".capture-button") && !host.querySelector<HTMLButtonElement>(".capture-button")!.disabled), "capture unavailable");
    click(".capture-button");
    await until(() => Boolean(row("0/1/0") && image()?.complete && image().naturalWidth), "capture/image unavailable");
    click(".view-mode-toggle button:first-child");
    await until(() => !host.querySelector<HTMLElement>(".screenshot-frame")?.dataset.modeMotion, "2D view transition did not settle");
    await tick();
    const selection = selected(), open = tree().querySelectorAll('[aria-expanded="true"]').length, top = tree().scrollTop;
    hoverImage(.72, .59);
    await until(() => hovered() === "0/1/0", "2D hover did not reach the exact nested tree row");
    check(selected() === selection && tree().scrollTop === top && tree().querySelectorAll('[aria-expanded="true"]').length === open, "hover changed selection, scrolling or expansion");
    check(host.querySelector('[data-flat-hovered-id="0/1/0"]') && host.querySelector('.tree-hover-guide[data-hover-parent-id="0/1"]'), "2D overlay or immediate parent guide missing");

    const keyboardId = tree().getAttribute("aria-activedescendant"); tree().focus();
    hoverRow("0/0");
    check(hovered() === "0/0" && host.querySelector('[data-flat-hovered-id="0/0"]'), "tree hover did not outline the 2D control");
    check(document.activeElement === tree() && tree().getAttribute("aria-activedescendant") === keyboardId && selected() === selection, "tree hover stole keyboard focus or selected a control");
    const overlay = host.querySelector<HTMLElement>('[data-flat-hovered-id="0/0"]')!.getBoundingClientRect(), rect = image().getBoundingClientRect();
    check(Math.abs(overlay.left - (rect.left + .05 * rect.width)) < 1 && Math.abs(overlay.width - .4 * rect.width) < 1, "2D hover outline uses the wrong device coordinates");
    flushSync(() => host.querySelector<HTMLElement>(".screenshot-frame")!.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: row("0/0") })));
    check(hovered() === "0/0", "late canvas leave erased newer tree hover");

    const frame = host.querySelector<HTMLElement>(".screenshot-frame")!;
    flushSync(() => tree().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: image() })));
    for (const interrupt of ["Space", "Shift", "blur"]) {
      frame.focus();
      hoverImage(.72, .59); // Interrupt before its scheduled hit-test frame.
      flushSync(() => {
        if (interrupt === "blur") window.dispatchEvent(new Event("blur"));
        else frame.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: interrupt === "Space" ? " " : "Shift", code: interrupt }));
      });
      await tick(); await tick();
      check(!hovered() && !host.querySelector(".canvas-hover-overlay"), `${interrupt} allowed a queued 2D hover to return`);
      if (interrupt !== "blur") flushSync(() => frame.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: interrupt === "Space" ? " " : "Shift", code: interrupt })));
    }

    hoverImage(.72, .59); await until(() => hovered() === "0/1/0", "second canvas hover missing");
    click(".view-mode-toggle button:last-child");
    check(!hovered() && !host.querySelector(".canvas-hover-overlay"), "2D hover leaked into a new 3D view");
    hoverRow("0/0");
    check(host.querySelector<HTMLElement>(".layer-scene")?.dataset.layerHoveredId === "0/0", "tree hover did not reach the 3D scene");
    click(".view-mode-toggle button:first-child");
    check(hovered() === "0/0", "switching view erased a current tree hover");
    hoverImage(.72, .59); await until(() => hovered() === "0/1/0", "canvas hover before capture missing");
    click(".capture-button");
    await until(() => captures === 2 && Boolean(row("0/1/0") && !host.querySelector(".inspection-progress")), "replacement capture missing");
    check(!hovered() && !host.querySelector(".canvas-hover-overlay"), "same-ID new snapshot reused stale hover");
    check(captures === 2, "hover triggered an extra device capture");
    return ["actual App: nested 2D image hit → tree and clipped overlay", "tree → 2D/3D, immediate parent guide; selection/expansion/scroll/keyboard unchanged",
      "source handoff, Space/Shift/blur pending-frame cancellation, view-switch cleanup and same-ID replacement snapshot; no extra capture"];
  } finally {
    flushSync(() => reactRoot.unmount()); host.remove(); window.electronApi = previousApi;
    localStorage.clear(); for (const [key, value] of storageBefore) localStorage.setItem(key, value);
  }
}

export async function verifyLayerHoverIntegration() {
  const host = document.createElement("div"); Object.assign(host.style, { width: "680px", height: "460px", position: "relative" }); document.body.append(host);
  const reactRoot = createRoot(host), ref = createRef<LayerSceneHandle>(), initial = fixture(), a = initial.root!.children[0], b = initial.root!.children[1];
  let root = initial.root!, expanded: ReadonlySet<string> = new Set([root.id, b.id]), hidden: ReadonlySet<string> = new Set(), session = 0, searchPath = false;
  let actions!: ReturnType<typeof useNodeHoverActions>, selections = 0;
  function Harness() {
    actions = useNodeHoverActions();
    const query = searchPath ? "右侧子控件" : "";
    const filter = { query, interactiveOnly: false, identifiedOnly: false };
    return <><UiTree root={root} filteredRoot={filterTree(root, filter)} selectedId={a.id} expanded={expanded} filterActive={searchPath} filterKey={query} filter={filter}
      onExpandedChange={() => {}} onSelect={() => { selections++; }} onClearFilter={() => {}} />
      <Layer3DPreview ref={ref} root={root} src={initial.screenshotDataUrl!} selectedNode={a} sessionKey={session}
        expandedNodeIds={expanded} hiddenNodeIds={hidden} size={{ width: 400, height: 320 }} renderScale={1} origin={{ left: 100, top: 40 }}
        camera={{ distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 }} onSelect={() => { selections++; }} /></>;
  }
  const render = () => flushSync(() => reactRoot.render(<NodeHoverProvider root={root} sessionKey={session}><Harness /></NodeHoverProvider>));
  const canvas = () => host.querySelector<HTMLCanvasElement>(".layer-webgl-canvas")!;
  const scene = () => host.querySelector<HTMLElement>(".layer-scene")!;
  const measure = () => host.querySelector<HTMLElement>(".layer-measurement-status");
  const hover = (id: string) => {
    const rect = canvas().getBoundingClientRect();
    for (let y = 12; y < rect.height; y += 8) for (let x = 12; x < rect.width; x += 8) {
      if (ref.current!.pick(rect.left + x, rect.top + y)?.id === id) { flushSync(() => ref.current!.hover(rect.left + x, rect.top + y)); return; }
    }
    throw new Error(`Workbench hover: WebGL control ${id} not pickable`);
  };
  try {
    render(); await until(() => canvas()?.dataset.layerRenderer === "webgl" && Number(canvas().dataset.layerTextureCount) >= 3, "WebGL hover scene did not load");
    hover(b.id);
    check(host.querySelector(`.tree-row[data-tree-id="${b.id}"][data-hovered="true"]`) && scene().dataset.layerHoveredId === b.id, "3D hit did not reach tree");
    check(!measure() && host.querySelector<HTMLElement>(".layer-hover-label")?.dataset.nodeId === b.id, "canvas hover must preserve identity without automatic measurements");
    flushSync(() => { check(ref.current!.toggleMeasurementPin(), "could not pin measurement"); });
    check(measure()?.dataset.measureAnchor === a.id && measure()?.dataset.measureTarget === b.id, "explicit measurement lost the canvas pair");
    const pair = `${measure()!.dataset.measureAnchor}:${measure()!.dataset.measureTarget}`;
    const gl = canvas().getContext("webgl")!, upload = gl.texImage2D; let uploads = 0;
    gl.texImage2D = ((...args: unknown[]) => { uploads++; Reflect.apply(upload, gl, args); }) as WebGLRenderingContext["texImage2D"];
    try {
      flushSync(() => actions.publishHover(b.children[0].id, "tree"));
      check(scene().dataset.layerHoveredId === b.children[0].id && !host.querySelector(".layer-hover-label"), "tree hover did not highlight the exact layer or reused canvas tooltip position");
      check(`${measure()!.dataset.measureAnchor}:${measure()!.dataset.measureTarget}` === pair && measure()!.dataset.measurePinned === "true", "tree hover rewrote a pinned measurement");
      flushSync(() => ref.current!.clearHover());
      check(scene().dataset.layerHoveredId === b.children[0].id, "old canvas leave erased newer tree hover");
      check(uploads === 0 && selections === 0, "hover uploaded textures or selected controls");
    } finally { gl.texImage2D = upload; }
    expanded = new Set([root.id]); searchPath = true; render();
    flushSync(() => actions.publishHover(b.children[0].id, "tree"));
    check(scene().dataset.layerHoveredId === b.id, "folded child did not point at its visible parent");
    hidden = new Set([b.id]); render();
    flushSync(() => actions.publishHover(b.id, "tree"));
    check(scene().dataset.layerHoveredId !== b.id, "hidden physical layer kept hover");
    const stale = actions;
    root = structuredClone(root); session++; render();
    flushSync(() => stale.publishHover(a.id, "tree"));
    check(!scene().dataset.layerHoveredId && !measure(), "old closure or pinned pair survived replacement session");
    return ["real WebGL hit ↔ tree; tree highlight does not change a pinned canvas measurement or show stale cursor tooltip",
      "no hover texture uploads/selection; folded child resolves visible parent, hidden layers and replacement sessions clear safely"];
  } finally { flushSync(() => reactRoot.unmount()); host.remove(); }
}
