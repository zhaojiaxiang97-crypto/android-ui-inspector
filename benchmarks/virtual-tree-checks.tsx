import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { UiTree } from "../src/components/UiTree";
import { filterTree } from "../shared/tree-utils";
import { indexTree, TREE_ROW_HEIGHT, visibleTreeRows } from "../shared/visible-tree";
import type { UiNode } from "../shared/types";
import { createTree } from "./fixtures";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Virtual tree: ${message}`);
}

export async function verifyVirtualTreeBehavior() {
  const host = document.createElement("div");
  host.style.width = "600px";
  document.body.append(host);
  const reactRoot = createRoot(host);
  let root = createTree(21);
  let selectedId: string | null = root.id;
  let selectedNode: UiNode | null = null;
  let selectionCalls = 0;
  let query = "";
  let session = 0;
  let reveal = 0;
  const checks: string[] = [];
  const onSelect = (node: UiNode) => { selectedNode = node; selectedId = node.id; selectionCalls += 1; draw(); };
  const clearFilter = () => { query = ""; draw(); };
  const draw = () => {
    const filtered = filterTree(root, { query, interactiveOnly: false, identifiedOnly: false });
    flushSync(() => reactRoot.render(<UiTree key={session} root={root} filteredRoot={filtered} filterActive={Boolean(query)} filterKey={query} selectedId={selectedId} revealRequest={reveal} onSelect={onSelect} onClearFilter={clearFilter} />));
    void host.offsetHeight;
  };
  const row = (id: string) => [...host.querySelectorAll<HTMLElement>(".tree-row")].find((element) => element.dataset.treeId === id);
  const count = () => host.querySelectorAll(".tree-row").length;
  const viewport = () => host.querySelector<HTMLElement>(".ui-tree-scroll")!;
  const click = (selector: string) => {
    const element = host.querySelector<HTMLElement>(selector);
    check(element, `missing ${selector}`);
    flushSync(() => element.click());
  };
  const toggle = (id: string) => {
    const chevron = row(id)?.querySelector<HTMLElement>(".tree-chevron");
    check(chevron, `missing chevron ${id}`);
    flushSync(() => chevron.click());
  };
  const scroll = async (top: number) => {
    const element = viewport();
    flushSync(() => { element.scrollTop = top; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
    // React schedules scroll as a continuous event. Wait for a real browser
    // frame instead of mistaking the previous DOM for the scrolled result.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  };
  const key = (value: string) => {
    viewport().focus();
    flushSync(() => viewport().dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
  };
  const visibleSelection = (id: string) => {
    const element = row(id);
    check(element?.getAttribute("aria-selected") === "true", `selection ${id} is not mounted`);
    check(host.querySelectorAll('[aria-selected="true"]').length === 1, "multiple selected rows");
    const bounds = element.getBoundingClientRect();
    const frame = viewport().getBoundingClientRect();
    check(bounds.top >= frame.top - 1 && bounds.bottom <= frame.bottom + 1, `selection ${id} is outside the viewport`);
  };
  const bounded = () => {
    check(count() <= Math.ceil(viewport().clientHeight / TREE_ROW_HEIGHT) + 17, "too many DOM rows");
    for (const element of host.querySelectorAll<HTMLElement>(".tree-row")) {
      check(Math.abs(element.getBoundingClientRect().height - TREE_ROW_HEIGHT) < 0.01, "row height drift");
      check(Number(element.getAttribute("aria-level")) > 0 && Number(element.getAttribute("aria-posinset")) > 0 && Number(element.getAttribute("aria-setsize")) > 0, "missing hierarchy metadata");
    }
  };
  try {
    draw();
    check(count() === 5 && viewport().dataset.virtual === "false", "small tree default expansion");
    toggle("0/0");
    check(count() === 9 && selectionCalls === 0, "expand selected a row or failed");
    draw();
    check(count() === 9, "expansion lost on rerender");
    query = "no-such-node"; draw();
    check(count() === 0 && viewport().scrollTop === 0 && !viewport().hasAttribute("aria-activedescendant"), "empty filter state");
    click(".tree-empty .tree-clear");
    check(count() === 9, "empty filter discarded manual expansion");
    checks.push("small tree, expand without selecting, empty filter restores expansion");

    query = "Node 6"; draw();
    check(count() === 3 && host.querySelector<HTMLButtonElement>(".tree-collapse-all")!.disabled, "filter auto expansion");
    flushSync(() => row("0")!.click());
    check(Object.is(selectedNode, root) && root.children.length === 4, "filtered selection returned a pruned node");
    query = ""; draw();
    checks.push("filtered tree returns original nodes and retains manual expansion");

    root = createTree(25_000); selectedId = root.id; session += 1; draw();
    click(".tree-expand-all");
    check(viewport().dataset.rowCount === "25000" && viewport().dataset.virtual === "true", "expand-all did not enable virtualization");
    bounded();
    toggle("0/0");
    const collapsedCount = viewport().dataset.rowCount;
    check(Number(collapsedCount) < 25000, "branch was not collapsed");
    await scroll(viewport().scrollHeight); bounded();
    await scroll(0);
    check(row("0/0")?.getAttribute("aria-expanded") === "false" && viewport().dataset.rowCount === collapsedCount, "evicted branch lost its expansion state");
    checks.push("25k expand-all bounds DOM and preserves expansion across eviction");

    click(".tree-collapse-all");
    check(count() === 1 && viewport().scrollTop === 0 && viewport().dataset.virtual === "false", "collapse-all or threshold transition");
    const allRows = visibleTreeRows(root, new Set(), true);
    const target = allRows[allRows.length - 1].node.id;
    selectedId = target; reveal += 1; draw();
    visibleSelection(target);
    let ancestor = indexTree(root).get(target)?.parentId;
    const originalIndex = indexTree(root);
    while (ancestor) {
      const mounted = row(ancestor);
      if (mounted) check(mounted.getAttribute("aria-expanded") === "true", "target ancestor stayed closed");
      ancestor = originalIndex.get(ancestor)?.parentId;
    }
    checks.push("external deep selection opens ancestors and scrolls into view");

    root = createTree(10_000, "wide"); selectedId = "0/9998"; session += 1; draw();
    visibleSelection("0/9998"); bounded();
    await scroll(0);
    check(!row("0/9998") && !viewport().hasAttribute("aria-activedescendant"), `offscreen active descendant was left dangling: ${JSON.stringify({ top: viewport().scrollTop, count: count(), mounted: Boolean(row("0/9998")), active: viewport().getAttribute("aria-activedescendant") })}`);
    click(".tree-locate"); visibleSelection("0/9998");
    await scroll(0); reveal += 1; draw(); visibleSelection("0/9998");
    checks.push("offscreen and repeated same-ID locate with stable focus container");

    key("Home"); visibleSelection("0");
    key("End"); visibleSelection("0/9998");
    key("ArrowUp"); visibleSelection("0/9997");
    key("ArrowDown"); visibleSelection("0/9998");
    key("ArrowLeft"); visibleSelection("0");
    key("ArrowLeft"); check(count() === 1, "Left did not collapse parent");
    key("ArrowRight"); check(viewport().dataset.rowCount === "10000", "Right did not expand parent");
    key("ArrowRight"); visibleSelection("0/0");
    key(" "); key("Enter"); visibleSelection("0/0");
    check(document.activeElement === viewport(), "keyboard focus was lost on virtual rerender");
    checks.push("Home/End, arrows, Enter/Space and retained keyboard focus");

    for (const id of ["0/1", "0/10", "0/1"]) { selectedId = id; draw(); visibleSelection(id); }
    checks.push("adjacent positional IDs have exactly one selected row");

    selectedId = "0/9998"; draw();
    viewport().style.height = "320px";
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    // Explicit reveal must use the newly measured viewport height.
    reveal += 1; draw(); visibleSelection("0/9998"); bounded();
    checks.push("resized viewport keeps fixed row height and bounded DOM");

    root = createTree(21); root.text = "Replacement snapshot"; selectedId = root.id; session += 1; draw();
    check(count() === 5 && row("0")?.textContent?.includes("Replacement snapshot"), "snapshot session retained old tree state");
    selectedId = "missing"; draw();
    check(host.querySelectorAll('[aria-selected="true"]').length === 0 && host.querySelector<HTMLButtonElement>(".tree-locate")!.disabled, "removed ID did not degrade safely");
    checks.push("new snapshot resets state and missing selected IDs are safe");
    for (const size of [499, 500]) {
      root = createTree(size, "wide"); selectedId = root.id; session += 1; draw();
      check(viewport().dataset.virtual === String(size >= 500), "virtual threshold boundary is wrong");
      if (size < 500) check(count() === size, "small list unexpectedly dropped rows");
      else bounded();
    }
    checks.push("499/500-row virtualization threshold boundary");
    return { checks, threshold: 500, rowHeight: TREE_ROW_HEIGHT, overscan: 8 };
  } finally {
    flushSync(() => reactRoot.unmount());
    host.remove();
  }
}
