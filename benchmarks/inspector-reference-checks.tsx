import { StrictMode, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { COLOR_DISPLAY_STORAGE_KEY, type ColorDisplayFormat } from "../shared/color-display";
import { parseColorAliasText } from "../shared/inspector-colors";
import type { UiNode } from "../shared/types";
import { ColorDisplayPreferences } from "../src/components/ColorDisplayPreferences";
import { ColorProperty } from "../src/components/ColorProperty";
import { NodePropertiesPanel } from "../src/components/NodePropertiesPanel";
import { useColorDisplay } from "../src/features/inspection/useColorDisplay";
import { indexInspectorProperties } from "../src/features/inspection/inspector-search-index";
import { searchInspectorProperties } from "../shared/inspector-search";
import { makeNode } from "./fixtures";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/workbench.css";
import "../src/styles/appearance.css";
import "../src/styles/measurement-card.css";

const originalText = "  固定参考的完整文本\n保留换行和末尾空格  ";
const aliases = parseColorAliasText("rgba(18,52,86,0.5) = 半透明品牌色").preference!;
const makeFixture = (): UiNode => ({ ...makeNode("root"), children: [
  { ...makeNode("a"), text: originalText, className: "example.AlphaView", bounds: { left: 24, top: 72, right: 300, bottom: 124, raw: "[24,72][300,124]" },
    attributes: { "view-ref": "View@a", "inspection-source": "debug-qml", "background-color": "rgba(18,52,86,0.5)", "border-color": "rgba(20,40,60,0)" } },
  { ...makeNode("b"), text: "当前控件 B", className: "example.BetaView", bounds: { left: 4, top: 170, right: 104, bottom: 200, raw: "[4,170][104,200]" },
    attributes: { "view-ref": "View@b", "inspection-source": "debug-view" } },
] });

/** Real inspector, preference and search rendering with local data; no device bridge is contacted. */
export async function verifyInspectorReference(checkpoint?: (name: string) => Promise<void>) {
  const originalPreference = localStorage.getItem(COLOR_DISPLAY_STORAGE_KEY), originalTheme = document.documentElement.getAttribute("data-appearance");
  const originalSet = Storage.prototype.setItem, originalGet = Storage.prototype.getItem;
  const host = document.createElement("div"); document.body.append(host);
  let renderer = createRoot(host), deviceReads = 0, lastRoot = makeFixture();
  const copies: { label: string; value: string }[] = [];
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(`Inspector reference: ${message}`); };
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => { const item = host.querySelector<T>(selector) ?? document.querySelector<T>(`body > .inspector-group-popup ${selector}`); check(item, `missing ${selector}`); return item!; };
  const click = async (selector: string) => { flushSync(() => get(selector).click()); await settle(); };
  let setBusy!: (value: boolean) => void;
  function Harness() {
    const preferences = useColorDisplay();
    const [root, setRoot] = useState(makeFixture), [selected, setSelected] = useState(0), [session, setSession] = useState(1), [busy, updateBusy] = useState(false);
    lastRoot = root; setBusy = updateBusy;
    return <div className="app-shell inspection-active" style={{ height: "100vh", padding: 16 }}>
      <div style={{ display: "flex", gap: 8, height: "100%" }}>
        <div style={{ width: 320, minWidth: 0, overflow: "auto" }}>
          <button data-select-a onClick={() => setSelected(0)}>选择 A</button><button data-select-b onClick={() => setSelected(1)}>选择 B</button>
          <button data-refresh onClick={() => setRoot(current => ({ ...current, children: current.children.map(node => node.id === "a" ? { ...node, text: "刷新后的 A" } : node) }))}>局部刷新</button>
          <button data-replace onClick={() => setRoot(current => ({ ...current, children: current.children.map(node => node.id === "a" ? { ...node, attributes: { ...node.attributes, "view-ref": "replacement" } } : node) }))}>替换身份</button>
          <button data-new-session onClick={() => setSession(value => value + 1)}>新快照</button>
          <ColorDisplayPreferences format={preferences.colorFormat} onChange={preferences.saveColorFormat} saveError={preferences.colorFormatSaveError} />
          <dl data-unknown><ColorProperty label="未知颜色" raw="#80123456" aliases={aliases} format={preferences.colorFormat} onCopy={(label, value) => copies.push({ label, value })} /></dl>
          <dl data-android><ColorProperty label="Android 色" raw="#80123456" encoding="android-argb" aliases={aliases} format={preferences.colorFormat} onCopy={(label, value) => copies.push({ label, value })} /></dl>
        </div>
        <div className="preview-pane" style={{ flex: "1 1 auto", height: "100%", minWidth: 0, position: "relative" }}>
          <NodePropertiesPanel root={root} node={root.children[selected]} imageSessionKey={session} screenshotSize={null} toolbarHost={null} docked
            onCopy={() => {}} copyStatus={null} onCopyValue={(label, value) => copies.push({ label, value })} colorAliases={aliases}
            colorFormat={preferences.colorFormat} onColorFormatChange={preferences.saveColorFormat} colorFormatSaveError={preferences.colorFormatSaveError}
            referenceSnapshot={{ id: "offline-fixture", capturedAt: "2026-10-13T01:00:00Z", label: "离线快照样例" }} navigationDisabled={busy}
            onReadStyle={async () => { deviceReads++; return { ref: "View@a", capturedAtMillis: 1_792_000_000_000, backgroundType: "ColorDrawable", backgroundColor: "#80123456", textColor: "#FF010203", textSizePx: 14 }; }}>
            <dl className="node-attributes-list"><div><dt>已有原始属性</dt><dd>fixture</dd></div></dl>
          </NodePropertiesPanel>
        </div>
      </div>
    </div>;
  }
  const mount = async () => { flushSync(() => renderer.render(<StrictMode><Harness /></StrictMode>)); await settle(); };
  const remount = async () => { flushSync(() => renderer.unmount()); renderer = createRoot(host); await mount(); };
  const format = async (value: ColorDisplayFormat) => {
    flushSync(() => { const select = get<HTMLSelectElement>('[aria-label="默认颜色格式"]'); select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }); await settle();
  };
  const search = async (value: string) => {
    flushSync(() => { const input = get<HTMLInputElement>('[aria-label="搜索属性"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); await settle();
  };
  const panelFormat = async () => {
    await click(".inspector-groups-open");
    const value = get<HTMLSelectElement>('[aria-label="属性颜色格式"]').value;
    await click(".inspector-group-popup-close");
    return value;
  };
  const color = () => get<HTMLElement>('.inspector-image [data-color-label="背景源色"]');
  try {
    localStorage.removeItem(COLOR_DISPLAY_STORAGE_KEY); await mount();
    const original = JSON.stringify(lastRoot);
    check(await panelFormat() === "hex", "default is not Hex");
    check(color().querySelector('.inspector-color-value')?.textContent?.includes("≈ #12345680"), "QML approximation is missing");
    check(!color().querySelector<HTMLDetailsElement>("details")!.open, "other formats are not folded by default");
    check(!get("[data-unknown]").querySelector(".inspector-color-swatch") && get("[data-unknown]").textContent?.includes("#80123456"), "unknown source guessed a color");
    for (const value of ["hex", "rgba", "raw"] as const) {
      await format(value);
      const expected = value === "hex" ? "≈ #12345680" : value === "rgba" ? "rgba(18, 52, 86, 0.5)" : "rgba(18,52,86,0.5)";
      check(color().querySelector('.inspector-color-value')?.textContent === expected, `wrong ${value} display`);
      check(localStorage.getItem(COLOR_DISPLAY_STORAGE_KEY) === value && await panelFormat() === value, "preference controls diverged");
      await click(`.inspector-image [data-color-label="背景源色"] > dd > .inspector-color-actions button`);
      check(copies.at(-1)?.value === expected.replace("≈ ", ""), `wrong ${value} copy`);
      for (const term of ["#12345680", "rgba(18, 52, 86, 0.5)", "rgba(18,52,86,0.5)", "半透明品牌色"]) {
        check(searchInspectorProperties(indexInspectorProperties(get(".floating-inspector")), term).results.length > 0, `index lost ${term}`);
        await search(term);
        check(get<HTMLDetailsElement>(".inspector-image").open && get<HTMLDetailsElement>(".inspector-image-details").open && color().querySelector<HTMLDetailsElement>("details")!.open, `search did not reveal ${term}`);
        if (value === "hex" && term === "rgba(18, 52, 86, 0.5)") {
          await click('.inspector-image [data-color-label="背景源色"] .inspector-color-details > summary');
          check(!color().querySelector<HTMLDetailsElement>("details")!.open, "manual search fold failed");
          const result = [...host.querySelectorAll<HTMLButtonElement>(".inspector-search-result")].find(button => button.querySelector("strong")?.textContent === "背景源色");
          check(result, "color search result missing"); flushSync(() => result!.click()); await settle();
          check(color().querySelector<HTMLDetailsElement>("details")!.open, "locate did not reopen manually folded color details");
        }
      }
      await search("");
    }
    check(JSON.stringify(lastRoot) === original && deviceReads === 0, "format/search mutated data or requested styles");
    await format("rgba"); await remount(); check(await panelFormat() === "rgba", "format was not restored");
    Storage.prototype.setItem = function(key, value) { if (key === COLOR_DISPLAY_STORAGE_KEY) throw new Error("fixture storage denied"); return originalSet.call(this, key, value); };
    await format("raw");
    check(await panelFormat() === "raw" && get('.preferences-color-display [role="status"]').textContent?.includes("保存失败"), "storage failure blocks current format or claims success");
    check(originalGet.call(localStorage, COLOR_DISPLAY_STORAGE_KEY) === "rgba", "failed storage overwrote the saved value");
    Storage.prototype.setItem = originalSet;
    localStorage.setItem(COLOR_DISPLAY_STORAGE_KEY, "corrupt"); await remount(); check(await panelFormat() === "hex", "bad preference did not fall back");
    Storage.prototype.getItem = function(key) { if (key === COLOR_DISPLAY_STORAGE_KEY) throw new Error("fixture storage denied"); return originalGet.call(this, key); };
    await remount(); check(await panelFormat() === "hex", "blocked preference read did not fall back"); Storage.prototype.getItem = originalGet;

    flushSync(() => setBusy(true)); await settle();
    check(get<HTMLButtonElement>(".inspector-reference-pin").disabled && get(".inspector-reference-pin-wrap").title.includes("正在更新"), "busy pin is enabled or unexplained");
    flushSync(() => setBusy(false)); await settle(); await click(".inspector-reference-pin");
    check(get(".inspector-pinned-reference").dataset.referenceStatus === "current", "reference did not pin");
    await click("[data-select-b]");
    check(get(".floating-inspector").dataset.nodeId === "b" && get(".inspector-reference-text pre").textContent === originalText, "A reference did not survive B selection");
    check(get(".inspector-reference-source").textContent?.includes("离线快照样例") && get(".inspector-reference-source").textContent?.includes("QML Debug"), "reference lost real source/snapshot metadata");
    await click(".inspector-reference-text button"); check(copies.at(-1)?.label === "参考文本" && copies.at(-1)?.value === originalText, "reference copy lost original text");
    for (const theme of ["dark", "light"]) for (const width of [340, 248]) {
      document.documentElement.dataset.appearance = theme; get(".floating-inspector").style.width = `${width}px`; await settle();
      for (const selector of [".floating-inspector", ".inspector-pinned-reference", ".inspector-reference-values"]) { const item = get(selector); check(item.scrollWidth <= item.clientWidth + 1, `${selector} overflow at ${theme}/${width}`); }
      check(get(".inspector-reference-values").clientHeight <= 202, "reference body is unbounded");
      await checkpoint?.(`${theme}-${width}`);
    }
    await click('[aria-label="收起固定参考"]'); check(get(".inspector-reference-values").hidden, "reference did not collapse"); await click('[aria-label="展开固定参考"]');
    const measurementFrame = document.createElement("div"); measurementFrame.className = "screenshot-frame";
    measurementFrame.dataset.measurementActive = "true"; measurementFrame.style.cssText = "position:absolute;width:1px;height:1px;min-height:0";
    get(".preview-pane").append(measurementFrame); await settle();
    check(getComputedStyle(get(".floating-inspector")).visibility === "hidden" && getComputedStyle(get(".inspector-pinned-reference")).visibility === "hidden", "reference did not yield with inspector to measurement");
    measurementFrame.remove(); await settle(); check(getComputedStyle(get(".inspector-pinned-reference")).visibility === "visible", "reference failed to return after measurement");
    await click("[data-refresh]"); check(get(".inspector-pinned-reference").dataset.referenceStatus === "stale" && get(".inspector-reference-text pre").textContent === originalText, "refresh replaced pinned values");
    await click("[data-replace]"); check(get(".inspector-pinned-reference").dataset.referenceStatus === "detached" && get(".inspector-reference-text pre").textContent === originalText, "same-position replacement stole reference identity");
    await click(".inspector-reference-pin"); check(get(".inspector-pinned-reference").dataset.referenceNode === "b" && get(".inspector-reference-text pre").textContent === "当前控件 B", "repin did not replace the single reference");
    const closer = get(".inspector-reference-close"); closer.focus();
    flushSync(() => closer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true }))); await settle(); check(host.querySelector(".inspector-pinned-reference"), "IME Escape closed reference");
    flushSync(() => closer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); await settle();
    check(!host.querySelector(".inspector-pinned-reference") && !get(".floating-inspector").hidden && document.activeElement === get(".inspector-reference-pin"), "reference Escape closed parent or lost focus");
    await click(".inspector-reference-pin"); await click("[data-new-session]"); check(!host.querySelector(".inspector-pinned-reference"), "new snapshot kept old reference");
    check(deviceReads === 0, "reference or color controls implicitly requested a device read");
    return { passed: true, fixtureOnly: true, deviceReads, viewport: { width: innerWidth, height: innerHeight }, checks: ["Hex/RGBA/raw persistence and failure", "all representations and alias search/reveal", "exact copy and alpha", "unknown source fallback", "A-B fixed reference", "refresh and detached identity", "repin and new session", "busy reason and scoped/IME Escape", "measurement inherits inspector avoidance", "dark/light 340/248px"] };
  } finally {
    flushSync(() => renderer.unmount()); host.remove(); Storage.prototype.setItem = originalSet; Storage.prototype.getItem = originalGet;
    if (originalPreference === null) localStorage.removeItem(COLOR_DISPLAY_STORAGE_KEY); else localStorage.setItem(COLOR_DISPLAY_STORAGE_KEY, originalPreference);
    if (originalTheme === null) document.documentElement.removeAttribute("data-appearance"); else document.documentElement.setAttribute("data-appearance", originalTheme);
  }
}
