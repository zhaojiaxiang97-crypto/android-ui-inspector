import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { UiTree } from "../src/components/UiTree";
import { useInspectionWorkspace } from "../src/features/inspection/useInspectionWorkspace";
import { NodeHoverProvider, useNodeHoverActions } from "../src/features/inspection/NodeHoverContext";
import { filterTree, flattenNodes } from "../shared/tree-utils";
import { TREE_DETAIL_ROW_HEIGHT, TREE_ROW_HEIGHT, treeReadingAnchor, visibleTreeRows } from "../shared/visible-tree";
import { TREE_ROW_MODE_STORAGE_KEY } from "../shared/tree-row-mode";
import { TreeSearchInput } from "../src/components/TreeSearchInput";
import type { UiNode, UiSnapshot, ViewRefreshResult } from "../shared/types";
import { createTree, makeNode } from "./fixtures";

export async function verifyTreePresentation() {
  const oldApi = window.electronApi, oldTheme = document.documentElement.getAttribute("data-appearance");
  const stored = localStorage.getItem(TREE_ROW_MODE_STORAGE_KEY);
  const host = document.createElement("div"); host.className = "app-shell inspection-active";
  Object.assign(host.style, { width: "306px", height: "calc(100vh - 48px)", minHeight: "0", margin: "24px", position: "relative" }); document.body.append(host);
  let mounted = createRoot(host), workspace!: ReturnType<typeof useInspectionWorkspace>;
  let hover!: ReturnType<typeof useNodeHoverActions>;
  let pending: ((value: UiSnapshot) => void) | null = null;
  let finishRefresh: ((value: ViewRefreshResult) => void) | null = null;
  const unexpected: string[] = [], checks: string[] = [];
  const act = (action: () => void) => flushSync(action);
  const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Tree presentation: ${message}`); }
  const snapshot = (root: UiNode): UiSnapshot => ({ serial: "tree-presentation-fixture", root, nodeCount: flattenNodes(root).size,
    rawXml: null, screenshotDataUrl: null, xmlSize: 0, warning: null, error: null, inspectionSource: "debug-view", captureMode: "deep" });
  window.electronApi = {
    runtime: { sandboxed: true, contextIsolated: true }, onInspectionProgress: () => () => {}, onInspectionPreview: () => () => {},
    inspectDevice: () => new Promise(resolve => { pending = resolve; }), cancelInspection: async () => {},
    captureGroup: async () => { unexpected.push("group"); throw new Error("Unexpected image request"); },
    readViewStyle: async () => { unexpected.push("style"); throw new Error("Unexpected style request"); },
    refreshViewNode: () => new Promise(resolve => { finishRefresh = resolve; }),
    showLayerMenu: async () => { unexpected.push("menu"); return null; }, copyText: async () => {},
    probeAdb: async () => ({ adbPath: null, adbVersion: null, error: null, devices: [] }),
    exportSnapshot: async () => ({ canceled: true, filePath: null, error: null }),
    loadSnapshots: async () => ({ snapshots: [], error: null }), saveSnapshot: async () => ({ snapshots: [], error: null }),
    clearSnapshots: async () => ({ snapshots: [], error: null }),
  } as typeof window.electronApi;
  function HoverProbe() { hover = useNodeHoverActions(); return null; }
  function Harness() {
    workspace = useInspectionWorkspace();
    const full = workspace.snapshot?.root, root = workspace.layerFocus?.kind === "branch" ? workspace.layerFocus.node : full;
    if (!full || !root) return null;
    const filter = { query: workspace.treeQuery, interactiveOnly: workspace.interactiveOnly, identifiedOnly: workspace.identifiedOnly };
    const filtered = Boolean(filter.query.trim() || filter.interactiveOnly || filter.identifiedOnly);
    return <NodeHoverProvider root={full} sessionKey={workspace.treeSession}><HoverProbe /><div className="tree-pane" style={{ height: "100%", width: "100%" }}>
      <UiTree key={workspace.treeSession} root={root} filteredRoot={filterTree(root, filter)} filter={filter}
        filterActive={filtered} filterKey={JSON.stringify(filter)} selectedId={workspace.selectedNode?.id ?? null} expanded={workspace.treeExpandedIds}
        hiddenNodeIds={workspace.hiddenNodeIds} viewingScope={workspace.viewingScope} revealRequest={workspace.treeRevealRequest}
        restoreRequest={workspace.treeRestoreRequest} focusKey={workspace.layerFocus ? `${workspace.layerFocus.kind}:${workspace.layerFocus.node.id}` : null}
        onExpandedChange={workspace.handleExpandedChange} onSelect={workspace.setSelectedNode} onClearFilter={workspace.clearTreeFilter}
        history={workspace.nodeHistory} historyView={workspace.nodeHistoryView} />
      <div className="tree-tools"><div className="tree-search-row"><TreeSearchInput root={root} snapshotKey={workspace.treeSession}
        value={filter.query} onChange={workspace.setTreeQuery} onClear={workspace.clearTreeFilter} hasFilter={filtered} /></div></div>
    </div></NodeHoverProvider>;
  }
  const element = <T extends HTMLElement>(selector: string) => { const result = host.querySelector<T>(selector); assert(result, `missing ${selector}`); return result; };
  const viewport = () => element<HTMLElement>('[role="tree"]');
  const density = () => element<HTMLButtonElement>(".tree-density-toggle");
  const click = (selector: string) => act(() => element<HTMLElement>(selector).click());
  const scroll = (top: number, left = 0) => act(() => { viewport().scrollTo({ top, left, behavior: "instant" }); viewport().dispatchEvent(new Event("scroll", { bubbles: true })); });
  const key = (key: string, extra: KeyboardEventInit = {}) => act(() => viewport().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })));
  const wide = createTree(25_000, "wide"); wide.text = "当前窗口";
  wide.children.forEach((node, i) => { node.text = "同名业务控件"; node.resourceId = `com.example.benchmark:id/${"long_identifier_".repeat(4)}item_${i}`; node.attributes = { "view-ref": `View@${i}` }; });
  const original = JSON.stringify(wide);
  try {
    localStorage.removeItem(TREE_ROW_MODE_STORAGE_KEY);
    act(() => mounted.render(<Harness />)); act(() => workspace.showSnapshot(snapshot(wide))); await tick();
    assert(density().getAttribute("aria-pressed") === "false" && viewport().dataset.rowHeight === "28", "default compact mode changed");
    assert(viewport().dataset.virtual === "true" && host.querySelectorAll(".tree-row").length < 80, "25k tree lost virtualization");
    scroll(10_000 * TREE_ROW_HEIGHT + 7, 4);
    click(".tree-density-toggle"); await tick();
    assert(viewport().dataset.rowHeight === "44" && Math.abs(viewport().scrollTop - (10_000 * TREE_DETAIL_ROW_HEIGHT + 11)) <= 1,
      `density reused old pixel offset: ${viewport().scrollTop}`);
    assert(localStorage.getItem(TREE_ROW_MODE_STORAGE_KEY) === "detailed", "density preference was not saved");
    assert(workspace.selectedNode === wide && workspace.treeExpandedIds.has(wide.id), "density changed selected node or expansion");
    const subtitle = element<HTMLElement>(".tree-subtitle.is-resource");
    assert(subtitle.title.includes("long_identifier") && getComputedStyle(subtitle).direction === "rtl", "full ID or distinguishing tail lost");
    for (const row of host.querySelectorAll<HTMLElement>(".tree-row")) assert(Math.abs(row.getBoundingClientRect().height - 44) <= 1, "CSS row height drifted from virtual rows");
    const first = Number(viewport().dataset.windowStart), last = Number(viewport().dataset.windowEnd);
    act(() => hover.publishHover(wide.children[10_000].id, "canvas")); await tick();
    const guide = element<SVGElement & HTMLElement>(".tree-hover-guide");
    assert(Number(guide.getAttribute("height")) === (last - first) * 44 && Number.parseFloat(guide.style.top) === first * 44, "detailed hover guide drifted");
    checks.push("25k virtual tree: compact/detailed deterministic heights; ID tails; density retains reading node, selection, expansion and hover coordinates");

    const oldCondition = workspace.viewingScope;
    act(() => { workspace.setTreeQuery("同名业务"); workspace.setInteractiveOnly(true); workspace.setIdentifiedOnly(true); }); await tick();
    assert(!oldCondition.clearQuery() && workspace.treeQuery === "同名业务", "old condition callback changed the current scope");
    assert(host.querySelectorAll(".tree-scope-condition").length === 3, "combined filter scope missing");
    click(".tree-scope-query");
    assert(String(workspace.treeQuery) === "" && workspace.interactiveOnly && workspace.identifiedOnly, "keyword exit cleared other filters");
    click(".tree-scope-interactive"); assert(!workspace.interactiveOnly && workspace.identifiedOnly, "interactive exit changed identified condition");
    click(".tree-scope-identified"); await tick();
    assert(Math.abs(viewport().scrollTop - (10_000 * TREE_DETAIL_ROW_HEIGHT + 11)) <= 1, "clearing filters lost detailed reading position");
    scroll(5000 * 44 + 11);
    act(() => workspace.setSelectedNode(wide.children[5200])); await tick();
    const historyTop = viewport().scrollTop;
    act(() => workspace.setSelectedNode(wide.children[5300])); await tick();
    click(".tree-density-toggle"); click(".node-history-back"); await tick();
    const rows = visibleTreeRows(wide, workspace.treeExpandedIds);
    const anchor = treeReadingAnchor(rows, historyTop, 44);
    assert(workspace.selectedNode === wide.children[5200] && Math.abs(viewport().scrollTop - (Math.floor(historyTop / 44) * 28 + anchor.fraction * 28)) <= 1,
      `history reused old-density pixels: ${viewport().scrollTop}`);
    checks.push("independent query/interactive/identified exits; filter reading restoration; history restores nodes across density changes");

    const deep = Array.from({ length: 512 }, (_, i) => ({ ...makeNode(`opaque-deep-${i}`, i), text: `第 ${i + 1} 级业务控件`, resourceId: i % 2 ? `app:id/${"very_long_".repeat(5)}deep_${i}` : null }));
    deep.forEach((node, i) => { if (deep[i + 1]) node.children = [deep[i + 1]]; });
    deep[0].attributes = { "debug-process-id": "fixture-pid", "debug-window-name": "fixture-window" };
    const stale = workspace.viewingScope;
    act(() => workspace.showSnapshot(snapshot(deep[0]), deep[511].id)); await tick();
    assert(!stale.restoreAll(), "old scope callback modified a new snapshot");
    assert(viewport().dataset.virtual === "true" && viewport().scrollLeft > 6000 && host.querySelectorAll(".tree-row").length < 80, "512-level row reveal lost virtualization/horizontal positioning");
    const active = () => element<HTMLElement>('.tree-row[aria-selected="true"]');
    const before = workspace.selectedNode;
    key("ArrowUp", { isComposing: true }); key("ArrowUp", { keyCode: 229 }); assert(workspace.selectedNode === before, "IME navigated the tree");
    key("ArrowUp"); assert(workspace.selectedNode === deep[510], "detailed keyboard tree navigation failed");
    click(".tree-density-toggle"); await tick();
    key("Enter"); await tick();
    const selectedBounds = active().getBoundingClientRect(), viewportBounds = viewport().getBoundingClientRect();
    assert(selectedBounds.top >= viewportBounds.top - 1 && selectedBounds.bottom <= viewportBounds.bottom + 1, "density hid the deep selected row");
    act(() => workspace.handleLayerAction("hide", deep[510]));
    const expansion = workspace.treeExpandedIds;
    act(() => workspace.handleLayerAction("focus-branch", deep[508]));
    act(() => { workspace.setTreeQuery("业务控件"); workspace.setInteractiveOnly(true); workspace.setIdentifiedOnly(true); }); await tick();
    assert(workspace.viewingScope.focusLabel === deep[508].text && workspace.viewingScope.hiddenCount === 1 && host.querySelectorAll(".tree-scope-condition").length === 5, "scope combination omitted focus or hand-hidden nodes");
    click(".tree-scope-hidden"); assert(!workspace.hiddenNodeIds.size && workspace.layerFocus && workspace.treeQuery && workspace.interactiveOnly && workspace.identifiedOnly, "restore-hidden changed another condition");
    act(() => workspace.handleLayerAction("hide", deep[509]));
    click(".tree-scope-restore"); await tick();
    assert(!workspace.layerFocus && !workspace.treeQuery && !workspace.interactiveOnly && !workspace.identifiedOnly && !workspace.hiddenNodeIds.size,
      "restore-all did not restore complete view");
    assert(workspace.treeExpandedIds === expansion && workspace.selectedNode === deep[510], "restore-all changed collapse preference or return selection");
    checks.push("512-level locate and keyboard/IME; stale scope callbacks rejected; focus/filter/manual-hidden combination exits preserve return selection and expansion");

    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === TREE_ROW_MODE_STORAGE_KEY) throw new Error("fixture store blocked"); setItem.call(this, key, value); };
    try { click(".tree-density-toggle"); assert(host.querySelector(".tree-mode-save-error") && viewport().dataset.rowHeight === "28", "storage failure disabled density or was invisible"); }
    finally { Storage.prototype.setItem = setItem; }
    click(".tree-density-toggle"); assert(!host.querySelector(".tree-mode-save-error"), "successful save did not clear storage failure");
    act(() => mounted.unmount()); mounted = createRoot(host); act(() => mounted.render(<Harness />)); act(() => workspace.showSnapshot(snapshot(deep[0]), deep[511].id)); await tick();
    assert(viewport().dataset.rowHeight === "44", "remount lost saved detailed mode");
    const current = workspace.viewingScope;
    let capture!: Promise<UiSnapshot | null>;
    act(() => { capture = workspace.inspectDevice("fixture"); });
    assert(workspace.inspectionLoading && !current.restoreAll() && workspace.viewingScope.disabledReason?.includes("采集中"), "busy or retained scope callback changed capture state");
    act(() => pending!(snapshot(deep[0]))); await capture; await tick();
    const beforeRefresh = workspace.viewingScope;
    let refresh!: Promise<void>;
    act(() => { refresh = workspace.refreshViewNode(deep[0]); });
    assert(workspace.viewingScope.disabledReason?.includes("刷新中") && !beforeRefresh.restoreAll(), "refresh busy state allowed scope mutation");
    act(() => finishRefresh!({ nodes: [{ ...deep[0] }], failures: [] })); await refresh; await tick();
    assert(!workspace.viewingScope.disabledReason && !beforeRefresh.restoreAll(), "refresh completion accepted an old scope callback");
    assert(!unexpected.length && JSON.stringify(wide) === original, "presentation requested device work or changed captured data");
    checks.push("local preference remount; blocked storage stays usable with visible error; capture/refresh busy and retained callbacks reject mutations; zero extra device reads");

    act(() => workspace.setSelectedNode(deep[4]));
    act(() => workspace.handleLayerAction("focus-branch", deep[1]));
    act(() => { workspace.setTreeQuery("业务控件"); workspace.setIdentifiedOnly(true); workspace.handleLayerAction("hide", deep[3]); }); await tick();
    const visual = async (theme: string, width: number) => {
      document.documentElement.dataset.appearance = theme; host.style.width = `${width}px`; await tick(); await tick(); await tick();
      const pane = element<HTMLElement>(".tree-pane").getBoundingClientRect();
      assert(element<HTMLElement>(".tree-hint").scrollWidth <= element<HTMLElement>(".tree-hint").clientWidth + 1, "tree count was truncated");
      const secondary = element<HTMLElement>(".tree-subtitle.is-resource");
      assert(secondary.clientWidth > 60 && secondary.clientWidth <= width && secondary.scrollWidth > secondary.clientWidth
        && secondary.getBoundingClientRect().right <= pane.right + 1, "long ID tail was not constrained to the visible pane");
      const hiddenBadge = host.querySelector<HTMLElement>('.tree-row [data-node-status="user-hidden"]');
      if (hiddenBadge) assert(hiddenBadge.getBoundingClientRect().right <= pane.right + 1, "manual hidden badge was clipped beside detailed text");
      const hint = element<HTMLElement>(".tree-hint").getBoundingClientRect(), toolbar = element<HTMLElement>(".tree-toolbar").getBoundingClientRect();
      assert(hint.top >= toolbar.top && hint.bottom <= toolbar.bottom + 1, "wrapped count was covered by the next toolbar");
      assert(pane.bottom <= innerHeight + 1, "fixture toolbar or viewport left the visible window at zoom");
      for (const selector of [".tree-viewing-scope", ".tree-toolbar", ".tree-expansion-presets", ".tree-tools"]) {
        const control = element<HTMLElement>(selector), bounds = control.getBoundingClientRect();
        assert(bounds.left >= pane.left - 1 && bounds.right <= pane.right + 1 && control.scrollWidth <= control.clientWidth + 1, `controls overflow ${theme}/${width}: ${selector}`);
      }
      return { theme, width, rowHeight: viewport().dataset.rowHeight, mountedRows: host.querySelectorAll(".tree-row").length,
        viewport: { width: viewport().clientWidth, left: viewport().scrollLeft }, subtitle: { width: secondary.clientWidth, left: secondary.getBoundingClientRect().left - pane.left, right: secondary.getBoundingClientRect().right - pane.left, style: secondary.parentElement!.style.maxWidth },
        toolbar: { height: element<HTMLElement>(".tree-toolbar").clientHeight, hintTop: element<HTMLElement>(".tree-hint").offsetTop, hintHeight: element<HTMLElement>(".tree-hint").clientHeight } };
    };
    for (const theme of ["dark", "light"]) for (const width of [306, 248]) await visual(theme, width);
    (window as typeof window & { setTreePresentationVisual?: typeof visual }).setTreePresentationVisual = visual;
    const checkpoint = (window as typeof window & { treePresentationVisualCheckpoint?: () => Promise<void> }).treePresentationVisualCheckpoint;
    if (checkpoint) await checkpoint();
    checks.push("dark/light themes and actual 306/248px pane widths: scope, density, history and tree tools remain bounded");
    return { checks, unexpected };
  } finally {
    act(() => mounted.unmount()); host.remove(); window.electronApi = oldApi;
    if (stored === null) localStorage.removeItem(TREE_ROW_MODE_STORAGE_KEY); else localStorage.setItem(TREE_ROW_MODE_STORAGE_KEY, stored);
    if (oldTheme === null) document.documentElement.removeAttribute("data-appearance"); else document.documentElement.setAttribute("data-appearance", oldTheme);
  }
}
