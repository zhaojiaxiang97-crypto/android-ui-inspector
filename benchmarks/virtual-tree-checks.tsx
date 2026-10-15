import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { UiTree } from "../src/components/UiTree";
import { NodeHoverProvider, useNodeHover, useNodeHoverActions } from "../src/features/inspection/NodeHoverContext";
import { filterTree } from "../shared/tree-utils";
import { indexTree, TREE_ROW_HEIGHT, visibleTreeRows } from "../shared/visible-tree";
import type { UiNode } from "../shared/types";
import type { SetStateAction } from "react";
import { createTree, makeNode } from "./fixtures";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Virtual tree: ${message}`);
}

async function verifyNodeHoverBehavior() {
  const host = document.createElement("div");
  host.className = "app-shell inspection-active";
  host.style.width = "600px";
  document.body.append(host);
  const reactRoot = createRoot(host);
  let root = createTree(21);
  let session = 0;
  let query = "";
  let selectedId = root.id;
  let expanded: ReadonlySet<string> = new Set(indexTree(root).keys());
  let provider = true;
  let treeMounted = true;
  let focusKey: string | null = null;
  let api: ReturnType<typeof useNodeHover> | null = null;
  let actions: ReturnType<typeof useNodeHoverActions> | null = null;
  let ownerRenders = 0;
  let probeRenders = 0;
  let actionRenders = 0;
  let selectionCalls = 0;
  const checks: string[] = [];
  function HoverProbe() { api = useNodeHover(); probeRenders++; return null; }
  function ActionsProbe() { actions = useNodeHoverActions(); actionRenders++; return null; }
  const current = () => { check(api, "hover probe unavailable"); return api; };
  const row = (id: string) => [...host.querySelectorAll<HTMLElement>(".tree-row")].find(element => element.dataset.treeId === id);
  const viewport = () => host.querySelector<HTMLElement>(".ui-tree-scroll")!;
  const count = () => host.querySelectorAll(".tree-row").length;
  const draw = () => {
    ownerRenders++;
    const filtered = filterTree(root, { query, interactiveOnly: false, identifiedOnly: false });
    const children = <><HoverProbe /><ActionsProbe />{treeMounted && <div className="tree-pane" style={{ height: 480 }}><UiTree key={session} root={root}
      filteredRoot={filtered} filterActive={Boolean(query)} filterKey={query}
      filter={{ query, interactiveOnly: false, identifiedOnly: false }} selectedId={selectedId} expanded={expanded} focusKey={focusKey}
      onExpandedChange={next => {
        expanded = typeof next === "function" ? next(expanded) : next; draw();
      }} onSelect={node => { selectionCalls++; selectedId = node.id; draw(); }} onClearFilter={() => { query = ""; draw(); }} /></div>}</>;
    flushSync(() => reactRoot.render(provider ? <NodeHoverProvider root={root} sessionKey={session}>{children}</NodeHoverProvider> : children));
    void host.offsetHeight;
  };
  const hoverTree = (id: string) => {
    const element = row(id); check(element, `missing hover row ${id}`);
    flushSync(() => element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })));
  };
  const hoverCanvas = (id: string | null) => flushSync(() => current().publishHover(id, "canvas"));
  const bounded = () => {
    check(viewport().clientHeight > 0 && viewport().clientHeight < 480, "hover fixture has no bounded viewport");
    check(count() <= Math.ceil(viewport().clientHeight / TREE_ROW_HEIGHT) + 17, "hover added unbounded rows");
  };
  const scroll = async (top: number) => {
    flushSync(() => { viewport().scrollTop = top; viewport().dispatchEvent(new Event("scroll", { bubbles: true })); });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  };
  try {
    provider = false; draw();
    const fallback = current();
    flushSync(() => { fallback.publishHover("0", "tree"); fallback.clearHover("canvas"); });
    draw();
    check(current().hover === null && current().publishHover === fallback.publishHover && current().clearHover === fallback.clearHover,
      "standalone tree fallback is not empty and stable");
    provider = true; draw();
    checks.push("standalone trees keep stable empty hover actions");

    viewport().focus();
    const selectedBefore = selectedId;
    const expandedBefore = expanded;
    const activeBefore = viewport().getAttribute("aria-activedescendant");
    const scrollBefore = viewport().scrollTop;
    const ownerBefore = ownerRenders;
    hoverTree("0/0/0");
    check(current().hover?.nodeId === "0/0/0" && current().hover?.source === "tree", "tree enter did not publish hover");
    check(row("0/0/0")?.dataset.hovered === "true" && host.querySelectorAll(".tree-row.is-hovered").length === 1,
      "hover marked ancestors or siblings as hovered");
    const guide = host.querySelector<SVGElement>(".tree-hover-guide");
    check(guide?.dataset.hoverParentId === "0/0" && guide.dataset.hoverNodeId === "0/0/0"
      && guide.querySelectorAll("path").length === 1 && getComputedStyle(guide).pointerEvents === "none", "missing immediate parent guide");
    check(selectedId === selectedBefore && expanded === expandedBefore && selectionCalls === 0
      && viewport().getAttribute("aria-activedescendant") === activeBefore && viewport().scrollTop === scrollBefore
      && document.activeElement === viewport() && ownerRenders === ownerBefore, "hover moved selection, expansion, focus or owner state");
    checks.push("tree enter previews one row and its immediate parent guide without selection, expansion, focus or owner rerenders");

    const probesBefore = probeRenders;
    const actionsBefore = actionRenders;
    const actionsIdentity = actions;
    for (let move = 0; move < 100; move++) flushSync(() => row("0/0/0")!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
    check(probeRenders === probesBefore && actionRenders === actionsBefore && actions === actionsIdentity, "same-node moves caused subscriber renders");
    hoverCanvas("0/1/2");
    flushSync(() => viewport().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
    check(current().hover?.nodeId === "0/1/2" && current().hover?.source === "canvas"
      && row("0/1/2")?.dataset.hovered === "true" && actionRenders === actionsBefore,
      "old tree leave erased canvas hover or action-only sender subscribed to updates");
    check(row(root.id)?.getAttribute("aria-selected") === "true" && host.querySelectorAll('[aria-selected="true"]').length === 1,
      "canvas hover replaced clicked selection");
    checks.push("source handoff preserves canvas hover; repeated moves and action-only senders do not rerender");

    hoverTree("0/0/0");
    flushSync(() => row("0/0")!.querySelector<HTMLElement>(".tree-chevron")!.click());
    check(current().hover === null && !row("0/0/0"), "collapsed row retained tree hover");
    const collapsed = expanded;
    const collapsedScroll = viewport().scrollTop;
    hoverCanvas("0/0/0");
    check(!row("0/0/0") && expanded === collapsed && viewport().scrollTop === collapsedScroll,
      "canvas hover reopened or scrolled to a collapsed row");
    query = "Node 6"; draw();
    hoverTree("0/0/1");
    query = "no-such-node"; draw();
    check(current().hover === null && count() === 0 && expanded === collapsed, "filtered-out row retained hover or changed manual expansion");
    query = ""; draw();
    checks.push("collapsed and filtered rows clear tree hover; canvas preview does not reopen branches or move scroll");

    hoverTree("0/1");
    const staleSession = current();
    session++; draw();
    flushSync(() => staleSession.publishHover("0/1", "canvas"));
    check(current().hover === null, "retained callback restored a previous session hover");
    hoverCanvas("0/1");
    const staleTree = current();
    root = { ...root, children: root.children.filter(child => child.id !== "0/1") }; draw();
    flushSync(() => staleTree.publishHover("0/1", "canvas"));
    hoverCanvas("0/1");
    check(current().hover === null, "replacement tree or removed node retained hover");
    hoverTree("0/2");
    const staleTreeComponent = current();
    treeMounted = false; draw();
    check(current().hover === null, "unmounted tree component retained hover");
    provider = false; draw();
    flushSync(() => staleTreeComponent.publishHover("0/2", "tree"));
    check(current().hover === null, "unmounted provider callback leaked hover");
    checks.push("session/tree replacement, removed IDs, tree teardown and retained callbacks clear safely");

    root = createTree(25_000, "wide"); selectedId = root.id;
    expanded = new Set([root.id]); session++; provider = true; treeMounted = true; draw();
    bounded();
    hoverTree("0/0");
    await scroll(viewport().scrollHeight);
    bounded();
    check(current().hover === null, "virtual row eviction retained tree hover");
    const bottom = viewport().scrollTop;
    hoverCanvas("0/0");
    check(!row("0/0") && viewport().scrollTop === bottom && !host.querySelector(".tree-hover-guide"), "offscreen canvas hover mounted or scrolled rows");
    const last = root.children[root.children.length - 1].id;
    hoverTree(last);
    const clipped = host.querySelector<SVGElement>(".tree-hover-guide");
    check(clipped?.dataset.hoverParentId === root.id && clipped.querySelectorAll("path").length === 1
      && Number(clipped.getAttribute("height")) <= count() * TREE_ROW_HEIGHT,
      "virtual parent guide was not clipped to the bounded mounted window");
    checks.push("25k rows retain bounded DOM, clear evicted hover and clip the offscreen-parent guide");

    for (const width of [300, 248]) {
      host.style.width = `${width}px`;
      check(viewport().scrollWidth <= viewport().clientWidth, `hover guide overflows at ${width}px`);
      for (const element of host.querySelectorAll<HTMLElement>(".tree-row")) {
        check(element.getBoundingClientRect().height === TREE_ROW_HEIGHT, "hover guide changed virtual row height");
      }
    }
    flushSync(() => current().clearHover("tree"));
    viewport().focus({ preventScroll: true });
    flushSync(() => viewport().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
    hoverTree(root.children[root.children.length - 2].id);
    check(selectedId === last && document.activeElement === viewport() && row(last)?.getAttribute("aria-selected") === "true",
      "preview disturbed keyboard selection in a narrow virtual tree");
    checks.push("300/248px guides preserve fixed rows, keyboard focus and clicked selection");

    root = createTree(1);
    let parent = root;
    for (let depth = 1; depth < 512; depth++) {
      const child = makeNode(`${parent.id}/0`, depth);
      parent.children = [child]; parent = child;
    }
    selectedId = parent.id; expanded = new Set(indexTree(root).keys()); session++; draw();
    for (const width of [240, 306, 600]) {
      host.style.width = `${width}px`;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      bounded();
      const leaf = row(parent.id)!, ancestor = row(indexTree(root).get(parent.id)!.parentId!)!;
      const childToggle = leaf.querySelector(".tree-chevron")!.getBoundingClientRect();
      const parentToggle = ancestor.querySelector(".tree-chevron")!.getBoundingClientRect();
      const frame = viewport().getBoundingClientRect();
      check(Math.abs(childToggle.left - parentToggle.left - 12) < .01, "deep parent and child were flattened into one column");
      check(childToggle.left >= frame.left && childToggle.right <= frame.right && leaf.querySelector<HTMLElement>(".tree-primary")!.clientWidth >= 40,
        "deep selection lost its toggle or readable name in a narrow pane");
      const left = viewport().scrollLeft, top = viewport().scrollTop;
      hoverTree(parent.id);
      const connection = host.querySelector<SVGElement>(".tree-hover-guide")!;
      const dot = [...connection.querySelectorAll("circle")].at(-1)!;
      check(Number(connection.getAttribute("width")) > Number(dot.getAttribute("cx")) + 2
        && Math.abs(connection.getBoundingClientRect().left + Number(dot.getAttribute("cx")) - childToggle.left - childToggle.width / 2) < .01,
        "deep hover connection was clipped or did not match the child column");
      check(viewport().scrollLeft === left && viewport().scrollTop === top, "deep hover changed tree scrolling");
      await (window as Window & { lookinMigrationVisualCheckpoint?: (name: string) => Promise<void> }).lookinMigrationVisualCheckpoint?.(`deep-tree-${width}`);
    }
    const originalRoot = root, originalTop = viewport().scrollTop, originalLeft = viewport().scrollLeft;
    root = indexTree(root).get(indexTree(root).get(parent.id)!.parentId!)!.node;
    focusKey = root.id; draw();
    check(viewport().scrollLeft === 0, "focused shallow tree retained a deep horizontal offset");
    root = originalRoot; focusKey = null; draw();
    check(viewport().scrollLeft === originalLeft && viewport().scrollTop === originalTop, "leaving focus lost the deep tree's vertical or horizontal scroll position");
    const horizontal = viewport().scrollLeft, contentWidth = viewport().scrollWidth;
    await scroll(0);
    check(viewport().scrollLeft === horizontal && viewport().scrollWidth === contentWidth, "virtual eviction changed deep-tree horizontal extent");
    flushSync(() => viewport().dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
    check(selectedId === root.id && viewport().scrollLeft === 0, "returning to the root retained a deep horizontal offset");
    checks.push("512 levels retain parent/child columns, unclipped guides, horizontal reveal, focus return and stable virtual width at 240/306/600px");
    return checks;
  } finally {
    flushSync(() => reactRoot.unmount());
    host.remove();
  }
}

export async function verifyVirtualTreeBehavior() {
  const host = document.createElement("div");
  host.style.width = "600px";
  document.body.append(host);
  const reactRoot = createRoot(host);
  let root = createTree(21);
  let selectedId: string | null = root.id;
  let selectedNode: UiNode | null = null;
  let expanded: ReadonlySet<string> = new Set([root.id]);
  let selectionCalls = 0;
  let query = "";
  let session = 0;
  let reveal = 0;
  const checks: string[] = [];
  const onSelect = (node: UiNode) => { selectedNode = node; selectedId = node.id; selectionCalls += 1; draw(); };
  const clearFilter = () => { query = ""; draw(); };
  const updateExpanded = (next: SetStateAction<ReadonlySet<string>>) => {
    const value = typeof next === "function" ? next(expanded) : next;
    if (value === expanded) return;
    expanded = value;
    draw();
  };
  const draw = () => {
    const filtered = filterTree(root, { query, interactiveOnly: false, identifiedOnly: false });
    flushSync(() => reactRoot.render(<UiTree key={session} root={root} filteredRoot={filtered} expanded={expanded} filterActive={Boolean(query)} filterKey={query} filter={{ query, interactiveOnly: false, identifiedOnly: false }} selectedId={selectedId} revealRequest={reveal} onExpandedChange={updateExpanded} onSelect={onSelect} onClearFilter={clearFilter} />));
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
  const doubleClick = (element: HTMLElement) => {
    for (const detail of [1, 2]) flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail })));
    flushSync(() => element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 })));
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
    checks.push(...await verifyNodeHoverBehavior());
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

    toggle("0/0");
    doubleClick(row("0/0")!);
    check(count() === 9 && row("0/0")!.getAttribute("aria-expanded") === "true" && selectedId === "0/0", "double-click did not select and expand the parent");
    const expandedBefore = expanded;
    doubleClick(row("0/0")!);
    doubleClick(row("0/0/0")!);
    check(expanded.size === expandedBefore.size && [...expandedBefore].every(id => expanded.has(id))
      && count() === 9 && row("0/0")!.getAttribute("aria-expanded") === "true" && !expanded.has("0/0/0"),
      "double-click collapsed an open parent or expanded a leaf");
    doubleClick(row("0/0")!.querySelector<HTMLElement>(".tree-chevron")!);
    check(row("0/0")!.getAttribute("aria-expanded") === "false", "chevron double-click toggled twice or bubbled into row expansion");
    checks.push("compatibility double-click expands parents only; chevron double-click toggles once");

    query = "Node 6"; draw();
    check(count() === 3 && host.querySelector<HTMLButtonElement>(".tree-collapse-all")!.disabled, "filter auto expansion");
    flushSync(() => row("0")!.click());
    check(Object.is(selectedNode, root) && root.children.length === 4, "filtered selection returned a pruned node");
    query = ""; draw();
    checks.push("filtered tree returns original nodes and retains manual expansion");

    // A filtered path is a temporary presentation, not a real branch expansion.
    click(".tree-collapse-all");
    const beforeSearch = expanded;
    query = "Node 6"; draw();
    const matchId = "0/0/1";
    flushSync(() => row(matchId)!.click());
    check(expanded === beforeSearch && selectedNode === indexTree(root).get(matchId)!.node,
      "selecting a search result changed real expansion or returned a pruned node");
    check(row(matchId)?.querySelector("mark")?.textContent === "Node 6", "search match was not highlighted");
    check(row("0")?.dataset.searchMatch === "false" && row(matchId)?.dataset.searchMatch === "true",
      "ancestor paths are indistinguishable from actual matches");
    check(host.querySelector(".tree-hint")?.textContent === "1 匹配", "search count includes ancestor paths");
    key("Escape");
    check(query === "" && expanded === beforeSearch && count() === 1 && String(selectedId) === matchId,
      "clearing search reopened branches or changed the selected control");
    click(".tree-locate"); visibleSelection(matchId);
    check(expanded.has("0") && expanded.has("0/0"), "explicit locate failed after search was cleared");
    checks.push("highlighted matches, dimmed ancestor paths, Escape restores collapsed tree, explicit locate reopens only its path");

    const stableExpansion = expanded;
    query = "item_5"; draw();
    check(row("0/0/0")?.querySelector(".tree-match-detail mark")?.textContent === "item_5",
      "a hidden resource ID match has no visible search context");
    query = "android.widget.TextView"; draw();
    check(row(matchId)?.querySelector(".tree-match-detail mark")?.textContent === "android.widget.TextView",
      "full class search loses its match in a narrow tree");
    key("ArrowLeft");
    key("ArrowRight");
    key("Home");
    key("End");
    check(expanded === stableExpansion && Object.is(selectedNode, indexTree(root).get(selectedId!)?.node),
      "filtered keyboard navigation changed real expansion or lost node identity");
    query = ""; draw();
    check(expanded === stableExpansion, "changing or clearing queries expanded the underlying tree");
    // Pixel updates keep identity and must not replay a stale selection reveal.
    toggle("0/0");
    root = { ...root, children: root.children.map(child => ({ ...child })) }; draw();
    check(!expanded.has("0/0"), "same-ID snapshot update reopened a manually collapsed branch");
    checks.push("resource/type search context, keyboard filtered navigation and same-ID updates preserve real expansion");

    root = createTree(25_000); selectedId = root.id; expanded = new Set([root.id]); session += 1; draw();
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

    root = createTree(10_000, "wide"); selectedId = "0/9998"; expanded = new Set([root.id]); session += 1; draw();
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

    root = createTree(21); root.text = "Replacement snapshot"; selectedId = root.id; expanded = new Set([root.id]); session += 1; draw();
    check(count() === 5 && row("0")?.textContent?.includes("Replacement snapshot"), "snapshot session retained old tree state");
    selectedId = "missing"; draw();
    check(host.querySelectorAll('[aria-selected="true"]').length === 0 && host.querySelector<HTMLButtonElement>(".tree-locate")!.disabled, "removed ID did not degrade safely");
    checks.push("new snapshot resets state and missing selected IDs are safe");
    for (const size of [499, 500]) {
      root = createTree(size, "wide"); selectedId = root.id; expanded = new Set([root.id]); session += 1; draw();
      check(viewport().dataset.virtual === String(size >= 500), "virtual threshold boundary is wrong");
      if (size < 500) check(count() === size, "small list unexpectedly dropped rows");
      else bounded();
    }
    checks.push("499/500-row virtualization threshold boundary");

    root = createTree(5, "wide");
    Object.assign(root, { text: "LeakLauncherActivity", className: "LeakLauncherActivity" });
    Object.assign(root.children[0], { text: "Leaks", contentDesc: "泄漏列表", className: "android.widget.TextView" });
    Object.assign(root.children[1], { text: null, contentDesc: "头像", className: "android.widget.ImageView", clickable: true });
    Object.assign(root.children[2], { text: null, contentDesc: null, resourceId: "app:id/leak_canary_bottom_navigation_bar", className: "android.widget.LinearLayout" });
    Object.assign(root.children[3], { text: null, contentDesc: null, resourceId: null, className: "android.view.View" });
    let parent = root.children[2];
    for (let depth = 0; depth < 10; depth += 1) {
      const child = makeNode(`${parent.id}/0`, depth + 1);
      child.text = depth === 9 ? "Heap Dumps" : `Container ${depth}`;
      parent.children = [child]; parent = child;
    }
    selectedId = root.id; expanded = new Set(indexTree(root).keys()); session += 1;
    host.className = "app-shell inspection-active";
    draw(); viewport().style.height = "420px";
    for (const [id, name, kind] of [["0", "LeakLauncherActivity", "activity"], ["0/0", "Leaks", "text"], ["0/1", "头像", "image"], ["0/2", "leak_canary_bottom_navigation_bar", "linear"], ["0/3", "View", "leaf"]]) {
      check(row(id)?.querySelector(".tree-primary")?.textContent === name && row(id)?.dataset.treeKind === kind, `compact name/type mismatch: ${id}`);
    }
    check(row("0/2")?.querySelector(".tree-node-icon")?.getAttribute("title") === "线性布局 · LinearLayout", "icon tooltip does not explain the layout type");
    check(row("0/2")?.getAttribute("aria-label")?.includes("线性布局"), "icon meaning is missing from the accessible row name");
    const iconMasks = ["0", "0/0", "0/1", "0/2", "0/3"].map(id =>
      getComputedStyle(row(id)!.querySelector(".tree-node-icon")!, "::before").maskImage);
    check(iconMasks.every(mask => mask.startsWith("url(") && !mask.includes("undefined"))
      && new Set(iconMasks).size === iconMasks.length, "control types rely only on color instead of distinct shapes");
    check(row("0/3")?.querySelectorAll(".tree-row-content > span").length === 1, "unnamed node repeats its class");
    check(row("0/2")?.title.includes("app:id/leak_canary_bottom_navigation_bar"), "complete resource ID lost from tooltip");
    check(getComputedStyle(row("0/2")!.querySelector(".tree-primary")!).direction === "rtl", "long resource ID no longer preserves its distinguishing suffix");
    check(row("0/1")?.getAttribute("aria-label")?.includes("可点击"), "clickable state has no accessible name");
    for (const width of [240, 306, 600]) {
      host.style.width = `${width}px`;
      check((getComputedStyle(row("0/0")!.querySelector(".tree-class")!).display === "none") === (width <= 380), "narrow tree must reserve space for names instead of truncated type labels");
      check(host.scrollWidth <= host.clientWidth && viewport().scrollWidth >= viewport().clientWidth, `deep-tree scroll escaped its pane at ${width}px`);
      for (const element of host.querySelectorAll<HTMLElement>(".tree-row")) {
        check(element.getBoundingClientRect().height === TREE_ROW_HEIGHT, "compact CSS and virtual row heights differ");
        const icon = element.querySelector(".tree-node-icon")!.getBoundingClientRect();
        check(icon.width === 16 && icon.height === 16, "type icon shrank in a narrow sidebar");
        const name = element.querySelector<HTMLElement>(".tree-primary")!;
        check(name.clientWidth >= Math.min(40, name.scrollWidth), `name crushed at ${width}px: ${element.dataset.treeId}`);
      }
    }
    check(Number(row(parent.id)?.getAttribute("aria-level")) === 12 && Number.parseFloat(row(parent.id)!.style.paddingLeft) > Number.parseFloat(row(indexTree(root).get(parent.id)!.parentId!)!.style.paddingLeft),
      "deep compact rows lost their real level or parent/child indentation");
    query = "app:id/leak_canary_bottom_navigation_bar"; draw();
    check(row("0/2") && count() === 2, "compact label broke full-ID search");
    checks.push("compact semantic names, type icons, full-ID search/tooltips and 240/306/600px deep-tree layout");
    return { checks, threshold: 500, rowHeight: TREE_ROW_HEIGHT, overscan: 8 };
  } finally {
    flushSync(() => reactRoot.unmount());
    host.remove();
  }
}
