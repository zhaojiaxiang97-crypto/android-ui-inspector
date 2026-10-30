import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { NodePropertiesPanel } from "../src/components/NodePropertiesPanel";
import { InspectorGroupPreferences } from "../src/components/InspectorGroupPreferences";
import { useInspectorGroups } from "../src/features/inspection/useInspectorGroups";
import { INSPECTOR_GROUP_STORAGE_KEY } from "../shared/inspector-groups";
import { indexInspectorProperties } from "../src/features/inspection/inspector-search-index";
import type { UiNode } from "../shared/types";
import { makeNode } from "./fixtures";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/workbench.css";

const longText = "  完整控件文本\n" + "可滚动阅读的原值\n".repeat(14) + "TEXT_END  ";
const fixture: UiNode = { ...makeNode("0"), text: "属性样例父容器", children: [
  { ...makeNode("0/0", 1), className: "org.example.playback.PlaybackPreferenceCategoryWithLongClassName", text: longText,
    contentDesc: "属性摘要里的完整描述", resourceId: "org.example.playback:id/a_resource_identifier_that_keeps_the_full_original",
    bounds: { left: 24, top: 72, right: 300, bottom: 124, raw: "[24,72][300,124]" },
    attributes: { "inspection-source": "debug-qml", "background-color": "rgba(18,52,86,0.5)", "border-color": "rgba(20,40,60,0)",
      "border-status": "默认边框启用状态未暴露", "sdk-class-hierarchy": "org.example.playback.PlaybackPreferenceCategoryWithLongClassName → android.view.View" } },
  { ...makeNode("0/1", 2), className: null, text: null, resourceId: null, bounds: null,
    attributes: { "inspection-source": "debug-qml", "background-color": "未暴露" } },
] };

/** Fixture-only DOM coverage; mounting, searching and disclosures never request device data. */
export async function verifyCompactInspector(checkpoint?: () => Promise<void>) {
  const previous = localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY);
  const host = document.createElement("div"); document.body.append(host);
  let app = createRoot(host), deviceReads = 0;
  const copies: Array<{ label: string; value: string }> = [];
  const check = (value: unknown, message: string) => { if (!value) throw new Error(`Compact inspector: ${message}`); };
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
  function Harness() {
    const { inspectorGroups, saveInspectorGroups } = useInspectorGroups();
    const [selected, setSelected] = useState(0);
    const [preferences, setPreferences] = useState(false);
    return <div className="app-shell inspection-active" style={{ height: "100vh", padding: 20 }}>
      <div className="preview-pane" style={{ minHeight: 0, width: "100%", height: "calc(100vh - 40px)", position: "relative" }}>
        <button data-fixture-select type="button" onClick={() => setSelected(value => 1 - value)}>切换样例</button>
        <NodePropertiesPanel root={fixture} node={fixture.children[selected]} screenshotSize={{ width: 360, height: 800 }} toolbarHost={null} docked
          inspectorGroups={inspectorGroups} onSaveInspectorGroups={saveInspectorGroups} onOpenGroupPreferences={() => setPreferences(value => !value)}
          onCopy={() => copies.push({ label: "节点 JSON", value: JSON.stringify(fixture.children[selected]) })}
          onCopyValue={(label, value) => copies.push({ label, value })} copyStatus={null}
          onReadStyle={async () => { deviceReads++; throw new Error("No implicit style reads"); }}>
          <section className="node-attributes"><dl className="node-attributes-list"><div><dt>raw-example</dt><dd>原始属性</dd></div></dl></section>
        </NodePropertiesPanel>
        {preferences && <div style={{ width: 420 }}><InspectorGroupPreferences preference={inspectorGroups} onSave={saveInspectorGroups} /></div>}
      </div>
    </div>;
  }
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const element = host.querySelector<T>(selector); check(element, `missing ${selector}`); return element!;
  };
  const click = async (selector: string) => { flushSync(() => get(selector).click()); await settle(); };
  const filter = async (value: string) => {
    flushSync(() => {
      const field = get<HTMLInputElement>('[aria-label="搜索属性"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }); await settle();
  };
  const card = (name: string) => get<HTMLDetailsElement>(`.inspector-${name}`);
  const mount = async () => { flushSync(() => app.render(<Harness />)); await settle(); };
  try {
    localStorage.removeItem(INSPECTOR_GROUP_STORAGE_KEY);
    await mount();
    const panel = () => get<HTMLElement>(".floating-inspector");
    const body = () => get<HTMLElement>(".inspector-body");
    check(!card("type").open && !card("relation").open && !card("layout").open && card("image").open, "default hierarchy is not compact");
    check(host.querySelectorAll(".inspector-geometry").length === 1, "geometry is duplicated");
    check([...get(".inspector-geometry").querySelectorAll("dd")].map(value => value.textContent).join(",") === "24,72,276,52", "geometry changes snapshot values");
    for (const selector of [".inspector-node-heading", ".inspector-geometry", ".inspector-summary-text", ".inspector-summary-colors"]) {
      const rect = get(selector).getBoundingClientRect(), viewport = body().getBoundingClientRect();
      check(rect.height > 0 && rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1, `${selector} not in first viewport`);
    }
    check(!get(".inspector-geometry").querySelector("input"), "read-only values appear editable");
    await click('[aria-label="复制W（屏幕 px）"]');
    check(copies.at(-1)?.value === "276", "geometry copy is wrong");
    await click('[aria-label="复制文本"]');
    check(copies.at(-1)?.value === longText, "text copy loses whitespace or tail");
    const indexed = indexInspectorProperties(panel());
    check(indexed.filter(property => property.label === "文本" && property.group === "type").length === 1, "summary text missing or duplicated in search");
    check(indexed.some(property => property.label === "W" && property.group === "layout" && property.value === "276"), "summary geometry lost its layout search group");
    await click(".inspector-type > summary"); await click(".inspector-identity > summary");
    await click(".inspector-image > summary");
    const saved = localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY);
    await filter("android.view.View");
    check(card("type").open && card("identity").open && card("class-chain").open, "search did not reveal nested inherited class");
    await click(".inspector-class-chain > summary");
    await filter("");
    check(card("type").open && card("identity").open && !card("class-chain").open && !card("image").open, "search overwrote disclosure states");
    check(localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY) === saved, "search or temporary toggle wrote preferences");
    await click("[data-fixture-select]"); await click("[data-fixture-select]");
    check(card("type").open && card("identity").open && !card("image").open, "selection changed disclosure preferences");
    flushSync(() => app.unmount()); app = createRoot(host); await mount();
    check(card("type").open && card("identity").open && !card("image").open, "remount lost saved disclosure states");
    await click('[aria-label="属性显示设置"]');
    flushSync(() => {
      const more = document.querySelector<HTMLButtonElement>('body > .inspector-group-popup .inspector-group-more');
      check(more, "missing group more-settings entry"); more!.click();
    }); await settle();
    await click('[aria-label="显示布局"]'); await click('[aria-label="显示类型"]');
    check(get(".inspector-geometry").hidden && get(".inspector-summary-text").hidden, "hidden groups keep their overview rows visible");
    const hiddenState = localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY);
    await filter("276");
    check(!get(".inspector-geometry").hidden, "hidden geometry cannot be found in search");
    const result = [...host.querySelectorAll<HTMLButtonElement>(".inspector-search-result")].find(button => button.querySelector("strong")?.textContent === "W");
    check(result, "geometry search result is missing");
    flushSync(() => result!.click()); await settle();
    check(get(".inspector-property-highlight").dataset.inspectorValue === "276", "search did not locate exact summary geometry");
    await filter("");
    check(get(".inspector-geometry").hidden && get(".inspector-summary-text").hidden && localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY) === hiddenState, "search did not restore hidden summary preferences");
    await click(".preferences-inspector-groups .preferences-actions button");
    check(!get(".inspector-geometry").hidden && !get(".inspector-summary-text").hidden && !card("type").open && !card("identity").open && card("image").open, "restore defaults left saved visibility/disclosures applied");
    await click('[aria-label="属性显示设置"]');
    flushSync(() => {
      const more = document.querySelector<HTMLButtonElement>('body > .inspector-group-popup .inspector-group-more');
      check(more, "missing group more-settings entry"); more!.click();
    }); await settle();
    for (const width of [296, 248]) {
      panel().style.width = `${width}px`; await settle();
      check(body().scrollWidth <= body().clientWidth + 1, `overflow at ${width}px`);
      const heading = get(".inspector-node-heading h4").getBoundingClientRect(), copy = get(".inspector-copy").getBoundingClientRect();
      check(heading.right <= copy.left && get(".inspector-node-heading h4").title === longText.trim(), "heading covers copy or loses full name");
    }
    panel().style.removeProperty("width");
    await click('.inspector-summary-colors [aria-label="复制背景源色 Hex"]');
    check(copies.at(-1)?.value === "#12345680" && get(".inspector-summary-colors").textContent?.includes("≈ #12345680")
      && get(".inspector-summary-color").title.includes("rgba(18,52,86,0.5)"), "color summary copy lost its explicit format, approximation or source precision");
    await click("[data-fixture-select]");
    check(!host.querySelector(".inspector-summary-text") && !host.querySelector(".inspector-summary-colors"), "unknown node inherits earlier content or a guessed color");
    check([...get(".inspector-geometry").querySelectorAll("dd")].every(value => value.textContent === "—"), "unknown geometry became zero");
    check(!get(".inspector-geometry").querySelector("button"), "unknown geometry acquired copy values");
    check(deviceReads === 0, "summary or search sent a style read");
    await click("[data-fixture-select]");
    body().scrollTop = 0; await settle();
    await checkpoint?.();
    return { passed: true, viewport: { width: innerWidth, height: innerHeight }, fixtureOnly: true, deviceReads,
      checks: ["first viewport summary", "read-only geometry and exact copy", "single search index per field", "manual disclosure persists across nodes and remount", "search never changes saved state", "hidden summaries reveal and restore", "restore default resets visibility and disclosure", "296/248px layout", "honest missing values and color precision"] };
  } finally {
    flushSync(() => app.unmount()); host.remove();
    if (previous === null) localStorage.removeItem(INSPECTOR_GROUP_STORAGE_KEY); else localStorage.setItem(INSPECTOR_GROUP_STORAGE_KEY, previous);
  }
}
