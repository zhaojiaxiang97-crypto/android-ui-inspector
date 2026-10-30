import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { TreeSearchInput } from "../src/components/TreeSearchInput";
import { UiTree } from "../src/components/UiTree";
import { filterTree } from "../shared/tree-utils";
import { makeNode } from "./fixtures";
import type { UiNode } from "../shared/types";

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(`Tree suggestions: ${message}`); }
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

export async function verifyTreeSearchSuggestions() {
  const host = document.createElement("div"); host.className = "app-shell inspection-active";
  Object.assign(host.style, { width: "306px", height: "640px", minHeight: "0", position: "relative" }); document.body.append(host);
  const mounted = createRoot(host);
  let root: UiNode = { ...makeNode("0"), text: "控件树", children: Array.from({ length: 150 }, (_, i) => ({ ...makeNode(`0/${i}`),
    text: `候选标题 ${i}`, resourceId: `app:id/item_${i}`, className: "android.widget.TextView" })) };
  root.children[120].text = "候选";
  let query = "", session = 1, clears = 0, selected = 0;
  const expanded: ReadonlySet<string> = new Set([root.id]), source = JSON.stringify(root);
  const render = () => flushSync(() => mounted.render(<div className="tree-pane">
    <UiTree root={root} filteredRoot={filterTree(root, { query, interactiveOnly: false, identifiedOnly: false })}
      filterActive={Boolean(query)} filterKey={query} filter={{ query, interactiveOnly: false, identifiedOnly: false }} selectedId={root.id}
      expanded={expanded} onExpandedChange={() => {}} onSelect={() => { selected++; }} onClearFilter={clear} />
    <div className="tree-tools"><div className="tree-search-row"><TreeSearchInput root={root} snapshotKey={session} value={query}
      onChange={value => { query = value; render(); }} onClear={clear} hasFilter={Boolean(query)} />
      {query && <button className="tree-clear tree-clear-inline" onClick={clear}>清除筛选</button>}
    </div></div>
  </div>));
  function clear() { query = ""; clears++; render(); }
  const input = () => host.querySelector<HTMLInputElement>(".tree-search")!;
  const list = () => host.querySelector('[role="listbox"]');
  const options = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')];
  const type = (text: string) => flushSync(() => {
    input().focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const key = (key: string, extra: KeyboardEventInit = {}) => flushSync(() => input().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...extra })));
  try {
    render(); await tick();
    const tree = host.querySelector<HTMLElement>('[role="tree"]')!;
    tree.scrollTop = 180; flushSync(() => tree.dispatchEvent(new Event("scroll", { bubbles: true })));
    type("候选");
    check(options().length === 8 && options()[0].textContent!.includes("候选"), "result cap or exact-first ordering lost");
    check(input().getAttribute("aria-expanded") === "true" && !input().hasAttribute("aria-activedescendant"), "typing prematurely selected a suggestion");
    const typed = query; key("Enter"); check(query === typed && list(), "Enter without preselection adopted a value");
    key("ArrowDown"); check(input().getAttribute("aria-activedescendant") === options()[0].id && selected === 0, "preselection navigated the tree");
    key("ArrowDown"); const chosen = options()[1].querySelector("strong")!.textContent!; key("Enter");
    check(query === chosen && !list() && document.activeElement === input() && selected === 0, "adopting a value lost focus, navigated or kept stale options");
    type("item_12"); check(options().some(option => option.textContent!.includes("资源 ID")), "resource category absent");
    const beforeEscape = query; key("Escape"); check(query === beforeEscape && !list() && clears === 0, "first Escape cleared the tree filter");
    key("Escape"); check(String(query) === "" && Number(clears) === 1 && expanded.size === 1 && tree.scrollTop === 180,
      `second Escape did not restore filter/scroll/expansion: ${JSON.stringify({ query, clears, expanded: expanded.size, scroll: tree.scrollTop, height: tree.clientHeight })}`);
    key("ArrowDown"); check(document.activeElement === tree, "empty query no longer enters the tree");

    type("候选"); key("ArrowDown");
    flushSync(() => input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "候" })));
    key("Enter", { isComposing: true }); key("Escape", { isComposing: true });
    check(String(query) === "候选" && Number(clears) === 1 && !list(), "Chinese composition adopted or cleared a query");
    flushSync(() => input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "候选" })));
    check(list() && !input().hasAttribute("aria-activedescendant"), "composition end restored a stale preselection");
    key("ArrowDown"); key("Enter", { keyCode: 229 }); check(list(), "legacy composition key code adopted a suggestion");

    for (const width of [306, 248]) {
      host.style.width = `${width}px`; await tick();
      const popup = host.querySelector<HTMLElement>(".tree-search-suggestions")!, pane = host.querySelector<HTMLElement>(".tree-pane")!;
      const p = popup.getBoundingClientRect(), r = pane.getBoundingClientRect();
      check(p.left >= r.left && p.right <= r.right + 1 && p.top >= r.top && popup.scrollWidth <= popup.clientWidth + 1, `suggestions overflowed ${width}px`);
    }
    host.style.width = "306px"; await tick();
    const checkpoint = (window as typeof window & { treeSearchVisualCheckpoint?: () => Promise<void> }).treeSearchVisualCheckpoint;
    if (checkpoint) await checkpoint();
    const oldOption = options()[0]; session++; render();
    check(!list(), "new snapshot retained old open suggestions");
    flushSync(() => oldOption.click()); check(query === "候选", "detached option changed the new snapshot filter");
    check(JSON.stringify(root) === source, "search suggestions changed captured node data");
    type("item_12"); root = { ...root, children: [{ ...makeNode("0/0"), text: "新快照", className: null, resourceId: null }] }; render();
    check(!list(), "replacement root leaked same-ID suggestions");
    type("item_12"); check(!list(), "old snapshot values remained searchable");
    check(source.includes("候选标题") && selected === 0, "suggestions navigated the selected node");
    return ["snapshot-only text/ID/type suggestions: exact-first, eight-item cap, keyboard preselection and explicit adoption",
      "IME composition/keyCode 229, Escape closes before clearing, existing tree focus/expansion/scroll restoration",
      "306/248px popup bounds; new session/root discard suggestions; input/pointer preview never navigates"];
  } finally { flushSync(() => mounted.unmount()); host.remove(); }
}
