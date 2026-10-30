import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { UiTree } from "../src/components/UiTree";
import { TreeSearchInput } from "../src/components/TreeSearchInput";
import { useInspectionWorkspace } from "../src/features/inspection/useInspectionWorkspace";
import { NodeHoverProvider } from "../src/features/inspection/NodeHoverContext";
import { filterTree, flattenNodes } from "../shared/tree-utils";
import { treeExpansionForBranch } from "../shared/tree-collapse";
import { TREE_ROW_MODE_STORAGE_KEY } from "../shared/tree-row-mode";
import type { InspectionPreview, LayerImageAction, LayerMenuAction, LayerMenuOptions, UiNode, UiSnapshot, ViewRefreshResult } from "../shared/types";
import { createTree, makeNode as fixtureNode } from "./fixtures";

export async function verifyTreeRound3() {
  const oldApi = window.electronApi, oldTheme = document.documentElement.getAttribute("data-appearance");
  const stored = localStorage.getItem(TREE_ROW_MODE_STORAGE_KEY);
  const host = document.createElement("div"); host.className = "app-shell inspection-active";
  Object.assign(host.style, { width: "306px", height: "calc(100vh - 48px)", minHeight: "0", margin: "24px", position: "relative" });
  document.body.append(host);
  const mounted = createRoot(host);
  let workspace!: ReturnType<typeof useInspectionWorkspace>, finishMenu!: (value: LayerMenuAction) => void;
  let menuOptions: LayerMenuOptions | undefined, callbackVersion = 1;
  let preview!: (event: InspectionPreview) => void, captureRequestId = "";
  let finishCapture!: (value: UiSnapshot) => void, finishRefresh!: (value: ViewRefreshResult) => void;
  const imageActions: { action: LayerImageAction; node: UiNode; version: number }[] = [], unexpected: string[] = [], checks: string[] = [];
  const act = (action: () => void) => flushSync(action);
  const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Tree round3: ${message}`); }
  const snapshot = (root: UiNode): UiSnapshot => ({ serial: "tree-round3-fixture", root, nodeCount: flattenNodes(root).size, rawXml: null,
    screenshotDataUrl: null, xmlSize: 0, warning: null, error: null, inspectionSource: "debug-view", captureMode: "deep" });
  const makeNode = (id: string, text = "普通控件") => ({ ...fixtureNode(id), text, resourceId: null, contentDesc: null, className: "android.widget.FrameLayout" });
  window.electronApi = {
    probeAdb: async () => ({ adbPath: null, adbVersion: null, error: null, devices: [] }), copyText: async () => {},
    exportSnapshot: async () => ({ canceled: true, filePath: null, error: null }),
    loadSnapshots: async () => ({ snapshots: [], error: null }), saveSnapshot: async () => ({ snapshots: [], error: null }), clearSnapshots: async () => ({ snapshots: [], error: null }),
    runtime: { sandboxed: true, contextIsolated: true }, onInspectionProgress: () => () => {}, onInspectionPreview: callback => { preview = callback; return () => {}; },
    inspectDevice: (_serial, requestId) => new Promise(resolve => { captureRequestId = requestId ?? ""; finishCapture = resolve; }), cancelInspection: async () => {},
    refreshViewNode: () => new Promise(resolve => { finishRefresh = resolve; }),
    captureGroup: async () => { unexpected.push("group"); throw new Error("Unexpected image request"); },
    readViewStyle: async () => { unexpected.push("style"); throw new Error("Unexpected style request"); },
    showLayerMenu: async (_canHide, _canRestore, _hasFocus, options) => { menuOptions = options; return new Promise(resolve => { finishMenu = resolve; }); },
  } as typeof window.electronApi;
  function Harness() {
    const version = callbackVersion;
    workspace = useInspectionWorkspace({
      onImageAction: (action, node) => imageActions.push({ action, node, version }),
      imageScopesForNode: () => [{ scope: "own", available: true, label: "自身图", detail: "已有图片" }, { scope: "branch", available: false, label: "分支图", detail: "缺图" }],
    });
    const full = workspace.snapshot?.root, root = workspace.layerFocus?.kind === "branch" ? workspace.layerFocus.node : full;
    if (!full || !root) return null;
    const filter = { query: workspace.treeQuery, interactiveOnly: workspace.interactiveOnly, identifiedOnly: workspace.identifiedOnly };
    const filtered = Boolean(filter.query.trim() || filter.interactiveOnly || filter.identifiedOnly);
    return <NodeHoverProvider root={root} sessionKey={workspace.treeSession}><div className="tree-pane" style={{ height: "100%", width: "100%" }}>
      <UiTree key={workspace.treeSession} root={root} filteredRoot={filterTree(root, filter)} filter={filter} filterActive={filtered} filterKey={JSON.stringify(filter)}
        selectedId={workspace.selectedNode?.id ?? null} expanded={workspace.treeExpandedIds} hiddenNodeIds={workspace.hiddenNodeIds} viewingScope={workspace.viewingScope}
        searchNavigation={workspace.treeSearchNavigation} revealRequest={workspace.treeRevealRequest} restoreRequest={workspace.treeRestoreRequest}
        focusKey={workspace.layerFocus ? `${workspace.layerFocus.kind}:${workspace.layerFocus.node.id}` : null} inspectionSource="debug-view" captureMode="deep"
        expansionDisabled={workspace.inspectionLoading || Boolean(workspace.viewRefreshingNodeId)} onExpandedChange={workspace.handleExpandedChange}
        onSelect={workspace.setSelectedNode} onClearFilter={workspace.clearTreeFilter} onContextMenu={workspace.openLayerMenu} history={workspace.nodeHistory} historyView={workspace.nodeHistoryView} />
      <div className="tree-tools"><div className="tree-search-row"><TreeSearchInput root={root} snapshotKey={workspace.treeSession} value={filter.query}
        onChange={workspace.setTreeQuery} onClear={workspace.clearTreeFilter} hasFilter={filtered} searchNavigation={workspace.treeSearchNavigation}
        disabled={workspace.inspectionLoading || Boolean(workspace.viewRefreshingNodeId)} /></div></div>
    </div></NodeHoverProvider>;
  }
  const element = <T extends HTMLElement>(selector: string) => { const value = host.querySelector<T>(selector); assert(value, `missing ${selector}`); return value; };
  const viewport = () => element<HTMLElement>('[role="tree"]');
  const input = () => element<HTMLInputElement>(".tree-search");
  const click = (selector: string) => act(() => element<HTMLElement>(selector).click());
  const key = (target: HTMLElement, key: string, extra: KeyboardEventInit = {}) => act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })));
  const openMenu = async (node: UiNode) => { let promise!: Promise<void>; act(() => { promise = workspace.openLayerMenu(node); }); await tick(); return { promise }; };
  const finish = async (promise: Promise<void>, action: LayerMenuAction) => { act(() => finishMenu(action)); await promise; await tick(); };
  try {
    localStorage.removeItem(TREE_ROW_MODE_STORAGE_KEY);
    act(() => mounted.render(<Harness />));
    const tree = createTree(25_000), branch = tree.children[0], side = tree.children[1]; tree.text = "当前窗口";
    const treeBefore = JSON.stringify(tree);
    act(() => workspace.showSnapshot(snapshot(tree))); await tick();
    act(() => workspace.setTreeExpandedIds(new Set([tree.id, side.id, side.children[0].id]))); await tick();
    const outside = [...workspace.treeExpandedIds].filter(id => !flattenNodes(branch).has(id));
    act(() => workspace.handleLayerAction("expand-branch", branch)); await tick();
    const branchNodes = flattenNodes(branch);
    for (const node of branchNodes.values()) assert(workspace.treeExpandedIds.has(node.id) === Boolean(node.children.length), "branch expansion left a descendant collapsed");
    assert(outside.every(id => workspace.treeExpandedIds.has(id)) && !workspace.treeExpandedIds.has(side.children[1].id), "branch expansion changed a neighbor");
    const beforeCollapse = workspace.treeExpandedIds;
    act(() => workspace.handleLayerAction("collapse-children", branch)); await tick();
    assert(workspace.treeExpandedIds.has(branch.id) && branch.children.every(child => !workspace.treeExpandedIds.has(child.id)), "collapse-children did not retain the target open");
    assert(outside.every(id => workspace.treeExpandedIds.has(id)), "collapse-children changed a neighbor");
    const descendant = [...branchNodes.values()].at(-1)!;
    act(() => workspace.setSelectedNode(descendant)); await tick();
    act(() => workspace.handleLayerAction("collapse-children", branch)); await tick();
    const expected = treeExpansionForBranch(branch, "collapse-children", beforeCollapse, descendant.id);
    assert([...expected].every(id => workspace.treeExpandedIds.has(id)), "collapse-children hid the selected path");
    const expansion = workspace.treeExpandedIds;
    act(() => workspace.setTreeQuery("synthetic-target")); await tick();
    act(() => workspace.handleLayerAction("expand-branch", branch));
    assert(workspace.treeExpandedIds === expansion, "filtered branch action changed real expansion");
    const filteredMenu = await openMenu(branch);
    assert(menuOptions?.expandable === false && menuOptions.hasChildren === true, "filtered menu enabled expansion"); await finish(filteredMenu.promise, null);
    act(() => workspace.clearTreeFilter()); await tick();
    assert(JSON.stringify(tree) === treeBefore, "branch operations modified captured nodes");
    checks.push("25k branch expansion/collapse: other branches unchanged, selected path retained, filtered gate and captured data preserved");

    const parent = makeNode("opaque-parent", "隐藏父层"), a = makeNode("opaque-a", "巡览目标"), b = makeNode("opaque-b", "巡览目标"), root = makeNode("opaque-root", "当前窗口");
    root.children = [parent, b]; parent.children = [a];
    root.attributes = { "debug-process-id": "fixture-pid", "debug-window-name": "fixture-window", "view-ref": "Root@fixture" };
    a.attributes = { "view-ref": "A@fixture" }; b.attributes = { "view-ref": "B@fixture" };
    act(() => workspace.showSnapshot(snapshot(root), a.id)); await tick();
    act(() => workspace.handleLayerAction("hide", a)); act(() => workspace.handleLayerAction("hide", b)); await tick();
    const restore = await openMenu(a); assert(menuOptions?.canRestoreSelected, "hidden selected node lacks restore action");
    await finish(restore.promise, "restore-selected");
    assert(!workspace.hiddenNodeIds.has(a.id) && workspace.hiddenNodeIds.has(b.id) && workspace.selectedNode === a, "single restore changed another hidden item or selection");
    act(() => workspace.handleLayerAction("hide", parent)); act(() => workspace.handleLayerAction("hide", a)); await tick();
    const parentMenu = await openMenu(a); assert(menuOptions?.hiddenAncestorLabel === "隐藏父层", "hidden parent menu reason missing");
    await finish(parentMenu.promise, "restore-selected");
    assert(workspace.hiddenNodeIds.has(parent.id) && !workspace.hiddenNodeIds.has(a.id) && workspace.viewingScope.selectedHiddenAncestorLabel === parent.text,
      "restoring a hidden child cleared its parent or lost the blocker reason");
    const retainedParentScope = workspace.viewingScope;
    act(() => workspace.setSelectedNode(b)); await tick();
    assert(!retainedParentScope.locateHiddenAncestor?.() && workspace.selectedNode === b, "retained parent locator changed a later selection");
    act(() => workspace.setSelectedNode(a)); await tick();
    click(".tree-scope-locate-parent"); await tick();
    assert(workspace.selectedNode === parent && workspace.hiddenNodeIds.has(parent.id) && workspace.hiddenNodeIds.has(b.id), "locating hidden parent changed hiding");
    a.visibleToUser = false; a.layerImageDataUrl = undefined;
    act(() => workspace.setSelectedNode(a)); await tick(); act(() => workspace.handleLayerAction("restore-selected", parent)); await tick();
    assert(!a.visibleToUser && !a.layerImageDataUrl && !workspace.viewingScope.selectedHiddenAncestorLabel, "local restore invented visibility or an image");
    checks.push("restore one of two hidden nodes; parent/child reasons and locate action; device invisible/missing image stay unchanged");

    act(() => workspace.handleLayerAction("restore")); await tick();
    const imageMenu = await openMenu(a);
    assert(menuOptions?.imageScopes?.length === 2 && !menuOptions.imageScopes[1].available, "image scopes missing");
    callbackVersion = 2; act(() => mounted.render(<Harness />)); await tick();
    const oldExpansion = workspace.treeExpandedIds;
    await finish(imageMenu.promise, "preview-image-own");
    assert(imageActions.length === 1 && imageActions[0].node === a && imageActions[0].version === 2 && workspace.treeExpandedIds === oldExpansion, "image dispatch used stale callback or entered expansion");
    const unavailable = await openMenu(a); await finish(unavailable.promise, "save-image-branch"); assert(imageActions.length === 1, "unavailable image action dispatched");
    const changedSelection = await openMenu(a); act(() => workspace.setSelectedNode(b)); await tick(); await finish(changedSelection.promise, "copy-image-own");
    assert(imageActions.length === 1, "late menu wrote after selection changed");
    const changedScope = await openMenu(a); act(() => workspace.setTreeQuery("巡览目标")); await tick(); await finish(changedScope.promise, "copy-image-own");
    assert(imageActions.length === 1, "late menu wrote after filter changed");
    act(() => workspace.clearTreeFilter()); await tick();
    const changedRoot = await openMenu(a), nextRoot = structuredClone(root);
    act(() => workspace.showSnapshot(snapshot(nextRoot))); await tick(); await finish(changedRoot.promise, "restore-selected");
    assert(!workspace.hiddenNodeIds.size && !imageActions.slice(1).length, "old menu changed a new same-ID snapshot");
    act(() => workspace.handleLayerAction("hide", a)); assert(!workspace.hiddenNodeIds.size, "stale original node acted on a same-ID replacement");
    const canceled = await openMenu(nextRoot.children[1]); await finish(canceled.promise, null); assert(imageActions.length === 1, "cancelled menu dispatched");
    checks.push("menu image actions use latest callbacks and original target; unavailable/cancelled/stale selection, scope and same-ID snapshot replies rejected");

    act(() => workspace.showSnapshot(snapshot(root))); await tick();
    act(() => workspace.setTreeQuery("巡览目标")); await tick();
    assert(Number(workspace.treeSearchNavigation.count) === 2 && workspace.treeSearchNavigation.position === null && workspace.selectedNode === root,
      "search counted ancestors or selected without explicit navigation");
    click(".tree-search-previous"); await tick(); assert(workspace.selectedNode === a && workspace.treeSearchNavigation.position === 1, "first backward search did not start at first match");
    click(".tree-search-previous"); await tick(); assert(workspace.selectedNode === b && workspace.treeSearchNavigation.position === 2, "backward search did not wrap");
    act(() => viewport().focus()); key(viewport(), "g", { metaKey: true }); await tick(); assert(workspace.selectedNode === a, "tree shortcut did not wrap forward");
    key(viewport(), "G", { ctrlKey: true, shiftKey: true }); await tick(); assert(workspace.selectedNode === b, "reverse Ctrl shortcut failed");
    key(viewport(), "g", { metaKey: true, isComposing: true }); key(viewport(), "g", { metaKey: true, keyCode: 229 }); assert(workspace.selectedNode === b, "tree IME triggered search navigation");
    act(() => input().focus()); key(input(), "g", { ctrlKey: true }); await tick(); assert(workspace.selectedNode === a && document.activeElement === input(), "search shortcut moved input focus or failed to navigate");
    const selectedBefore = workspace.selectedNode;
    act(() => input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))); key(input(), "g", { metaKey: true });
    assert(workspace.selectedNode === selectedBefore, "input composition triggered navigation");
    act(() => input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    key(input(), "ArrowDown"); key(input(), "Enter"); await tick(); assert(workspace.selectedNode === selectedBefore, "suggestion Enter navigated nodes");
    const elsewhere = document.createElement("input"); host.append(elsewhere); elsewhere.focus(); key(elsewhere, "g", { ctrlKey: true }); assert(workspace.selectedNode === selectedBefore, "shortcut escaped tree/search focus"); elsewhere.remove();
    act(() => workspace.setTreeQuery("无匹配内容")); await tick(); assert(Number(workspace.treeSearchNavigation.count) === 0 && element<HTMLButtonElement>(".tree-search-next").disabled && !workspace.treeSearchNavigation.next(), "zero matches were navigable");
    act(() => workspace.clearTreeFilter()); await tick(); assert(!host.querySelector(".tree-search-matches"), "clearing filter kept obsolete navigation");
    checks.push("search excludes ancestors; explicit previous/next first match and cyclic order; tree/input shortcuts and focus; IME, suggestion Enter, out-of-scope focus and zero-match gates");

    const deep = Array.from({ length: 512 }, (_, i) => makeNode(`deep-${i}`, i === 511 ? "深层巡览目标" : `层 ${i}`));
    deep.forEach((node, i) => { if (deep[i + 1]) node.children = [deep[i + 1]]; });
    act(() => workspace.showSnapshot(snapshot(deep[0]))); await tick();
    act(() => workspace.setTreeExpandedIds(new Set([deep[0].id]))); await tick();
    const realExpansion = workspace.treeExpandedIds;
    act(() => workspace.setTreeQuery("深层巡览目标")); await tick();
    click(".tree-search-next"); await tick();
    assert(workspace.selectedNode === deep[511] && Number(workspace.treeSearchNavigation.count) === 1 && viewport().scrollLeft > 6000
      && viewport().dataset.virtual === "true" && host.querySelectorAll(".tree-row").length < 80 && workspace.treeExpandedIds === realExpansion,
      "512-level search lost virtual reveal or changed expansion");
    click(".tree-density-toggle"); await tick(); click(".tree-search-next"); await tick();
    const active = element<HTMLElement>('.tree-row[aria-selected="true"]'), bounds = active.getBoundingClientRect(), viewBounds = viewport().getBoundingClientRect();
    assert(viewport().dataset.rowHeight === "44" && bounds.top >= viewBounds.top - 1 && bounds.bottom <= viewBounds.bottom + 1, "detailed search reveal hid the active deep match");
    act(() => workspace.clearTreeFilter()); await tick(); assert(workspace.treeExpandedIds === realExpansion, "clear search expanded its selected deep path");
    act(() => workspace.showSnapshot(snapshot(root), a.id)); await tick();
    act(() => workspace.handleLayerAction("focus-branch", parent)); await tick(); act(() => workspace.setTreeQuery("巡览目标")); await tick();
    assert(Number(workspace.treeSearchNavigation.count) === 1, "focused search included an outside branch");
    const retainedSearch = workspace.treeSearchNavigation;
    act(() => workspace.handleLayerAction("exit-focus")); await tick(); assert(Number(workspace.treeSearchNavigation.count) === 2 && !retainedSearch.next(), "focus change retained stale search callback");
    checks.push("512-level virtual compact/detailed search reveal; clearing preserves real expansion; focus recomputes matches and rejects old navigation");

    let capture!: Promise<UiSnapshot | null>; const beforeCapture = workspace.treeSearchNavigation;
    act(() => { capture = workspace.inspectDevice("fixture"); }); assert(!beforeCapture.next(), "old search navigated during capture");
    act(() => preview({ requestId: captureRequestId, phase: "tree", snapshot: snapshot(root) })); await tick();
    act(() => workspace.handleLayerAction("hide", a)); await tick();
    const previewHidden = workspace.hiddenNodeIds, previewExpanded = workspace.treeExpandedIds;
    act(() => { workspace.handleLayerAction("restore-selected", a); workspace.handleLayerAction("collapse-children", parent); });
    assert(workspace.hiddenNodeIds === previewHidden && workspace.treeExpandedIds === previewExpanded, "new local actions changed busy capture preview");
    const busyMenu = await openMenu(a);
    assert(Boolean(menuOptions?.canRestoreSelected) === false && menuOptions.imageScopes?.every(scope => !scope.available), "busy preview enabled new menu actions");
    await finish(busyMenu.promise, "copy-image-own"); assert(imageActions.length === 1, "busy preview dispatched an image action");
    act(() => finishCapture(snapshot(root))); await capture; await tick();
    act(() => workspace.setTreeQuery("巡览目标")); await tick();
    const staleRefresh = workspace.treeSearchNavigation, refreshMenu = await openMenu(a);
    let refresh!: Promise<void>; act(() => { refresh = workspace.refreshViewNode(a); });
    const hiddenBefore = workspace.hiddenNodeIds;
    act(() => workspace.handleLayerAction("hide", a)); assert(workspace.hiddenNodeIds === hiddenBefore && !workspace.treeSearchNavigation.next(), "refresh busy allowed hide/navigation");
    await finish(refreshMenu.promise, "copy-image-own"); assert(imageActions.length === 1, "menu dispatched during refresh");
    act(() => finishRefresh({ nodes: [{ ...a, text: "已更新控件" }], failures: [] })); await refresh; await tick();
    assert(Number(workspace.treeSearchNavigation.count) === 1 && !staleRefresh.next(), "local refresh failed to recalculate matches or accepted old navigation");
    checks.push("capture/refresh gates block local mutation and late menus; refreshed original identity recalculates search matches");

    const wide = createTree(25_000, "wide"); wide.text = "当前窗口"; wide.className = "android.widget.FrameLayout"; wide.resourceId = null; wide.contentDesc = null;
    for (const node of wide.children) { node.text = "巡览目标"; node.resourceId = `app:id/${"long_resource_".repeat(4)}${node.index}`; }
    act(() => workspace.showSnapshot(snapshot(wide))); await tick();
    act(() => { viewport().scrollTop = 10_000 * 44 + 7; viewport().dispatchEvent(new Event("scroll", { bubbles: true })); }); await tick();
    const readingTop = viewport().scrollTop, savedExpansion = workspace.treeExpandedIds;
    act(() => workspace.setTreeQuery("巡览目标")); await tick(); click(".tree-search-previous"); await tick(); click(".tree-search-previous"); await tick();
    assert(workspace.selectedNode === wide.children.at(-1) && Number(workspace.treeSearchNavigation.count) === 24_999 && viewport().dataset.virtual === "true"
      && host.querySelectorAll(".tree-row").length < 80, "25k search count/wrap/virtualization failed");
    act(() => workspace.clearTreeFilter()); await tick();
    assert(Math.abs(viewport().scrollTop - readingTop) <= 1 && workspace.treeExpandedIds === savedExpansion, "clear search lost reading anchor or real expansion");
    act(() => workspace.handleLayerAction("hide", wide)); await tick(); act(() => workspace.setTreeQuery("巡览目标")); await tick();
    checks.push("25k repeated-name search counts only 24999 matches, wraps to final virtual row, clearing restores reading anchor and expansion");
    assert(!unexpected.length, "local UI requested extra device image/style work");
    const visual = async (theme: string, width: number) => {
      document.documentElement.dataset.appearance = theme; host.style.width = `${width}px`; await tick(); await tick(); key(viewport(), "Enter"); await tick();
      const pane = element<HTMLElement>(".tree-pane").getBoundingClientRect();
      const selectedBounds = element<HTMLElement>('.tree-row[aria-selected="true"]').getBoundingClientRect(), treeBounds = viewport().getBoundingClientRect();
      assert(selectedBounds.top >= treeBounds.top - 1 && selectedBounds.bottom <= treeBounds.bottom + 1,
        `keyboard selection clipped ${theme}/${width}: ${JSON.stringify({ selected: [selectedBounds.top, selectedBounds.bottom], viewport: [treeBounds.top, treeBounds.bottom], top: viewport().scrollTop, height: viewport().clientHeight, scrollHeight: viewport().scrollHeight })}`);
      for (const selector of [".tree-viewing-scope", ".tree-scope-hidden-parent", ".tree-search-matches", ".tree-toolbar", ".tree-tools"]) {
        const control = element<HTMLElement>(selector), rect = control.getBoundingClientRect();
        assert(rect.left >= pane.left - 1 && rect.right <= pane.right + 1 && control.scrollWidth <= control.clientWidth + 1, `overflow ${selector} ${theme}/${width}`);
      }
      assert(pane.bottom <= innerHeight + 1 && element<HTMLElement>(".tree-search-matches").getBoundingClientRect().bottom <= innerHeight + 1, "search controls left the zoomed viewport");
      return { theme, width, rowHeight: viewport().dataset.rowHeight, mountedRows: host.querySelectorAll(".tree-row").length, matchingCount: workspace.treeSearchNavigation.count };
    };
    for (const theme of ["dark", "light"]) for (const width of [306, 248]) await visual(theme, width);
    Object.assign(window, { setTreeRound3Visual: visual });
    const checkpoint = (window as typeof window & { treeRound3VisualCheckpoint?: () => Promise<void> }).treeRound3VisualCheckpoint;
    if (checkpoint) await checkpoint();
    checks.push("dark/light actual 306/248px panes: ancestor reason, match controls, toolbar and status remain reachable");
    return { passed: true, fixtureOnly: true, phoneOperations: 0, checks, unexpected };
  } finally {
    act(() => mounted.unmount()); host.remove(); window.electronApi = oldApi;
    if (stored === null) localStorage.removeItem(TREE_ROW_MODE_STORAGE_KEY); else localStorage.setItem(TREE_ROW_MODE_STORAGE_KEY, stored);
    if (oldTheme === null) document.documentElement.removeAttribute("data-appearance"); else document.documentElement.setAttribute("data-appearance", oldTheme);
  }
}
