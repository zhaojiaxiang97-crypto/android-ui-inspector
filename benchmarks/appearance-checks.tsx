import { StrictMode, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { APPEARANCE_STORAGE_KEY, type AppearancePreference } from "../shared/appearance";
import { buildLayerRecords } from "../shared/layer-layout";
import { DEFAULT_COLOR_ALIASES } from "../shared/inspector-colors";
import { DEFAULT_TREE_COLLAPSE } from "../shared/tree-collapse";
import type { UiNode } from "../shared/types";
import { NodePropertiesPanel } from "../src/components/NodePropertiesPanel";
import { PreferencesPanel } from "../src/components/PreferencesPanel";
import { UiTree } from "../src/components/UiTree";
import { useAppearance } from "../src/features/inspection/useAppearance";
import { MeasurementCard } from "../src/features/layers/MeasurementCard";
import { EMPTY_LAYER_MEASUREMENT, useLayerMeasurement } from "../src/features/layers/useLayerMeasurement";
import { ScreenshotPreview } from "./screenshot-preview-fixture";
import { makeNode } from "./fixtures";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/workbench.css";
import "../src/styles/entry.css";
import "../src/styles/appearance.css";

const bounds = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` });
const fixture: UiNode = { ...makeNode("0"), text: "外观检查样例", bounds: bounds(0, 0, 200, 400), children: [
  { ...makeNode("0/0", 1), text: "精选", bounds: bounds(20, 60, 180, 100), attributes: { "inspection-source": "debug-qml", "background-color": "#4285f4", "border-color": "#dddddd" } },
  { ...makeNode("0/1", 2), text: "推荐内容", bounds: bounds(20, 180, 180, 220) },
] };
const records = buildLayerRecords(fixture, fixture.children[0], { width: 200, height: 400 }, { scope: "all" });

/** Uses real tree, inspector, dialog and screenshot components with local fixture pixels.
 * The measurement owner runs independently of GPU availability; this checks state retention,
 * not WebGL rendering. No App/device bridge is needed or contacted. */
export async function verifyAppearance(checkpoint?: (name: string) => Promise<void>) {
  const originalPreference = localStorage.getItem(APPEARANCE_STORAGE_KEY);
  const originalAttribute = document.documentElement.getAttribute("data-appearance");
  const originalMatchMedia = window.matchMedia;
  const originalSetItem = Storage.prototype.setItem, originalGetItem = Storage.prototype.getItem;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let osDark = false, deviceReads = 0;
  const media = {
    get matches() { return osDark; }, media: "(prefers-color-scheme: dark)", onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.add(listener),
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.delete(listener),
  } as unknown as MediaQueryList;
  window.matchMedia = query => query === media.media ? media : originalMatchMedia.call(window, query);
  const source = document.createElement("canvas"); source.width = 200; source.height = 400;
  const pixels = source.getContext("2d")!;
  pixels.fillStyle = "#ffffff"; pixels.fillRect(0, 0, 200, 400);
  pixels.fillStyle = "#4285f4"; pixels.fillRect(20, 60, 160, 40);
  pixels.fillStyle = "#f0c05a"; pixels.fillRect(20, 180, 160, 40);
  pixels.clearRect(0, 380, 200, 20);
  const src = source.toDataURL("image/png"), sourcePixels = Array.from(pixels.getImageData(0, 0, 200, 400).data).join(",");
  const host = document.createElement("div"); document.body.append(host);
  let app = createRoot(host);
  const check = (value: unknown, message: string) => { if (!value) throw new Error(`Appearance: ${message}`); };
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
  function Harness() {
    const theme = useAppearance();
    const [preferences, setPreferences] = useState(false), [measurementOpen, setMeasurementOpen] = useState(false);
    const [selected, setSelected] = useState(fixture.children[0]);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(["0"]));
    const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
    const [measurement, setMeasurement] = useState(EMPTY_LAYER_MEASUREMENT);
    const measuring = useLayerMeasurement({ context: fixture, src, records, selected: records.find(value => value.id === selected.id),
      hovered: records.find(value => value.id === "0/1"), ready: true, onChange: setMeasurement });
    return <div className="app-shell inspection-active">
      <header className="inspection-header">
        <div className="workbench-device-tools">
          <button className="workbench-tool-button" type="button" data-open-preferences onClick={() => setPreferences(true)}>偏好设置</button>
          <button className="workbench-tool-button" type="button" data-pin-pair onClick={measuring.toggleMeasurementPin}>固定 A/B</button>
          <button className="workbench-tool-button" type="button" data-show-measurement onClick={() => setMeasurementOpen(value => !value)}>测距详情</button>
        </div><div className="scene-toolbar-host workbench-scene-tools" ref={setToolbarHost} />
      </header>
      <main className="workspace"><section className="inspector-panel"><div className="inspector-grid">
        <aside className="tree-pane"><UiTree root={fixture} filteredRoot={fixture} filterActive={false} filterKey="appearance"
          selectedId={selected.id} expanded={expanded} onExpandedChange={setExpanded} onSelect={setSelected} onClearFilter={() => {}} /></aside>
        <div className="preview-pane">
          <ScreenshotPreview src={src} sessionKey="appearance-fixture" root={fixture} selectedNode={selected} expandedNodeIds={expanded}
            onSelect={setSelected} toolbarHost={toolbarHost} />
          <div style={{ display: measurementOpen ? "none" : undefined }}><NodePropertiesPanel root={fixture} node={selected}
            screenshotSize={{ width: 200, height: 400 }} docked toolbarHost={null} onCopy={() => {}} copyStatus={null}
            onReadStyle={async () => { deviceReads++; throw new Error("Theme must not request device styles"); }} children={null} /></div>
          {measurementOpen && <MeasurementCard state={measurement} root={fixture} viewport={{ left: 0, top: 0, width: 520, height: 600 }} selectionDisabled={false}
            onClear={() => setMeasurementOpen(false)} onPick={measuring.beginMeasurement} onUseSelected={measuring.useSelectedMeasurementNode}
            onPin={measuring.toggleMeasurementPin} onLive={measuring.startMeasurementMode} />}
          <output hidden data-theme-state data-selected={selected.id} data-measurement={JSON.stringify(measurement)}>{JSON.stringify(fixture)}</output>
        </div>
      </div></section></main>
      {preferences && <PreferencesPanel doubleClickAction="expand" onChange={() => {}} treeCollapsePreference={DEFAULT_TREE_COLLAPSE}
        onCollapseChange={() => {}} onApplyCollapse={() => {}} canApplyCollapse colorAliases={DEFAULT_COLOR_ALIASES} onSaveColorAliases={() => true}
        appearance={theme.appearance} resolvedAppearance={theme.resolvedAppearance} onAppearanceChange={theme.saveAppearance}
        appearanceSaveError={theme.appearanceSaveError} onClose={() => setPreferences(false)} />}
    </div>;
  }
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const value = host.querySelector<T>(selector); check(value, `missing ${selector}`); return value!;
  };
  const click = async (selector: string) => { flushSync(() => get(selector).click()); await settle(); };
  const mount = async () => { flushSync(() => app.render(<StrictMode><Harness /></StrictMode>)); await settle(); await get<HTMLImageElement>('.screenshot-stage img').decode(); };
  const remount = async () => { flushSync(() => app.unmount()); app = createRoot(host); await mount(); };
  const change = async (value: AppearancePreference) => {
    if (!host.querySelector('[aria-label="界面外观"]')) await click("[data-open-preferences]");
    flushSync(() => {
      const select = get<HTMLSelectElement>('[aria-label="界面外观"]'); select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }); await settle();
  };
  const setSystem = async (dark: boolean) => {
    osDark = dark;
    flushSync(() => listeners.forEach(listener => typeof listener === "function" ? listener(new Event("change")) : listener.handleEvent(new Event("change"))));
    await settle();
  };
  const rgba = (color: string) => { const values = color.match(/[\d.]+/g)!.map(Number); return [...values.slice(0, 3), values[3] ?? 1]; };
  const luminance = (color: number[]) => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const contrast = (selector: string) => {
    const element = get(selector), ancestors: Element[] = [];
    for (let parent: Element | null = element; parent; parent = parent.parentElement) ancestors.unshift(parent);
    let background = [255, 255, 255];
    for (const parent of ancestors) { const color = rgba(getComputedStyle(parent).backgroundColor); background = background.map((value, index) => value * (1 - color[3]) + color[index] * color[3]); }
    const a = luminance(rgba(getComputedStyle(element).color)), b = luminance(background);
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    check(ratio >= 4.5, `${selector} contrast ${ratio.toFixed(2)} is below 4.5`); return Number(ratio.toFixed(2));
  };
  try {
    localStorage.removeItem(APPEARANCE_STORAGE_KEY); await mount();
    check(document.documentElement.dataset.appearance === "dark" && listeners.size === 0, "first use should remain dark regardless of OS");
    await click("[data-pin-pair]");
    const initial = get("[data-theme-state]").outerHTML, image = get<HTMLImageElement>(".screenshot-stage img");
    const overlay = get(".selection-overlay"), initialOverlay = getComputedStyle(overlay).boxShadow;
    const verifyUnchanged = () => {
      check(get("[data-theme-state]").outerHTML === initial, "appearance changed selected node, snapshot or fixed A/B values");
      check(get<HTMLImageElement>(".screenshot-stage img") === image && image.src === src, "appearance remounted or replaced screenshot");
      check(getComputedStyle(get(".screenshot-frame")).backgroundColor === "rgb(16, 18, 20)", "inspection canvas lost its neutral background");
      check(getComputedStyle(overlay).boxShadow === initialOverlay, "appearance changed selection overlay colors");
      for (let element: HTMLElement | null = image; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        check(style.filter === "none" && style.opacity === "1" && style.mixBlendMode === "normal", "appearance alters image presentation");
      }
      const decoded = document.createElement("canvas"); decoded.width = 200; decoded.height = 400;
      const context = decoded.getContext("2d")!; context.drawImage(image, 0, 0);
      check(Array.from(context.getImageData(0, 0, 200, 400).data).join(",") === sourcePixels, "decoded RGBA pixels changed");
    };
    check(JSON.parse(get("[data-theme-state]").dataset.measurement!).pinned, "fixture did not establish a fixed A/B pair");
    const ratios: Record<string, Record<string, number>> = {};
    for (const theme of ["light", "dark"] as const) {
      await change(theme);
      check(document.documentElement.dataset.appearance === theme && localStorage.getItem(APPEARANCE_STORAGE_KEY) === theme, "theme did not apply and persist immediately");
      verifyUnchanged();
      ratios[theme] = Object.fromEntries([".preferences-appearance label", ".preferences-appearance p", ".preferences-appearance select"]
        .map(selector => [selector, contrast(selector)]));
      const dialog = get(".preferences-panel"); check(dialog.scrollWidth <= dialog.clientWidth + 1, "preferences overflow horizontally");
      await checkpoint?.(`${theme}-preferences`);
      await click('[aria-label="关闭偏好设置"]');
      for (const selector of [".inspection-header", ".tree-row.selected .tree-primary", ".inspector-node-heading h4", ".inspector-geometry dd"])
        ratios[theme][selector] = contrast(selector);
      verifyUnchanged(); await checkpoint?.(`${theme}-workbench`);
      await click("[data-show-measurement]");
      ratios[theme][".measurement-card"] = contrast(".measurement-card");
      ratios[theme][".measurement-image-note"] = contrast(".measurement-image-note");
      verifyUnchanged(); await checkpoint?.(`${theme}-measurement`); await click("[data-show-measurement]");
    }
    await change("system");
    check(listeners.size === 1 && document.documentElement.dataset.appearance === "light", "system choice did not subscribe or resolve current OS");
    await setSystem(true);
    check(document.documentElement.dataset.appearance === "dark" && localStorage.getItem(APPEARANCE_STORAGE_KEY) === "system", "OS event changed preference or failed to apply");
    verifyUnchanged(); await setSystem(false); verifyUnchanged();
    check(document.documentElement.dataset.appearance === "light", "second OS change failed");
    await change("dark"); await setSystem(true); await setSystem(false);
    check(document.documentElement.dataset.appearance === "dark" && listeners.size === 0, "explicit choice still follows system events");
    Storage.prototype.setItem = function (key, value) { if (key === APPEARANCE_STORAGE_KEY) throw new Error("fixture storage denied"); return originalSetItem.call(this, key, value); };
    await change("light");
    check(document.documentElement.dataset.appearance === "light", "save failure blocked in-window application");
    const warning = get(".preferences-appearance [role=status]").textContent!;
    check(warning.includes("保存失败") && !warning.includes("已保存"), "failed save falsely reports success");
    check(originalGetItem.call(localStorage, APPEARANCE_STORAGE_KEY) === "dark", "failed storage unexpectedly overwrote preference");
    verifyUnchanged(); Storage.prototype.setItem = originalSetItem;
    await change("system"); await remount();
    check(document.documentElement.dataset.appearance === "light" && listeners.size === 1, "remount did not restore system preference or leaked listeners");
    await setSystem(true); check(document.documentElement.dataset.appearance === "dark", "restored system preference stopped listening");
    Storage.prototype.getItem = function (key) { if (key === APPEARANCE_STORAGE_KEY) throw new Error("fixture storage denied"); return originalGetItem.call(this, key); };
    await remount(); check(document.documentElement.dataset.appearance === "dark" && listeners.size === 0, "unreadable local storage did not safely default");
    Storage.prototype.getItem = originalGetItem;
    check(deviceReads === 0, "theme requested device properties");
    flushSync(() => app.unmount());
    check(listeners.size === 0 && document.documentElement.getAttribute("data-appearance") === originalAttribute, "unmount leaked listener or root appearance");
    return { passed: true, fixtureOnly: true, deviceReads, viewport: { width: innerWidth, height: innerHeight }, contrast: ratios,
      checks: ["default dark", "immediate save and restore", "system changes and listener cleanup", "storage failures", "unchanged selected node / snapshot / fixed A-B", "same screenshot element and decoded RGBA", "neutral canvas and overlay colors", "readable tree / inspector / dialog / measurement"] };
  } finally {
    flushSync(() => app.unmount()); host.remove();
    window.matchMedia = originalMatchMedia; Storage.prototype.setItem = originalSetItem; Storage.prototype.getItem = originalGetItem;
    if (originalPreference === null) localStorage.removeItem(APPEARANCE_STORAGE_KEY); else localStorage.setItem(APPEARANCE_STORAGE_KEY, originalPreference);
    if (originalAttribute === null) document.documentElement.removeAttribute("data-appearance"); else document.documentElement.setAttribute("data-appearance", originalAttribute);
  }
}
