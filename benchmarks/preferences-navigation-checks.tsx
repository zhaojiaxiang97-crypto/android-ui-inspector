import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { DEFAULT_COLOR_ALIASES, type ColorAliasPreference } from "../shared/inspector-colors";
import { DEFAULT_INSPECTOR_GROUPS } from "../shared/inspector-groups";
import { DEFAULT_TREE_COLLAPSE } from "../shared/tree-collapse";
import type { TreeDoubleClickAction } from "../shared/types";
import { PreferencesPanel } from "../src/components/PreferencesPanel";
import { PREFERENCES_SECTIONS, type PreferencesReadingPosition, type PreferencesSection } from "../src/features/inspection/preferences-navigation";

export async function verifyPreferencesNavigation(nativeKey?: (key: "Return" | "Escape") => Promise<void>, checkpoint?: (name: string) => Promise<void>) {
  const host = document.createElement("div");
  document.body.append(host);
  const renderer = createRoot(host), checks: string[] = [];
  let remembered: PreferencesReadingPosition | undefined, aliasSaves = 0, layoutResets = 0;
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(`Preferences navigation: ${message}`); };
  const settle = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const element = host.querySelector<T>(selector); check(element, `missing ${selector}`); return element!;
  };
  const click = async (selector: string) => { flushSync(() => get(selector).click()); await settle(); };
  const change = async (selector: string, value: string) => {
    const element = get<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
    await settle();
  };
  const jump = async (section: PreferencesSection, keyboard = false) => {
    const button = get<HTMLButtonElement>(`.preferences-navigation [aria-controls="preferences-group-${section}"]`);
    button.focus();
    if (keyboard && nativeKey) await nativeKey("Return");
    else flushSync(() => button.click());
    await settle();
    const title = get<HTMLElement>(`#preferences-group-${section} h3`), body = get(".preferences-body").getBoundingClientRect();
    check(document.activeElement === title, `jump to ${section} did not focus its title`);
    check(title.getBoundingClientRect().top < body.bottom && title.getBoundingClientRect().bottom > body.top, `${section} title is outside the scroll viewport`);
    check(button.getAttribute("aria-current") === "location", `${section} is missing its current-group state`);
  };
  function Harness() {
    const [open, setOpen] = useState(false), [initialSection, setInitialSection] = useState<PreferencesSection>();
    const position = useRef<PreferencesReadingPosition | undefined>(undefined);
    const [action, setAction] = useState<TreeDoubleClickAction>("expand");
    const [groups, setGroups] = useState(DEFAULT_INSPECTOR_GROUPS), [aliases, setAliases] = useState(DEFAULT_COLOR_ALIASES);
    const openPreferences = (section?: PreferencesSection) => { setInitialSection(section); setOpen(true); };
    const saveAliases = (value: ColorAliasPreference) => { aliasSaves++; setAliases(value); return false; };
    return <div className="app-shell" style={{ padding: 24 }}>
      <button type="button" data-open-preferences onClick={() => openPreferences()}>偏好设置</button>
      <button type="button" data-open-properties onClick={() => openPreferences("properties")}>属性分组</button>
      {open && <PreferencesPanel doubleClickAction={action} onChange={setAction} treeCollapsePreference={DEFAULT_TREE_COLLAPSE}
        onCollapseChange={() => {}} onApplyCollapse={() => {}} canApplyCollapse colorAliases={aliases} onSaveColorAliases={saveAliases}
        inspectorGroups={groups} onSaveInspectorGroups={value => { setGroups(value); return false; }}
        onAppearanceChange={() => false} onResetWorkspaceLayout={() => { layoutResets++; return true; }} onResetContextHints={() => false}
        initialSection={initialSection} readingPosition={position.current} onReadingPositionChange={value => { position.current = value; remembered = value; }}
        onClose={() => setOpen(false)} />}
    </div>;
  }
  try {
    flushSync(() => renderer.render(<Harness />)); await settle();
    get("[data-open-preferences]").focus(); await click("[data-open-preferences]");
    check(get(".preferences-navigation [aria-current]").textContent === "交互", "ordinary first open did not start at interaction");
    check(host.querySelectorAll(".preferences-group").length === PREFERENCES_SECTIONS.length && [...host.querySelectorAll<HTMLElement>(".preferences-group")].every(group => !group.hidden), "navigation unmounted or hid a settings group");
    checks.push("all mounted groups; original first setting preserved");

    await change('[aria-label="初始显示层级"]', "999");
    await change('[aria-label="默认收起的类型"]', "Invalid*Rule");
    check(get("#preferences-group-interaction [role=alert]").textContent?.includes("1–200"), "invalid collapse depth lost its local validation");
    await jump("appearance", true);
    await change('[aria-label="界面外观"]', "light");
    check(get(".preferences-appearance [role=status]").textContent?.includes("本机保存失败"), "appearance save failure disappeared");
    await jump("properties", true);
    await change('[aria-label="颜色别名"]', "invalid color = 草稿");
    check(Boolean(get(".preferences-colors [role=alert]")), "invalid alias lost validation");
    await jump("help", true);
    await jump("interaction", true);
    check(get<HTMLInputElement>('[aria-label="初始显示层级"]').value === "999" && get<HTMLTextAreaElement>('[aria-label="默认收起的类型"]').value === "Invalid*Rule", "group navigation discarded collapse drafts");
    check(Boolean(get("#preferences-group-interaction [role=alert]")), "group navigation cleared an error");
    checks.push("keyboard jumps focus titles; invalid drafts and validation stay mounted");

    await jump("properties");
    check(get<HTMLTextAreaElement>('[aria-label="颜色别名"]').value === "invalid color = 草稿", "alias draft changed while reading another group");
    await change('[aria-label="颜色别名"]', "#123456 = 主色");
    await click(".preferences-color-actions button");
    check(aliasSaves === 1 && get(".preferences-colors [role=status]").textContent?.includes("本机保存失败"), "alias failure was replaced with a success");
    await jump("help"); await jump("properties");
    check(get(".preferences-colors [role=status]").textContent?.includes("本机保存失败"), "group navigation cleared save feedback");
    await jump("appearance");
    check(get(".preferences-appearance [role=status]").textContent?.includes("本机保存失败"), "appearance feedback was remounted");
    await jump("layout"); await click(".preferences-workspace-layout button");
    check(layoutResets === 1 && get(".preferences-workspace-layout [role=status]").textContent?.includes("已恢复"), "layout restore callback changed");
    checks.push("save failure and restore retain original behavior across groups");

    for (const section of PREFERENCES_SECTIONS) await jump(section.id);
    const dialog = get(".preferences-panel"), body = get(".preferences-body"), navigation = get(".preferences-navigation");
    const bounds = dialog.getBoundingClientRect(), navBounds = navigation.getBoundingClientRect();
    check(bounds.left >= 0 && bounds.right <= innerWidth + 1 && bounds.top >= 0 && bounds.bottom <= innerHeight + 1, "dialog escaped the page viewport");
    check(body.scrollWidth <= body.clientWidth + 1 && dialog.scrollWidth <= dialog.clientWidth + 1, "settings overflow horizontally");
    check([...navigation.querySelectorAll("button")].every(button => button.getBoundingClientRect().left >= navBounds.left && button.getBoundingClientRect().right <= navBounds.right), "wrapped navigation clipped a button");
    check(body.clientHeight >= 100, "fixed heading left no useful settings viewport");
    await checkpoint?.("preferences-help");
    checks.push("all sections reachable; heading and wrapped navigation stay inside viewport");

    await jump("properties");
    body.scrollTop += 43; await settle();
    const beforeClose = { ...remembered! };
    check(beforeClose.section === "properties", "manual scrolling did not update reading position");
    body.scrollTop += 9;
    beforeClose.offset += 9;
    await click('[aria-label="关闭偏好设置"]');
    check(document.activeElement === get("[data-open-preferences]"), "close did not return focus to ordinary opener");
    get("[data-open-preferences]").focus(); await click("[data-open-preferences]");
    check(remembered?.section === beforeClose.section && Math.abs(remembered.offset - beforeClose.offset) <= 1, "ordinary reopen lost reading section or offset");
    await click('[aria-label="关闭偏好设置"]');
    get("[data-open-properties]").focus(); await click("[data-open-properties]");
    check(document.activeElement === get("#preferences-group-properties h3") && Math.abs(remembered!.offset) < 2, "context entry did not override previous reading position");
    await checkpoint?.("preferences-properties");
    if (nativeKey) { await nativeKey("Escape"); await settle(); }
    else await click('[aria-label="关闭偏好设置"]');
    check(!host.querySelector(".preferences-panel") && document.activeElement === get("[data-open-properties]"), "Escape/close did not restore context-entry focus");
    checks.push("ordinary reopen restores offset; context entry focuses its group; close restores opener");
    return { passed: true, checks, nativeKeyboard: Boolean(nativeKey), phoneOperations: 0 };
  } finally {
    flushSync(() => renderer.unmount()); host.remove();
  }
}
