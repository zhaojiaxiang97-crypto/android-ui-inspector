import { useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { InspectorSearchResults } from "../src/components/InspectorSearchResults";
import { DebugMetadataFields } from "../src/components/DebugMetadataFields";
import { ColorProperty } from "../src/components/ColorProperty";
import { searchInspectorProperties, type InspectorSearchProperty } from "../shared/inspector-search";
import { debugFieldCopyValue, isDebugMetadata, type DebugField, type DebugTreeNode } from "../shared/debug-metadata";
import { inspectorColorDisplay } from "../shared/color-display";
import { parseColorAliasText, type InspectorColorEncoding } from "../shared/inspector-colors";

export type PropertiesRound4Native = { key: (key: string) => Promise<void>; checkpoint: (name: string) => Promise<void> };

export async function verifyPropertiesRound4(native: PropertiesRound4Native, appearance: "dark" | "light", paneWidth = 248) {
  const beforeTheme = document.documentElement.getAttribute("data-appearance");
  document.documentElement.dataset.appearance = appearance;
  const host = document.createElement("div"); host.className = "properties-round4-fixture app-shell inspection-active";
  Object.assign(host.style, { width: `${paneWidth}px`, height: "calc(100vh - 32px)", minHeight: "0", margin: "16px", position: "relative", display: "block" });
  document.body.append(host); const mounted = createRoot(host), checks: string[] = [], copies: { label: string; value: string }[] = [], located: string[] = [];
  const act = (action: () => void) => flushSync(action);
  const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Properties round4: ${message}`); }
  const leaf = (key: string, type: "string" | "number" | "boolean" | "null", value: string | number | boolean | null) => ({ key, label: "同名字段", type, value, children: [] }) as DebugTreeNode;
  const branch: DebugTreeNode = { key: "profile", label: "同名字段", type: "string", value: "{未知字符串，不解析JSON}", children: [
    leaf("empty", "string", ""), leaf("zero", "number", 0), leaf("off", "boolean", false), leaf("nil", "null", null),
    leaf("unicode", "string", "中文 🦊\n完整长字符串_".repeat(20)),
    { ...leaf("details", "number", 1.234567), children: [{ ...leaf("deep", "boolean", false), children: [leaf("end", "string", "深层命中 UNIQUE_END")] }] },
  ] };
  let fields: DebugField[] = [{ key: "tree", label: "页面结构", type: "tree", value: [branch] }, { key: "opaque", label: "未知原文", type: "string", value: "{unknown: 不是 JSON}" }];
  assert(isDebugMetadata({ version: 2, source: "debug-sdk-explicit", status: "captured", groups: [{ key: "state", label: "页面状态", fields }] }), "fixture exceeded existing metadata contract");
  const originalTree = JSON.stringify(fields);
  let scope: object = {}, disabled = false, raw: string = "rgba(18, 52, 86, 0.1)", encoding: InspectorColorEncoding | undefined = "qml-rgba";
  const aliases = parseColorAliasText("#1234561A = 八位近似\nrgba(18,52,86,0.1) = 精确十分之一\n#12345680 = Android中间值\n#20304000 = 透明原RGB").preference!;
  let count = 31, controller!: { page: number; setPage: (value: number) => void; query: string; setQuery: (value: string) => void };
  const properties = (length: number): InspectorSearchProperty[] => Array.from({ length }, (_, index) => ({ id: `state/path/${index}`,
    group: index < 30 ? "business" : "raw", section: `页面状态/path/${index}`, label: "同名字段", terms: ["match", `state/path/${index}`],
    value: ["", "0", "false", "null", "中文 🦊\n完整搜索原值".repeat(40)][index % 5] }));
  function Harness() {
    const [page, setPage] = useState(0), [query, setQuery] = useState("match"); controller = { page, setPage, query, setQuery };
    const values = useMemo(() => properties(count), [count]), found = searchInspectorProperties(values, query, page);
    const latest = useRef(scope); latest.current = scope;
    const currentScope = scope;
    return <aside className="floating-inspector is-docked" style={{ position: "relative", top: 0, left: 0, width: "100%", height: "100%", minHeight: 0, display: "flex" }}>
      <div className="inspector-body" style={{ padding: "12px", width: "100%", boxSizing: "border-box", overflow: "auto" }}>
        <h3 style={{ margin: "0 0 8px", font: "12px var(--ref-font-ui)" }}>属性交互 · 离线样例</h3>
        <InspectorSearchResults {...found} onPageChange={setPage} onClear={() => { setQuery(""); setPage(0); }}
          onLocate={value => { if (latest.current === currentScope) located.push(value.id); }}
          onCopy={(label, value) => { if (latest.current === currentScope) copies.push({ label, value }); }} />
        <section className="inspector-card" style={{ margin: "8px 0" }}><div className="inspector-card-body">
          <DebugMetadataFields fields={fields} groupLabel="页面状态" pathPrefix="state" scope={scope} disabled={disabled}
            context={{ nodeName: "精选 · 详情容器", source: "离线样例 · Debug SDK 已采集值" }} onCopyValue={(label, value) => copies.push({ label, value })} />
        </div></section>
        <section className="inspector-card"><div className="inspector-card-body"><dl className="inspector-property-list">
          <ColorProperty label="背景源色" raw={raw} encoding={encoding} aliases={aliases} scope={scope} onCopy={(label, value) => copies.push({ label, value })} />
        </dl></div></section><button type="button" data-outside="true">其他控件</button>
      </div>
    </aside>;
  }
  const render = () => act(() => mounted.render(<Harness />));
  const get = <T extends HTMLElement>(selector: string, parent: ParentNode = document) => { const value = parent.querySelector<T>(selector); assert(value, `missing ${selector}`); return value; };
  const click = (selector: string, parent: ParentNode = document) => act(() => get<HTMLElement>(selector, parent).click());
  const changeInput = (input: HTMLInputElement, value: string) => act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  const reader = () => get<HTMLDialogElement>("body > .debug-metadata-reader[open]");
  const readerEntry = () => get<HTMLButtonElement>('button[aria-label="展开阅读页面状态·页面结构"]', host);
  const colorTrigger = () => get<HTMLButtonElement>('[aria-haspopup="menu"]', host);
  const colorMenu = () => get<HTMLElement>("body > .inspector-color-copy-menu");
  const sourceChange = () => { scope = {}; render(); };
  try {
    render(); await tick();
    for (const total of [0, 1, 30, 31, 1000]) {
      count = total; act(() => { controller.setPage(0); controller.setQuery("match"); }); render(); await tick();
      assert(host.querySelectorAll(".inspector-search-result").length === Math.min(30, total), `first page ${total}`);
      const seen: string[] = [];
      for (let page = 0; page < Math.ceil(total / 30); page++) {
        const buttons = [...host.querySelectorAll<HTMLButtonElement>(".inspector-search-result")];
        seen.push(...buttons.map(button => button.dataset.searchResult!));
        const status = get<HTMLElement>(".inspector-search-results > p", host).textContent;
        assert(status === `第 ${page * 30 + 1}–${Math.min((page + 1) * 30, total)} 项，共 ${total} 项`, `page summary ${status}`);
        if (page + 1 < Math.ceil(total / 30)) {
          get<HTMLElement>(".inspector-search-results ul", host).scrollTop = 100;
          click(".inspector-search-pages button:last-child", host); await tick();
          assert(get<HTMLElement>(".inspector-search-results ul", host).scrollTop === 0, "next page retained old list scroll");
        }
      }
      assert(seen.length === total && new Set(seen).size === total && seen.every((id, index) => id === `state/path/${index}`), `incomplete pages ${total}`);
    }
    const tailValue = properties(1000)[999].value;
    click(".inspector-search-results li:last-child .inspector-search-result-copy", host); assert(copies.at(-1)?.value === tailValue, "last page shortened copied value");
    const lastResult = [...host.querySelectorAll<HTMLButtonElement>(".inspector-search-result")].at(-1)!;
    lastResult.focus(); await native.key("Enter"); await tick(); assert(located.at(-1) === "state/path/999", "native Enter cannot reach last match");
    count = 31; act(() => controller.setPage(0)); render(); await tick();
    get<HTMLButtonElement>(".inspector-search-pages button:last-child", host).focus(); await native.key("Enter"); await tick();
    assert(Number(controller.page) === 1 && host.querySelectorAll(".inspector-search-result").length === 1, "native Enter pagination failed");
    const compositionResult = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true });
    act(() => get<HTMLElement>(".inspector-search-result", host).dispatchEvent(compositionResult));
    assert(controller.query === "match" && compositionResult.defaultPrevented && Number(controller.page) === 1, "IME Escape cleared search result/page");
    const locatedCount = located.length;
    act(() => get<HTMLElement>(".inspector-search-result", host).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true })));
    assert(located.length === locatedCount, "IME Enter located a result");
    checks.push("0/1/30/31/1000 matches: every original result reachable once, native Enter pages/locates, long original copy and list scroll reset");

    const baseFold = get<HTMLDetailsElement>(".inspector-debug-tree-root", host), body = get<HTMLElement>(".inspector-body", host);
    const outerScroll = body.scrollTop; assert(!baseFold.open, "unexpected initial base fold");
    readerEntry().focus(); click('button[aria-label="展开阅读页面状态·页面结构"]', host); await tick();
    assert(reader().parentElement === document.body && !host.querySelector(".debug-metadata-reader"), "reader polluted inspector property index");
    assert(reader().textContent?.includes("精选 · 详情容器") && reader().textContent?.includes("state/tree") && reader().textContent?.includes("Debug SDK"), "reader context missing");
    click(".debug-metadata-reader-tools > button", reader()); assert(copies.at(-1)?.value === debugFieldCopyValue(fields[0]), "complete tree copy changed original");
    const input = get<HTMLInputElement>('input[aria-label="搜索分层信息"]', reader());
    changeInput(input, "UNIQUE_END"); await tick();
    assert(reader().querySelectorAll("details[open]").length >= 4 && reader().querySelector(".inspector-debug-match")?.textContent?.includes("UNIQUE_END"), "reader search failed deep auto expansion");
    assert(reader().textContent?.includes("state/tree/profile/details/deep/end"), "full leaf path missing");
    changeInput(input, "中文"); await tick();
    // Locate the Unicode value's original button by its field path because labels intentionally repeat.
    click('[data-debug-path="state/tree/profile/unicode"] button.inspector-field-copy', reader());
    assert(copies.at(-1)?.value === branch.children[4].value, "reader truncated Unicode original");
    changeInput(input, ""); await tick();
    const profileSummary = get<HTMLElement>('[data-debug-path="state/tree/profile"] > summary', reader()); act(() => profileSummary.click()); await tick();
    click('[data-debug-path="state/tree/profile"] > summary .inspector-debug-branch-copy', reader());
    assert(copies.at(-1)?.value === JSON.stringify(branch) && debugFieldCopyValue(branch) === branch.value, "complete branch copy changed scalar copy semantics");
    const scalarCopies: [string, string][] = [["empty", ""], ["zero", "0"], ["off", "false"], ["nil", "null"]];
    for (const [key, value] of scalarCopies) { click(`[data-debug-path="state/tree/profile/${key}"] .inspector-field-copy`, reader()); assert(copies.at(-1)?.value === value, `reader changed ${key}`); }
    input.focus(); const composing = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true });
    act(() => input.dispatchEvent(composing)); assert(composing.defaultPrevented && reader().open, "IME Escape closed reader");
    await native.checkpoint(`reader-${appearance}`);
    await native.key("Escape"); await tick();
    assert(!document.querySelector(".debug-metadata-reader") && document.activeElement === readerEntry() && body.scrollTop === outerScroll && !baseFold.open, "reader close lost focus, inspector scroll or fold");
    checks.push("independent Portal reader: deep search/path, whole tree and branch/value copies, null/false/0/empty/Unicode, IME guard, native Escape and original inspector focus/scroll/fold");

    readerEntry().focus(); readerEntry().click(); await tick(); const oldCopy = get<HTMLButtonElement>(".debug-metadata-reader-tools > button", reader());
    const copyCount = copies.length; sourceChange(); await tick(); oldCopy.click();
    assert(!document.querySelector(".debug-metadata-reader") && copies.length === copyCount, "old scope reader survived or copied");
    readerEntry().click(); await tick(); fields = structuredClone(fields); render(); await tick(); assert(!document.querySelector(".debug-metadata-reader"), "same node new field source retained reader");
    readerEntry().click(); await tick(); disabled = true; render(); await tick(); assert(!document.querySelector(".debug-metadata-reader") && readerEntry().disabled, "busy source retained reader");
    readerEntry().click(); await tick(); assert(!document.querySelector(".debug-metadata-reader"), "busy entry opened reader"); disabled = false; render(); await tick();
    checks.push("scope replacement, same-node new fields and capture/refresh disabled close old content and forbid stale/open actions without device calls");

    const cases: [string, InspectorColorEncoding | undefined][] = [["rgba(18, 52, 86, 0.1)", "qml-rgba"], ["#00203040", "android-argb"], [" #80123456 ", "android-argb"], ["#12345678", undefined], ["unknown-token", "qml-rgba"]];
    for (const [value, source] of cases) {
      raw = value; encoding = source; render(); await tick(); colorTrigger().focus(); colorTrigger().click(); await tick();
      const expected = inspectorColorDisplay(raw, encoding, "hex", aliases), items = [...colorMenu().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      assert(items.length === (expected.color ? 3 : 1), "unknown/invalid menu guessed formats");
      if (expected.color) {
        assert(colorMenu().textContent?.includes(expected.sourceLabel) && colorMenu().textContent?.includes("透明度"), "source/alpha missing");
        assert(Boolean(colorMenu().textContent?.includes("Hex 透明度近似")) === !expected.exactHex, "Hex approximation missing");
        if (expected.alias) assert(colorMenu().textContent?.includes(expected.alias), "exact source alias missing");
        if (raw === "rgba(18, 52, 86, 0.1)") assert(colorMenu().textContent?.includes("精确十分之一") && !colorMenu().textContent?.includes("八位近似"), "Hex rounding became a color alias");
      }
      for (const format of expected.color ? ["hex", "rgba", "raw"] as const : ["raw"] as const) {
        if (!document.querySelector(".inspector-color-copy-menu")) { colorTrigger().focus(); colorTrigger().click(); await tick(); }
        const item = [...colorMenu().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.startsWith(`复制 ${format === "hex" ? "Hex" : format === "rgba" ? "RGBA" : "原值"}`))!;
        act(() => item.click()); await tick(); assert(copies.at(-1)?.value === expected.values[format] && document.activeElement === colorTrigger(), `wrong copied ${format}`);
      }
    }
    raw = "rgba(18, 52, 86, 0.1)"; encoding = "qml-rgba"; render(); await tick(); colorTrigger().focus(); colorTrigger().click(); await tick();
    const composingMenu = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true });
    act(() => get<HTMLButtonElement>('[role="menuitem"]', colorMenu()).dispatchEvent(composingMenu));
    assert(composingMenu.defaultPrevented && document.querySelector(".inspector-color-copy-menu"), "IME Escape closed color menu");
    get<HTMLButtonElement>('[role="menuitem"]', colorMenu()).focus(); await native.key("ArrowUp"); await tick();
    assert(document.activeElement === colorMenu().querySelector('[role="menuitem"]:last-child'), "color menu ArrowUp wrap failed");
    await native.key("Escape"); await tick(); assert(!document.querySelector(".inspector-color-copy-menu") && document.activeElement === colorTrigger(), "native menu Escape focus failed");
    colorTrigger().click(); await tick(); const oldColorItem = get<HTMLButtonElement>('[role="menuitem"]', colorMenu()), colorCopyCount = copies.length;
    sourceChange(); await tick(); oldColorItem.click(); assert(!document.querySelector(".inspector-color-copy-menu") && copies.length === colorCopyCount, "old same-color scope retained copy menu");
    colorTrigger().click(); await tick(); const outside = get<HTMLButtonElement>("[data-outside]", host);
    act(() => outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))); outside.focus(); await tick();
    assert(!document.querySelector(".inspector-color-copy-menu") && document.activeElement === outside, "outside menu click stole destination focus");
    colorTrigger().click(); await tick(); act(() => window.dispatchEvent(new Event("blur"))); await tick(); assert(!document.querySelector(".inspector-color-copy-menu"), "window blur retained menu");
    checks.push("color menu uses existing ARGB/RGBA conversion, transparent RGB/precise alpha/Hex approximation/exact aliases and original, unknown source raw only; native keyboard/IME/focus/outside/blur/source guards");

    count = 1000; act(() => { controller.setPage(1); controller.setQuery("match"); }); render(); await tick();
    const pane = host.getBoundingClientRect();
    for (const selector of [".inspector-search-results", ".inspector-search-pages", ".inspector-debug-reader-entry", ".inspector-color-heading"]) {
      const control = get<HTMLElement>(selector, host), bounds = control.getBoundingClientRect();
      assert(bounds.left >= pane.left - 1 && bounds.right <= pane.right + 1 && control.scrollWidth <= control.clientWidth + 1, `pane overflow ${selector}`);
    }
    body.scrollTop = 0; await native.checkpoint(`pagination-${appearance}`);
    body.scrollTop = body.scrollHeight; colorTrigger().focus(); colorTrigger().click(); await tick();
    const menuBounds = colorMenu().getBoundingClientRect();
    assert(menuBounds.left >= 0 && menuBounds.right <= innerWidth + 1 && menuBounds.top >= 0 && menuBounds.bottom <= innerHeight + 1, "color menu outside zoomed viewport");
    await native.checkpoint(`color-${appearance}`); await native.key("Escape"); await tick();
    readerEntry().focus(); readerEntry().click(); await tick();
    const bounds = reader().getBoundingClientRect(); assert(bounds.left >= 0 && bounds.right <= innerWidth + 1 && bounds.top >= 0 && bounds.bottom <= innerHeight + 1, "reader outside zoomed viewport");
    const readerBody = get<HTMLElement>(".debug-metadata-reader-body", reader()); assert(readerBody.scrollWidth <= readerBody.clientWidth + 1, "reader horizontal overflow");
    assert(JSON.stringify(fields) === originalTree, "UI modified recorded values");
    await native.key("Escape"); await tick();
    checks.push(`${appearance} actual ${paneWidth}px pane: paging/menu controls fit, independent reader scrolls inside viewport and values remain unchanged`);
    return { passed: true, fixtureOnly: true, appearance, paneWidth, phoneOperations: 0, checks, copies: copies.length, viewport: { width: innerWidth, height: innerHeight, physicalDpi: devicePixelRatio } };
  } finally {
    act(() => mounted.unmount()); host.remove();
    if (beforeTheme === null) document.documentElement.removeAttribute("data-appearance"); else document.documentElement.setAttribute("data-appearance", beforeTheme);
  }
}
