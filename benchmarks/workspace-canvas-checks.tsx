import { StrictMode, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { WORKSPACE_LAYOUT_STORAGE_KEY } from "../shared/workspace-layout";
import type { UiNode } from "../shared/types";
import { TreePaneResizer } from "../src/components/TreePaneResizer";
import { WorkspaceLayoutPreferences } from "../src/components/WorkspaceLayoutPreferences";
import { useWorkspaceLayout } from "../src/features/inspection/useWorkspaceLayout";
import { NodeHoverProvider, useNodeHoverActions } from "../src/features/inspection/NodeHoverContext";
import { ScreenshotPreview } from "./screenshot-preview-fixture";
import { makeNode } from "./fixtures";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/workbench.css";
import "../src/styles/appearance.css";

type NativeInput = { type: string; x?: number; y?: number; button?: string; clickCount?: number; keyCode?: string; modifiers?: string[] };
type FixtureNative = { input: (events: NativeInput[]) => Promise<void>; checkpoint: (name: string) => Promise<void> };
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Workspace canvas: ${message}`);
};
async function until(condition: () => boolean, message: string) {
  const end = performance.now() + 6000;
  while (!condition()) { assert(performance.now() < end, message); await tick(); }
}

export async function verifyWorkspaceCanvas(native: FixtureNative) {
  const oldApi = window.electronApi, savedLayout = localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
  const oldAppearance = document.documentElement.getAttribute("data-appearance");
  const getItem = Storage.prototype.getItem, setItem = Storage.prototype.setItem;
  let deviceRequests = 0;
  window.electronApi = new Proxy({} as typeof window.electronApi, { get: (_target, key) => () => {
    deviceRequests++; throw new Error(`Fixture prohibits device request ${String(key)}`);
  } });
  const host = document.createElement("div"); document.body.append(host);
  Object.assign(host.style, { width: "100%", maxWidth: "1440px", height: "100vh", overflow: "auto" });
  let mounted = createRoot(host);
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const result = host.querySelector<T>(selector) ?? document.querySelector<T>(selector);
    assert(result, `missing ${selector}`); return result;
  };
  const click = async (selector: string) => { flushSync(() => get(selector).click()); await settle(); };
  const input = async (events: NativeInput[]) => { await native.input(events); await settle(); };
  const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const drag = async (start: { x: number; y: number }, dx: number, dy = 0, modifiers: string[] = []) => {
    await input([{ type: "mouseMove", ...start }, { type: "mouseDown", ...start, button: "left", clickCount: 1, modifiers },
      ...[.2, .4, .6, .8, 1].map(fraction => ({ type: "mouseMove", x: start.x + dx * fraction, y: start.y + dy * fraction, modifiers: [...modifiers, "leftButtonDown"] })),
      { type: "mouseUp", x: start.x + dx, y: start.y + dy, button: "left", clickCount: 1, modifiers }]);
  };
  function LayoutHarness() {
    const layout = useWorkspaceLayout();
    return <div className="workspace-layout-fixture" style={{ padding: 20 }}>
      <div data-layout-grid style={{ display: "grid", gridTemplateColumns: "var(--tree-pane-width, 306px) 5px minmax(0, 1fr)", width: "calc(100vw - 40px)", height: 180 }}>
        <aside style={{ minWidth: 0, background: "var(--ref-sidebar)" }}>层级树</aside>
        <TreePaneResizer width={layout.workspaceLayout.treeWidth} onWidthChange={value => layout.saveWorkspaceLayout({ ...layout.workspaceLayout, treeWidth: value })} />
        <div style={{ minWidth: 0, background: "#101214" }}>画布</div>
      </div>
      <WorkspaceLayoutPreferences layout={layout.workspaceLayout} onReset={layout.resetWorkspaceLayout} error={layout.workspaceLayoutError} />
      <button type="button" data-save-inspector onClick={() => layout.saveWorkspaceLayout({ ...layout.workspaceLayout,
        inspector: { floating: true, rect: { left: 700, top: 40, width: 360, height: 540 } } })}>记住浮窗样例</button>
      <output data-layout-state>{JSON.stringify(layout.workspaceLayout)}</output>
    </div>;
  }
  const mountLayout = async () => { flushSync(() => mounted.render(<StrictMode><LayoutHarness /></StrictMode>)); await settle(); };
  const remountLayout = async () => { flushSync(() => mounted.unmount()); mounted = createRoot(host); await mountLayout(); };
  const layoutState = () => JSON.parse(get("[data-layout-state]").textContent!);
  const scenarios: string[] = [];
  try {
    localStorage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY); await mountLayout();
    assert(get(".tree-pane-resizer").getAttribute("aria-valuenow") === "306", "default tree width changed");
    const separator = get(".tree-pane-resizer");
    await drag(rect(separator), 120);
    const preferred = layoutState().treeWidth;
    assert(preferred > 306 && localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)?.includes(String(preferred)), `native resize was not saved on release (preference ${preferred}, display ${separator.getAttribute("aria-valuenow")})`);
    get("[data-layout-grid]").style.width = "480px"; await settle();
    assert(Number(separator.getAttribute("aria-valuenow")) <= 211 && layoutState().treeWidth === preferred, "window clamping overwrote the preferred tree width");
    get("[data-layout-grid]").style.width = "calc(100vw - 40px)"; await settle();
    assert(Number(separator.getAttribute("aria-valuenow")) === preferred, "wide tree width did not return after temporary clamping");
    await click("[data-save-inspector]"); await remountLayout();
    assert(layoutState().treeWidth === preferred && layoutState().inspector.floating && layoutState().inspector.rect.width === 360, "remount did not restore persisted tool geometry");
    get(".tree-pane-resizer").focus();
    flushSync(() => get(".tree-pane-resizer").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", isComposing: true, bubbles: true })));
    assert(layoutState().treeWidth === preferred, "IME navigation changed the preferred layout");
    await input([{ type: "keyDown", keyCode: "Right" }, { type: "keyUp", keyCode: "Right" }]);
    assert(layoutState().treeWidth === preferred + 10, "native keyboard resizing failed");
    await native.checkpoint("layout-restored");
    localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, '{"version":1,"treeWidth":9999}'); await remountLayout();
    assert(layoutState().treeWidth === 306 && get(".preferences-workspace-layout [role=status]").textContent?.includes("无法读取"), "bad saved layout did not use a visible default");
    Storage.prototype.getItem = function(key) { if (key === WORKSPACE_LAYOUT_STORAGE_KEY) throw new Error("fixture read failure"); return getItem.call(this, key); };
    await remountLayout();
    assert(get(".preferences-workspace-layout [role=status]").textContent?.includes("无法访问"), "storage read error was hidden");
    Storage.prototype.getItem = getItem;
    Storage.prototype.setItem = function(key, value) { if (key === WORKSPACE_LAYOUT_STORAGE_KEY) throw new Error("fixture write failure"); return setItem.call(this, key, value); };
    await click("[data-save-inspector]");
    assert(layoutState().inspector.floating && get(".preferences-workspace-layout [role=status]").textContent?.includes("保存失败"), "write error discarded the current-window preference or was hidden");
    await click(".preferences-workspace-layout button");
    assert(layoutState().treeWidth === 306 && !layoutState().inspector.floating && layoutState().inspector.rect === null
      && get(".preferences-workspace-layout [role=status]").textContent?.includes("保存失败"), "reset did not apply a safe default after write failure");
    Storage.prototype.setItem = setItem;
    await click(".preferences-workspace-layout button"); await remountLayout();
    assert(!host.querySelector(".preferences-workspace-layout .preferences-error")?.getClientRects().length, "successful save did not clear the previous error");
    scenarios.push("native tree drag and keyboard; remount; narrow/wide preference retention; corrupt/denied storage; reset");

    const make = (id: string, left: number, top: number, right: number, bottom: number): UiNode => ({ ...makeNode(id), text: id,
      bounds: { left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` } });
    const root = make("zoom-root", 0, 0, 400, 320), a = make("zoom-A", 20, 40, 180, 120), b = make("zoom-B", 220, 150, 380, 250);
    root.children = [a, b];
    const bitmap = document.createElement("canvas"); bitmap.width = 400; bitmap.height = 320;
    const paint = bitmap.getContext("2d")!; paint.fillStyle = "#182029"; paint.fillRect(0, 0, 400, 320);
    for (const [node, color] of [[a, "#4e8aff"], [b, "#e69252"]] as const) { paint.fillStyle = color; const bounds = node.bounds!; paint.fillRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top); }
    const src = bitmap.toDataURL("image/png");
    function NodeProbe({ select }: { select: (node: UiNode) => void }) {
      const { publishHover, clearHover } = useNodeHoverActions();
      return <div>{[a, b].map(node => <button data-probe-node={node.id} type="button" key={node.id}
        onMouseEnter={() => publishHover(node.id, "tree")} onMouseLeave={() => clearHover("tree")} onClick={() => select(node)}>{node.id}</button>)}</div>;
    }
    function CanvasHarness() {
      const [selected, setSelected] = useState<UiNode>(a), [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
      return <NodeHoverProvider root={root} sessionKey="zoom-fixture"><div className="app-shell inspection-active" style={{ height: "100vh", width: "100%" }}>
        <div className="inspection-header"><NodeProbe select={setSelected} /><div className="scene-toolbar-host workbench-scene-tools" ref={setToolbar} /></div>
        <div className="preview-pane" style={{ position: "relative", flex: "1", minHeight: 0 }}>
          <ScreenshotPreview root={root} selectedNode={selected} src={src} sessionKey="zoom-fixture" expandedNodeIds={new Set([root.id])}
            toolbarHost={toolbar} measurementSnapshot={{ id: "zoom-fixture" }} onSelect={setSelected} />
          <output data-zoom-selected hidden>{selected.id}</output>
        </div>
      </div></NodeHoverProvider>;
    }
    flushSync(() => mounted.unmount()); mounted = createRoot(host);
    flushSync(() => mounted.render(<CanvasHarness />)); await settle();
    await until(() => get<HTMLImageElement>(".screenshot-stage img").naturalWidth > 0 && !get<HTMLButtonElement>(".pin-layer-measurement").disabled, "canvas did not become ready");
    await click(".view-mode-toggle button:first-child");
    const frame = () => get(".screenshot-frame"), image = () => get<HTMLImageElement>(".screenshot-stage img");
    const preset = async (value: number) => {
      flushSync(() => { const element = get<HTMLSelectElement>(".zoom-preset-select"); element.value = String(value); element.dispatchEvent(new Event("change", { bubbles: true })); }); await settle();
    };
    const visibleCenter = () => {
      const r = frame().getBoundingClientRect(), data = frame().dataset;
      return { x: r.left + Number(data.viewportLeft) + Number(data.viewportWidth) / 2,
        y: r.top + Number(data.viewportTop) + Number(data.viewportHeight) / 2 };
    };
    const imagePoint = (point: { x: number; y: number }) => {
      const r = image().getBoundingClientRect(); return { x: (point.x - r.left) / r.width * 400, y: (point.y - r.top) / r.height * 320 };
    };
    const closeSlider = async () => { await input([{ type: "keyDown", keyCode: "Escape" }, { type: "keyUp", keyCode: "Escape" }]); };
    const rangeDrag = async (from: number, to: number) => {
      if (!get<HTMLDetailsElement>(".zoom-continuous").open) await click(".zoom-continuous-toggle");
      const range = get<HTMLInputElement>(".zoom-continuous-popup input"), r = range.getBoundingClientRect();
      assert(document.activeElement === range, "opening the slider did not focus keyboard adjustment");
      await drag({ x: r.left + 8 + (r.width - 16) * from, y: r.top + r.height / 2 }, (r.width - 16) * (to - from));
      assert(!frame().dataset.gesture, "native slider drag started a canvas gesture");
      return Number(range.value);
    };
    await preset(4);
    const center = visibleCenter(), before = imagePoint(center);
    const percent = await rangeDrag(.25, .4), after = imagePoint(center);
    assert(percent > 400 && get(".zoom-readout").textContent === `${percent}%`, "native range dragging did not update the real screenshot");
    assert(Math.abs(after.x - before.x) < .7 && Math.abs(after.y - before.y) < .7, "2D continuous zoom drifted from the visible center");
    const bounds = a.bounds!, im = image().getBoundingClientRect(), outline = get(".selection-overlay").getBoundingClientRect();
    assert(Math.abs(outline.left - (im.left + bounds.left / 400 * im.width)) < .15
      && Math.abs(outline.top - (im.top + bounds.top / 320 * im.height)) < .15, "slider zoom separated selected-node outline from pixels");
    await input([{ type: "keyDown", keyCode: "Left" }, { type: "keyUp", keyCode: "Left" }]);
    assert(Number(get<HTMLInputElement>(".zoom-continuous-popup input").value) === percent - 1, "native slider keyboard did not adjust by one percent");
    flushSync(() => get(".zoom-continuous-popup input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true })));
    assert(get<HTMLDetailsElement>(".zoom-continuous").open, "IME Escape closed the slider");
    await native.checkpoint("flat-continuous-zoom"); await closeSlider();
    assert(!document.querySelector(".zoom-continuous-popup") && document.activeElement === get(".zoom-continuous-toggle"), "Escape did not close the slider and restore its toggle");
    await click(".zoom-fit"); await click(".pin-layer-measurement");
    flushSync(() => get('[data-probe-node="zoom-B"]').dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))); await settle();
    await click(".measurement-pin");
    const pair = () => get(".measurement-card").dataset, values = () => get(".measurement-card-values").textContent;
    assert(pair().measurementMode === "fixed" && pair().measurementAnchor === a.id && pair().measurementTarget === b.id, "fixture did not pin a real A/B pair");
    const originalValues = values(), originalSelected = get("[data-zoom-selected]").textContent;
    await rangeDrag(.1, .2); await closeSlider();
    assert(pair().measurementMode === "fixed" && values() === originalValues, "2D continuous zoom or closing its popover changed original-pixel measurement");
    await click(".view-mode-3d");
    await until(() => get<HTMLCanvasElement>(".layer-webgl-canvas").dataset.layerRenderer === "webgl", "3D renderer did not become ready");
    const r = frame().getBoundingClientRect();
    const initialAngle = `${frame().dataset.cameraPaintAzimuth}/${frame().dataset.cameraPaintElevation}`;
    await drag({ x: r.left + 50, y: r.top + 60 }, 80, 32);
    await drag({ x: r.left + 50, y: r.top + 60 }, 45, 22, ["shift"]);
    const angle = `${frame().dataset.cameraPaintAzimuth}/${frame().dataset.cameraPaintElevation}`, pan = get(".layer-scene").style.transform;
    assert(frame().dataset.cameraPaintAzimuth && frame().dataset.cameraPaintElevation
      && angle !== initialAngle
      && pan !== "translate3d(0px, 0px, 0px)", "native 3D fixture failed to establish orbit and pan");
    await rangeDrag(.2, .3);
    assert(`${frame().dataset.cameraPaintAzimuth}/${frame().dataset.cameraPaintElevation}` === angle && get(".layer-scene").style.transform === pan, "3D slider reset orbit or pan");
    assert(pair().measurementMode === "fixed" && values() === originalValues && get("[data-zoom-selected]").textContent === originalSelected, "3D continuous zoom changed selected identity or fixed A/B source pixels");
    await native.checkpoint("layers3d-continuous-zoom");
    flushSync(() => window.dispatchEvent(new Event("blur"))); await settle();
    assert(!document.querySelector(".zoom-continuous-popup") && !frame().dataset.gesture && pair().measurementMode === "fixed", "window blur left a slider gesture or cleared fixed A/B");
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.appearance = theme; host.style.width = "360px"; await settle(); await click(".zoom-continuous-toggle");
      const popup = get(".zoom-continuous-popup").getBoundingClientRect(), toggle = get(".zoom-continuous-toggle").getBoundingClientRect();
      assert(popup.left >= 0 && popup.right <= window.innerWidth && popup.top >= toggle.bottom
        && popup.top >= get(".screenshot-view-toolbar").getBoundingClientRect().bottom, "narrow slider escaped the window or covered toolbar controls");
      assert(get<HTMLSelectElement>(".zoom-preset-select").getClientRects().length > 0 && get(".zoom-fit").getClientRects().length > 0, "narrow tools hid presets or fit");
      await native.checkpoint(`${theme}-narrow-zoom`); await closeSlider();
    }
    scenarios.push("native continuous range drag and keyboard; flat center/selection alignment; IME/Escape/blur; real 3D orbit/pan; fixed A/B; narrow light/dark controls");
    assert(deviceRequests === 0, "local UI interactions requested device data");
    return { scenarios, deviceRequests, source: "Actual components and local fixture pixels, native Electron pointer and keyboard input; no physical DPI claim." };
  } catch (error) { await native.checkpoint("failure-before-cleanup"); throw error; }
  finally {
    flushSync(() => mounted.unmount()); host.remove();
    Storage.prototype.getItem = getItem; Storage.prototype.setItem = setItem;
    if (savedLayout === null) localStorage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY); else localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, savedLayout);
    if (oldAppearance === null) document.documentElement.removeAttribute("data-appearance"); else document.documentElement.setAttribute("data-appearance", oldAppearance);
    window.electronApi = oldApi;
  }
}

Object.assign(window, { verifyWorkspaceCanvas });
