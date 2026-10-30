import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { NodePropertiesPanel } from "../src/components/NodePropertiesPanel";
import { DEFAULT_INSPECTOR_GROUPS, type InspectorGroupPreference } from "../shared/inspector-groups";
import type { UiNode } from "../shared/types";
import { makeNode } from "./fixtures";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/workbench.css";
import "../src/styles/appearance.css";

/** Real inspector DOM, entirely from saved fixtures; no device API is installed. */
export async function verifyTextStyleProperties() {
  const host = document.createElement("div"); document.body.append(host);
  const renderer = createRoot(host), copies: { label: string; value: string }[] = [];
  let deviceReads = 0;
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(`Text style: ${message}`); };
  const settle = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const result = host.querySelector<T>(selector); check(result, `missing ${selector}`); return result!;
  };
  const click = async (selector: string) => { flushSync(() => get(selector).click()); await settle(); };
  const saved: UiNode = { ...makeNode("text", 1), attributes: {
    "view-ref": "TextView@a", "text-style-source": "view-debug", "text-size-px": "14.123456789",
    "text-typeface-style": "3", "text-color-argb": "#80123456", "text-gravity": "8388659",
    "text-ellipsize": "NONE", "text-alignment": "1", "text-direction": "6", "layout-direction": "2",
  } };
  const root: UiNode = { ...makeNode("root"), children: [saved] };
  const original = JSON.stringify(root);
  const render = async (node = saved, groups: InspectorGroupPreference = DEFAULT_INSPECTOR_GROUPS, live = true) => {
    flushSync(() => renderer.render(<div className="app-shell inspection-active" style={{ height: 800 }}>
      <div className="preview-pane" style={{ height: 780, width: 280, position: "relative" }}>
        <NodePropertiesPanel root={root} node={node} imageSessionKey="offline-text" screenshotSize={null} toolbarHost={null} docked
          onCopy={() => {}} copyStatus={null} onCopyValue={(label, value) => copies.push({ label, value })} inspectorGroups={groups}
          onReadStyle={live ? async () => { deviceReads++; return { ref: "TextView@a", capturedAtMillis: 1_792_000_000_000,
            backgroundType: null, backgroundColor: null, textColor: "#FF010203", textSizePx: 20 }; } : undefined}>
          {null}
        </NodePropertiesPanel>
      </div>
    </div>));
    await settle();
  };
  const search = async (query: string) => {
    flushSync(() => {
      const input = get<HTMLInputElement>('[aria-label="搜索属性"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }); await settle();
  };
  const result = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".inspector-search-result")]
    .find(button => button.querySelector("strong")?.textContent === label);
  const row = (key: string) => get<HTMLElement>(`.inspector-text-style [data-inspector-terms~="${key}"]`);
  try {
    await render();
    check(get<HTMLDetailsElement>(".inspector-image").open && get<HTMLDetailsElement>(".inspector-text-style").open, "saved styles are folded by default");
    check(row("text-size-px").textContent?.includes("14.123456789px"), "size was rounded or converted");
    check(row("text-typeface-style").textContent?.includes("粗斜体"), "style enum label missing");
    check(row("text-gravity").textContent?.includes("起始侧 · 上") && row("text-gravity").querySelector("dd")?.title === "8388659", "relative gravity or raw missing");
    check(get(".inspector-text-style").textContent?.includes("View Debug 快照属性"), "snapshot provenance missing");
    await click('[aria-label="复制字号"]'); check(copies.at(-1)?.value === "14.123456789px", "size copy lost precision or unit");
    await click('[aria-label="复制框内对齐"]'); check(copies.at(-1)?.value === "8388659", "gravity copy is not raw");
    for (const [query, label] of [["字号", "字号"], ["textSizePx", "字号"], ["typeface", "字体样式"], ["text-color-argb", "文字色"], ["textColor", "文字色"], ["ellipsize", "省略方式"], ["layoutDirection", "布局方向"]]) {
      await search(query); check(result(label), `search did not find ${query}`);
    }
    await search("textColor");
    flushSync(() => result("文字色")!.click()); await settle();
    check(row("text-color-argb").classList.contains("inspector-property-highlight"), "color search did not locate the actual row");
    await click('[aria-label="复制文字色原值"]'); check(copies.at(-1)?.value === "#80123456", "color source copy changed ARGB");
    await search("textSizePx");
    flushSync(() => result("字号")!.parentElement!.querySelector<HTMLButtonElement>(".inspector-search-result-copy")!.click());
    check(copies.at(-1)?.value === "14.123456789px", "search result copy changed size or unit");
    await search(""); await click(".inspector-text-style > summary");
    check(!get<HTMLDetailsElement>(".inspector-text-style").open, "text styles cannot be folded");
    await render(saved, { version: 1, hidden: ["image"], expanded: { "text-style": false } });
    check(get<HTMLDetailsElement>(".inspector-image").hidden, "hidden preference was ignored");
    await search("typeface");
    check(!get<HTMLDetailsElement>(".inspector-image").hidden && get<HTMLDetailsElement>(".inspector-text-style").open, "search did not reveal hidden styles");
    await search("");
    check(get<HTMLDetailsElement>(".inspector-image").hidden && !get<HTMLDetailsElement>(".inspector-text-style").open, "search changed saved visibility or fold state");
    check(deviceReads === 0, "search or copy requested live data");
    await render(saved, DEFAULT_INSPECTOR_GROUPS, false);
    check(get(".inspector-text-style") && !host.querySelector(".inspector-style-read"), "offline styles depend on live callback");
    await render({ ...saved, id: "zero", attributes: { "text-style-source": "view-debug", "text-size-px": "0" } }, DEFAULT_INSPECTOR_GROUPS, false);
    check(row("text-size-px").textContent?.includes("0px"), "zero size disappeared");
    await click('[aria-label="复制字号"]'); check(copies.at(-1)?.value === "0px", "zero size is not copyable");
    await render({ ...makeNode("base"), attributes: { "text-style-source": "view-debug", "text-alignment": "1", "text-direction": "0", "layout-direction": "0" } });
    check(!host.querySelector(".inspector-text-style"), "base View properties created a TextView section");
    await render(); await click(".inspector-style-read");
    check(deviceReads === 1 && get(".inspector-image").textContent?.includes("Debug SDK 实时读取"), "explicit live style behavior changed");
    check(row("text-size-px").textContent?.includes("14.123456789px"), "live style replaced snapshot evidence");
    check(JSON.stringify(root) === original, "viewing styles mutated the saved snapshot");
    const panel = get(".floating-inspector");
    check(panel.scrollWidth <= panel.clientWidth + 1, "narrow inspector overflows horizontally");
    return { checks: ["snapshot text styles visible", "raw copy and ARGB", "Chinese and English search", "hidden preferences preserved", "offline and zero size", "base View exclusion", "live source separation"], deviceReads, implicitDeviceReads: 0 };
  } finally { flushSync(() => renderer.unmount()); host.remove(); }
}
