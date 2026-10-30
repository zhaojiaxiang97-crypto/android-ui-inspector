import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { InspectorGroupControls } from "../src/components/InspectorGroupControls";
import { useInspectorGroups } from "../src/features/inspection/useInspectorGroups";
import { DEFAULT_INSPECTOR_GROUPS, INSPECTOR_GROUPS, INSPECTOR_GROUP_STORAGE_KEY, inspectorDisclosureOpen, withInspectorDisclosure,
  type InspectorGroupPreference } from "../shared/inspector-groups";

type Native = { key: (key: string) => Promise<void>; checkpoint: (name: string) => Promise<void> };

export async function verifyInspectorGroupsRound5(native: Native, appearance: "dark" | "light", paneWidth = 248) {
  const beforeTheme = document.documentElement.getAttribute("data-appearance"), stored = localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY);
  document.documentElement.dataset.appearance = appearance;
  localStorage.setItem(INSPECTOR_GROUP_STORAGE_KEY, JSON.stringify(DEFAULT_INSPECTOR_GROUPS));
  const host = document.createElement("div"); host.className = "inspector-groups-round5-fixture app-shell inspection-active";
  Object.assign(host.style, { width: `${paneWidth}px`, height: "calc(100vh - 32px)", minHeight: "0", margin: "16px", position: "relative", display: "block" });
  document.body.append(host); const mounted = createRoot(host), checks: string[] = [];
  const act = (action: () => void) => flushSync(action), tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Inspector groups round5: ${message}`); }
  let scope: object = {}, disabled = false, searching = false, failStorage = false, saves = 0, preferencesOpened = 0;
  let controller!: { preference: InspectorGroupPreference; save: (value: InspectorGroupPreference) => boolean };
  const nativeStorageSave = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    if (key === INSPECTOR_GROUP_STORAGE_KEY && failStorage) throw new Error("fixture storage unavailable");
    nativeStorageSave.call(this, key, value);
  };
  function openPreferences() {
    preferencesOpened++;
    const dialog = document.createElement("dialog"); dialog.className = "fixture-group-preferences";
    dialog.innerHTML = '<p>现有属性分组设置</p><button type="button">关闭设置</button>';
    dialog.querySelector("button")!.onclick = () => { dialog.close(); dialog.remove(); };
    document.body.append(dialog); dialog.showModal();
  }
  function Harness() {
    const { inspectorGroups, saveInspectorGroups } = useInspectorGroups();
    const save = (value: InspectorGroupPreference) => { saves++; return saveInspectorGroups(value); };
    controller = { preference: inspectorGroups, save };
    return <aside className="floating-inspector is-docked" style={{ position: "relative", top: 0, left: 0, width: "100%", height: "100%", display: "flex", minHeight: 0 }}>
      <div className="inspector-body" style={{ padding: "8px", width: "100%", boxSizing: "border-box", overflow: "auto" }}>
        <h3 style={{ margin: "0 0 8px", font: "12px var(--ref-font-ui)" }}>分组管理 · 离线样例</h3>
        <div className="inspector-tools"><div className="inspector-search"><input type="search" aria-label="搜索属性" placeholder="搜索属性…" readOnly value={searching ? "匹配属性" : ""} /></div>
          <InspectorGroupControls preference={inspectorGroups} onSave={save} onOpenPreferences={openPreferences} scope={scope} disabled={disabled} searching={searching} /></div>
        {INSPECTOR_GROUPS.map(item => <details key={item.id} className="inspector-card" data-group={item.id}
          hidden={!searching && inspectorGroups.hidden.includes(item.id)} open={searching || inspectorDisclosureOpen(inspectorGroups, item.id)}
          onClick={event => {
            if (event.target instanceof Element && event.target.closest("[data-inspector-group-control]")) return;
            if (!(event.target instanceof Element) || event.target.closest("summary")?.parentElement !== event.currentTarget) return;
            event.preventDefault();
            if (!searching) save(withInspectorDisclosure(inspectorGroups, item.id, !inspectorDisclosureOpen(inspectorGroups, item.id)));
          }}>
          <summary><span className="inspector-card-icon" aria-hidden="true">{item.label[0]}</span><span>{item.label}</span>{item.id === "type" && <small title="Debug SDK · 已采集控件属性">Debug SDK · 已采集控件属性</small>}
            <InspectorGroupControls preference={inspectorGroups} onSave={save} onOpenPreferences={openPreferences} group={item.id} scope={scope} disabled={disabled} searching={searching} /></summary>
          <div className="inspector-card-body"><p>已采集的{item.label}属性 · 值保持只读</p></div>
        </details>)}<button type="button" className="fixture-group-outside">其他控件</button>
      </div>
    </aside>;
  }
  const render = () => act(() => mounted.render(<Harness />));
  const get = <T extends HTMLElement>(selector: string, parent: ParentNode = document) => { const value = parent.querySelector<T>(selector); assert(value, `missing ${selector}`); return value; };
  const click = (selector: string, parent: ParentNode = document) => act(() => { const element = get<HTMLElement>(selector, parent); element.focus({ preventScroll: true }); element.click(); });
  const popup = () => get<HTMLDivElement>("body > .inspector-group-popup");
  const entry = () => get<HTMLButtonElement>(".inspector-groups-open", host);
  const open = async () => { click(".inspector-groups-open", host); await tick(); assert(popup().parentElement === document.body, "not a body portal"); };
  const close = async () => { await native.key("Escape"); await tick(); assert(!document.querySelector(".inspector-group-popup"), "Escape left a popup"); };
  try {
    render(); await tick();
    const body = get<HTMLElement>(".inspector-body", host);
    assert(body.scrollWidth <= body.clientWidth + 1, `inspector horizontal overflow ${body.scrollWidth}/${body.clientWidth}`);
    for (const label of host.querySelectorAll("summary > span:not(.inspector-card-icon)")) {
      const range = document.createRange(); range.selectNodeContents(label);
      assert(range.getClientRects().length === 1, "group name wraps in narrow header");
    }
    entry().focus(); await native.key("Enter"); await tick();
    assert(popup().querySelectorAll('input[type="checkbox"]').length === 7, "not all seven groups reachable");
    for (const item of INSPECTOR_GROUPS) {
      click(`input[aria-label="显示${item.label}"]`, popup()); await tick();
      assert(controller.preference.hidden.includes(item.id) && get<HTMLDetailsElement>(`[data-group="${item.id}"]`, host).hidden, `cannot hide ${item.id}`);
    }
    assert(entry().textContent?.includes("7") && controller.preference.hidden.length === 7 && popup().querySelectorAll("input:checked").length === 0, "all hidden entry/count missing");
    for (const item of INSPECTOR_GROUPS) {
      click(`input[aria-label="显示${item.label}"]`, popup()); await tick();
      assert(!controller.preference.hidden.includes(item.id) && !get<HTMLDetailsElement>(`[data-group="${item.id}"]`, host).hidden, `cannot restore ${item.id}`);
    }
    assert(Number(controller.preference.hidden.length) === 0 && !entry().querySelector(".inspector-group-hidden-count"), "hidden badge survived restore");
    await native.checkpoint(`groups-${appearance}`); await close(); assert(document.activeElement === entry(), "Escape did not return to entry");
    checks.push("native Enter opens seven controlled checkboxes; each hide/restore applies shared preference, all-hidden entry and count remain reachable");

    const typeCard = get<HTMLDetailsElement>('[data-group="type"]', host), typeManage = get<HTMLButtonElement>('[data-group="type"] .inspector-group-manage', host);
    const folded = typeCard.open, beforeManageSaves = saves;
    typeManage.focus(); await native.key("Space"); await tick();
    assert(typeCard.open === folded && saves === beforeManageSaves && popup().querySelector(".inspector-group-hide"), "native Space management changed summary disclosure");
    await close(); assert(document.activeElement === typeManage && typeCard.open === folded, "title close changed fold/focus");
    typeManage.focus(); await native.key("Enter"); await tick();
    assert(typeCard.open === folded && saves === beforeManageSaves, "native Enter management changed disclosure");
    click(".inspector-group-hide", popup()); await tick();
    assert(typeCard.hidden && controller.preference.hidden.includes("type") && !document.querySelector(".inspector-group-popup") && document.activeElement === entry(), "title hide left popup or focus in hidden group");
    await open(); click('input[aria-label="显示类型"]', popup()); await tick(); await close();
    assert(!typeCard.hidden && typeCard.open === folded, "restore changed prior disclosure");
    checks.push("native Space/Enter title management do not toggle or save summary; hide closes and returns focus to persistent entry, restore preserves fold");

    act(() => controller.save({ version: 1, hidden: ["layout"], expanded: { type: true, image: false, padding: true } })); await tick();
    const beforeSearch = JSON.stringify(controller.preference); searching = true; render(); await tick();
    assert(!get<HTMLDetailsElement>('[data-group="layout"]', host).hidden, "search did not temporarily reveal hidden group");
    click('[data-group="layout"] .inspector-group-manage', host); await tick();
    assert(get<HTMLButtonElement>(".inspector-group-hide", popup()).disabled && popup().textContent?.includes("先清除属性搜索"), "search title hide allowed or hint missing");
    await close(); await open();
    assert(get<HTMLInputElement>('input[aria-label="显示类型"]', popup()).disabled && !get<HTMLInputElement>('input[aria-label="显示布局"]', popup()).disabled, "search should allow restore and block hiding shown groups");
    get<HTMLInputElement>('input[aria-label="显示类型"]', popup()).click(); await tick();
    assert(JSON.stringify(controller.preference) === beforeSearch, "disabled search hide changed preference");
    click('input[aria-label="显示布局"]', popup()); await tick();
    assert(!controller.preference.hidden.includes("layout") && controller.preference.expanded?.image === false && controller.preference.expanded?.padding === true, "search restore lost folds");
    await close(); searching = false; render(); await tick();
    assert(get<HTMLDetailsElement>('[data-group="type"]', host).open && !get<HTMLDetailsElement>('[data-group="image"]', host).open, "search ending lost saved folds");
    await open(); click(".inspector-group-reset", popup()); await tick();
    assert(JSON.stringify(controller.preference) === JSON.stringify(DEFAULT_INSPECTOR_GROUPS), "reset did not restore old fold/visibility defaults");
    await close(); checks.push("temporary search reveal never writes preferences; hiding blocked with hint, restoration available, ending search preserves explicit folds, reset clears all overrides");

    await open(); failStorage = true; const beforeFailureStorage = localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY);
    click('input[aria-label="显示关系"]', popup()); await tick();
    assert(controller.preference.hidden.includes("relation") && get<HTMLDetailsElement>('[data-group="relation"]', host).hidden
      && popup().querySelector('[role="status"]')?.textContent?.includes("保存失败") && localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY) === beforeFailureStorage, "storage failure feedback or in-window application lost");
    await native.checkpoint(`storage-failure-${appearance}`); await close(); await open();
    assert(!get<HTMLInputElement>('input[aria-label="显示关系"]', popup()).checked, "reopening lost current failed-save state");
    failStorage = false; click('input[aria-label="显示关系"]', popup()); await tick();
    assert(!controller.preference.hidden.includes("relation") && popup().querySelector('[role="status"]')?.textContent?.includes("已保存"), "storage recovery feedback failed");
    await close(); checks.push("real useInspectorGroups storage exception applies current window, preserves old storage and displays failure; reopen and successful recovery use same state");

    await open(); const staleCheckbox = get<HTMLInputElement>('input[aria-label="显示交互"]', popup()), beforeStale = saves;
    scope = {}; render(); await tick(); staleCheckbox.click(); await tick();
    assert(!document.querySelector(".inspector-group-popup") && saves === beforeStale, "old source survived/called save");
    await open(); disabled = true; render(); await tick();
    assert(!document.querySelector(".inspector-group-popup") && entry().disabled, "hidden/collapsed/busy source retained controls");
    disabled = false; render(); await tick(); await open();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true });
    get<HTMLInputElement>("input", popup()).dispatchEvent(event); await tick(); assert(document.querySelector(".inspector-group-popup"), "IME Escape closed controls");
    await close(); await open();
    get<HTMLInputElement>("input", popup()).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await native.key("Escape"); await tick(); assert(document.querySelector(".inspector-group-popup"), "composition session Escape closed controls");
    get<HTMLInputElement>("input", popup()).dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); await close();
    checks.push("scope replacement rejects stale save; disabled source closes/blocks entry; composing native Escape preserves popup until composition ends");

    await open(); click(".fixture-group-outside", host); await tick(); assert(!document.querySelector(".inspector-group-popup"), "outside focus/click did not close");
    await open(); document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await tick();
    assert(!document.querySelector(".inspector-group-popup"), "outside pointer did not close");
    await open(); window.dispatchEvent(new Event("blur")); await tick(); assert(!document.querySelector(".inspector-group-popup"), "window blur did not close");
    await open(); click('[data-group="layout"] .inspector-group-manage', host); await tick();
    assert(document.querySelectorAll(".inspector-group-popup").length === 1 && popup().textContent?.includes("布局分组"), "management popups not mutually exclusive");
    const rect = popup().getBoundingClientRect();
    assert(rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && popup().scrollWidth <= popup().clientWidth + 1, "popup leaves viewport or clips horizontally");
    await native.checkpoint(`title-${appearance}`); click(".inspector-group-more", popup()); await tick();
    assert(preferencesOpened === 1 && !document.querySelector(".inspector-group-popup") && document.querySelector("dialog[open]"), "more settings did not hand off to existing dialog");
    entry().click(); await tick(); assert(!document.querySelector(".inspector-group-popup"), "modal allowed group popup");
    get<HTMLButtonElement>(".fixture-group-preferences button").click(); await tick(); await open();
    openPreferences(); await tick(); assert(!document.querySelector(".inspector-group-popup"), "new modal retained underlying group popup");
    get<HTMLButtonElement>(".fixture-group-preferences button").click(); await tick();
    checks.push("outside pointer/focus/window blur dismiss, title/top popups mutually exclusive, viewport bounds, more-settings modal handoff and modal-open suspension");

    act(() => controller.save({ version: 1, hidden: ["raw", "image"], expanded: { type: true, business: false } })); await tick();
    act(() => mounted.render(null)); render(); await tick();
    assert(JSON.stringify(controller.preference) === JSON.stringify({ version: 1, hidden: ["raw", "image"], expanded: { type: true, business: false } }), "remount lost saved groups/disclosure");
    checks.push("closing/reopening panel rereads saved visibility and disclosure from unchanged existing storage contract");
    return { appearance, paneWidth, checks, saves, deviceOperations: 0 };
  } finally {
    failStorage = false; Storage.prototype.setItem = nativeStorageSave;
    act(() => mounted.unmount()); host.remove(); document.querySelector(".fixture-group-preferences")?.remove();
    if (stored === null) localStorage.removeItem(INSPECTOR_GROUP_STORAGE_KEY); else localStorage.setItem(INSPECTOR_GROUP_STORAGE_KEY, stored);
    if (beforeTheme === null) delete document.documentElement.dataset.appearance; else document.documentElement.dataset.appearance = beforeTheme;
  }
}
