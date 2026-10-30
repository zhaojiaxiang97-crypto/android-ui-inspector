import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useInspectionWorkspace } from "../src/features/inspection/useInspectionWorkspace";
import { UiTree } from "../src/components/UiTree";
import { filterTree, flattenNodes } from "../shared/tree-utils";
import { DEFAULT_TREE_COLLAPSE, TREE_COLLAPSE_STORAGE_KEY } from "../shared/tree-collapse";
import { layerCopyActions, layerMenuCopyValues } from "../shared/layer-context-menu";
import type { InspectionPreview, LayerMenuAction, LayerMenuOptions, UiNode, UiSnapshot, ViewRefreshResult } from "../shared/types";
import { createTree, makeNode } from "./fixtures";

export async function verifyInspectionFocus() {
  const oldApi = window.electronApi, oldPreference = localStorage.getItem("android-ui-inspector.double-click");
  const oldCollapse = localStorage.getItem(TREE_COLLAPSE_STORAGE_KEY);
  const host = document.createElement("div"); host.style.width = "306px"; document.body.append(host);
  const reactRoot = createRoot(host);
  let workspace!: ReturnType<typeof useInspectionWorkspace>;
  const checks: string[] = [], menus: Array<{ options?: LayerMenuOptions; canHide: boolean; resolve: (action: LayerMenuAction) => void }> = [];
  const copies: Array<{ label: string; value: string }> = [];
  const onCopyValue = (label: string, value: string) => { copies.push({ label, value }); };
  const source = (root: UiNode): UiSnapshot => ({ serial: "focus-fixture", root, nodeCount: flattenNodes(root).size, xmlSize: 0, rawXml: null, screenshotDataUrl: null, warning: null, error: null });
  let capture = source(createTree(21)), refresh: ViewRefreshResult = { nodes: [], failures: [] };
  let deferCapture = false, preview: ((event: InspectionPreview) => void) | null = null;
  let pendingCapture!: { requestId: string; resolve: (snapshot: UiSnapshot) => void; reject: (error: Error) => void };
  window.electronApi = { ...oldApi, inspectDevice: (_serial, requestId) => deferCapture
    ? new Promise((resolve, reject) => { pendingCapture = { requestId, resolve, reject }; }) : Promise.resolve(capture), cancelInspection: async () => {},
    onInspectionPreview: callback => { preview = callback; return () => { preview = null; }; }, onInspectionProgress: () => () => {}, refreshViewNode: async () => refresh,
    showLayerMenu: (canHide, _restore, _exit, options) => new Promise(resolve => menus.push({ canHide, options, resolve })) };
  function Harness() {
    workspace = useInspectionWorkspace();
    const root = workspace.layerFocus?.kind === "branch" ? workspace.layerFocus.node : workspace.snapshot?.root;
    if (!root) return null;
    const filter = { query: workspace.treeQuery, interactiveOnly: workspace.interactiveOnly, identifiedOnly: workspace.identifiedOnly };
    return <UiTree key={workspace.treeSession} root={root} filteredRoot={filterTree(root, filter)} selectedId={workspace.selectedNode?.id ?? null}
      expanded={workspace.treeExpandedIds} filter={filter} filterActive={Boolean(filter.query || filter.interactiveOnly || filter.identifiedOnly)} filterKey={JSON.stringify(filter)}
      revealRequest={workspace.treeRevealRequest}
      restoreRequest={workspace.treeRestoreRequest} focusKey={workspace.layerFocus ? `${workspace.layerFocus.kind}:${workspace.layerFocus.node.attributes?.["view-ref"] ?? workspace.layerFocus.node.id}` : null}
      doubleClickAction={workspace.doubleClickAction} onDoubleClick={workspace.handleNodeDoubleClick} onContextMenu={node => void workspace.openLayerMenu(node, onCopyValue)}
      onExpandedChange={workspace.handleExpandedChange} onSelect={workspace.setSelectedNode} onClearFilter={workspace.clearTreeFilter} />;
  }
  const act = (action: () => void) => flushSync(action);
  const settle = async () => { await Promise.resolve(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
  function assert(value: unknown, message: string) { if (!value) throw new Error(`Focus workspace: ${message}`); }
  const expanded = () => JSON.stringify([...workspace.treeExpandedIds].sort());
  const ids = () => [...host.querySelectorAll<HTMLElement>(".tree-row")].map(row => row.dataset.treeId);
  try {
    localStorage.removeItem("android-ui-inspector.double-click"); localStorage.removeItem(TREE_COLLAPSE_STORAGE_KEY); act(() => reactRoot.render(<Harness />));
    const original = capture.root!, branch = original.children[0], child = branch.children[0];
    act(() => workspace.showSnapshot(capture, branch.id));
    act(() => workspace.handleNodeDoubleClick(branch));
    assert(!workspace.treeExpandedIds.has(branch.id) && ids().length === 17, "default toggle did not collapse once");
    act(() => workspace.handleNodeDoubleClick(branch));
    assert(workspace.treeExpandedIds.has(branch.id), "toggle did not reopen the parent");
    act(() => workspace.setDoubleClickAction("expand"));
    const open = expanded(); act(() => workspace.handleNodeDoubleClick(branch)); act(() => workspace.handleNodeDoubleClick(child));
    assert(expanded() === open, "compatibility expansion collapsed a parent or expanded a leaf");
    checks.push("default toggle, one-level reopen, compatibility expansion and leaf no-op");

    act(() => { workspace.setTreeExpandedIds(new Set([original.id])); workspace.setTreeQuery("Node 6"); });
    const folded = expanded(); act(() => workspace.setDoubleClickAction("focus-branch"));
    act(() => workspace.handleNodeDoubleClick(branch));
    assert(workspace.layerFocus?.node === branch && workspace.treeQuery === "Node 6" && JSON.stringify(ids()) === '["0/0","0/0/1"]', "focus lost search or complete branch identity");
    act(() => workspace.clearTreeFilter());
    assert(JSON.stringify(ids()) === '["0/0","0/0/0","0/0/1","0/0/2","0/0/3"]', "focus did not contain the whole branch");
    act(() => workspace.setSelectedNode(child)); act(() => workspace.handleLayerAction("exit-focus"));
    assert(!workspace.layerFocus && expanded() === folded && workspace.selectedNode === branch && JSON.stringify(ids()) === '["0","0/0","0/1","0/2","0/3"]', "exit reopened ancestors or lost saved state");
    checks.push("search remains independent; original folded tree and selection restored");

    act(() => workspace.handleLayerAction("hide", child)); act(() => workspace.handleLayerAction("focus-branch", branch));
    const currentFocus = workspace.layerFocus; act(() => workspace.handleLayerAction("focus-branch", branch));
    assert(workspace.layerFocus === currentFocus, "repeat focus rebuilt presentation");
    act(() => workspace.handleLayerAction("focus-branch", child));
    assert(workspace.hiddenNodeIds.has(child.id) && JSON.stringify(ids()) === '["0/0/0"]', "hidden leaf focus resurrected pixels or another tree");
    act(() => workspace.handleLayerAction("exit-focus"));
    assert(expanded() === folded && workspace.selectedNode === branch && workspace.hiddenNodeIds.has(child.id), "nested focus overwrote the overview or hidden state");
    act(() => workspace.handleLayerAction("focus", branch));
    assert(ids().includes(original.id) && workspace.layerFocus?.kind === "layer", "single-layer isolation became tree branch focus");
    act(() => workspace.handleLayerAction("exit-focus")); checks.push("repeat/nested focus, hidden target and distinct single-layer action");

    act(() => { void workspace.openLayerMenu(child); });
    assert(!menus[0].canHide && menus[0].options?.canFocus, "hidden node menu enablement is wrong");
    menus[0].resolve("focus-branch"); await settle();
    assert(workspace.layerFocus?.node.id === child.id, "context action did not use the shared focus");
    act(() => workspace.handleLayerAction("exit-focus")); act(() => { void workspace.openLayerMenu(branch); });
    act(() => workspace.handleLayerAction("focus-branch", child)); menus[1].resolve("focus-branch"); await settle();
    assert(workspace.layerFocus?.node.id === child.id, "late menu overwrote a newer focus");
    act(() => { void workspace.openLayerMenu(branch); });
    const replacement = source(createTree(5)); act(() => workspace.showSnapshot(replacement)); menus[2].resolve("focus-branch"); await settle();
    assert(!workspace.layerFocus && !workspace.hiddenNodeIds.size && workspace.snapshot === replacement, "late popup changed the replacement snapshot");
    act(() => workspace.showSnapshot({ ...replacement, captureMode: "fast" }));
    act(() => workspace.handleLayerAction("focus-branch", replacement.root));
    assert(!workspace.layerFocus && workspace.layerMenuError?.includes("深度采集"), "semantic snapshot pretended to isolate independent layers");
    for (const failure of ["resolved", "rejected"] as const) {
      deferCapture = true;
      let capturing!: Promise<UiSnapshot | null>;
      act(() => { capturing = workspace.inspectDevice("focus-fixture"); });
      const failedPreview = source(createTree(21));
      act(() => preview?.({ requestId: pendingCapture.requestId, phase: "tree", snapshot: failedPreview }));
      act(() => { workspace.handleLayerAction("hide", failedPreview.root); workspace.handleLayerAction("focus-branch", failedPreview.root); });
      assert(workspace.layerFocus && workspace.hiddenNodeIds.size, "failure setup did not focus the early preview");
      if (failure === "resolved") pendingCapture.resolve({ ...failedPreview, root: null, error: "fixture capture failed" });
      else pendingCapture.reject(new Error("fixture transport failed"));
      await capturing; await settle();
      assert(!workspace.snapshot?.root && !workspace.layerFocus && !workspace.hiddenNodeIds.size, `${failure} capture left stale focus/hidden state`);
      deferCapture = false;
    }
    checks.push("hidden-node menus, stale replies across focus/history, failed previews and honest fast-mode rejection");

    const live = createTree(21); live.attributes = { "debug-process-id": "fixture-pid", "debug-window-name": "fixture-window" };
    const liveBranch = live.children[0], liveChild = liveBranch.children[0];
    liveBranch.attributes = { "view-ref": "View@parent" }; liveChild.attributes = { "view-ref": "View@child" };
    capture = { ...source(live), inspectionSource: "debug-view" }; await workspace.inspectDevice(capture.serial); await settle();
    act(() => { workspace.setSelectedNode(liveChild); workspace.setTreeExpandedIds(new Set([live.id, liveBranch.id])); });
    act(() => workspace.handleLayerAction("hide", liveChild)); act(() => workspace.handleLayerAction("focus-branch", liveChild));
    const moved = { ...liveChild, id: `${liveBranch.id}/1`, text: "same view, new ID" };
    refresh = { nodes: [], failures: [], branch: { ...liveBranch, children: [makeNode(`${liveBranch.id}/0`), moved] } };
    await workspace.refreshViewNode(liveBranch, "branch"); await settle();
    assert(workspace.layerFocus?.node.id === moved.id && workspace.layerFocus?.node.text === moved.text && workspace.hiddenNodeIds.has(moved.id), "refresh did not remap focus/hidden identity");
    act(() => workspace.handleLayerAction("exit-focus"));
    assert(workspace.selectedNode?.id === moved.id && expanded() === '["0","0/0"]', "exit restored stale positional IDs");
    act(() => workspace.handleLayerAction("focus-branch", moved)); refresh = { nodes: [], failures: [], branch: { ...liveBranch, children: [] } };
    await workspace.refreshViewNode(workspace.snapshot!.root!.children[0], "branch"); await settle();
    assert(!workspace.layerFocus && !workspace.hiddenNodeIds.size && workspace.snapshot?.root?.children[0].children.length === 0, "removed focus retained an old tree");
    checks.push("refresh follows View identity, saved state remaps, removed target exits safely");

    const large = source(createTree(25_000)); act(() => workspace.showSnapshot(large));
    const viewport = host.querySelector<HTMLElement>(".ui-tree-scroll")!;
    act(() => { viewport.scrollTop = 28 * 900; viewport.dispatchEvent(new Event("scroll", { bubbles: true })); }); await settle();
    const savedTop = viewport.scrollTop, largeBefore = expanded(); act(() => workspace.handleLayerAction("focus-branch", large.root!.children[0]));
    assert(host.querySelector('[data-virtual="true"]') && host.querySelectorAll(".tree-row").length < 80, "25k focused tree mounts unbounded rows");
    act(() => workspace.handleLayerAction("exit-focus")); await settle();
    assert(expanded() === largeBefore && workspace.selectedNode === large.root && viewport.scrollTop === savedTop, "large focus did not restore selection/expansion/scroll");
    act(() => workspace.setDoubleClickAction("focus-branch")); act(() => reactRoot.render(<Harness key="preference-remount" />));
    assert(workspace.doubleClickAction === "focus-branch", "preference did not survive a new workspace");
    checks.push("25k focus stays virtual; preference persists across remount");

    const decorated = createTree(85);
    for (const node of flattenNodes(decorated).values()) { node.className = "android.widget.FrameLayout"; node.attributes = { "view-ref": `View@${node.id}` }; }
    decorated.attributes = { ...decorated.attributes, "debug-process-id": "fixture-pid", "debug-window-name": "fixture-window" };
    const svg = decorated.children[0], svgChild = svg.children[0], svgLeaf = svgChild.children[0], ordinary = decorated.children[1];
    svg.className = "com.horcrux.svg.SvgView"; ordinary.className = "com.facebook.react.views.view.ReactViewGroup"; svgLeaf.text = "folded-only-target";
    const collapseRules = { version: 1 as const, depth: 3, classes: ["SvgView"] };
    act(() => workspace.setTreeCollapsePreference(collapseRules)); act(() => workspace.showSnapshot(source(decorated)));
    assert(workspace.treeExpandedIds.has(ordinary.id) && !workspace.treeExpandedIds.has(svg.id) && !workspace.treeExpandedIds.has(svgChild.id), "initial rules folded all React groups or used wrong depth");
    const initial = expanded(); act(() => workspace.setTreeQuery("folded-only-target"));
    assert(JSON.stringify(ids()) === JSON.stringify([decorated.id, svg.id, svgChild.id, svgLeaf.id]) && expanded() === initial, "search lost folded descendants or mutated scene expansion");
    act(() => workspace.setSelectedNode(svgLeaf));
    assert(!workspace.canApplyTreeCollapse && expanded() === initial, "filtered selection changed initial folding");
    act(() => host.querySelector<HTMLButtonElement>(".tree-locate")!.click());
    assert(!workspace.treeQuery && ids().includes(svgLeaf.id) && workspace.treeExpandedIds.has(svg.id), "explicit locate failed to reopen the original selected path");
    act(() => workspace.applyTreeCollapsePreference({ version: 1, depth: 1, classes: [] }));
    assert(ids().includes(svgLeaf.id) && !workspace.treeExpandedIds.has(ordinary.id), "apply hid the selected path or kept unrelated branches open");
    const beforeSave = expanded(); act(() => workspace.setTreeCollapsePreference(collapseRules));
    assert(expanded() === beforeSave, "saving future rules changed the current tree");
    act(() => workspace.showSnapshot(source(decorated)));
    assert(expanded() === initial, "offline/history new session ignored rules");
    act(() => workspace.handleLayerAction("focus-branch", svg)); act(() => workspace.handleLayerAction("exit-focus"));
    assert(expanded() === initial && !workspace.layerFocus, "focus exit lost initial folding");
    checks.push("exact class/depth initial rules; offline sessions, temporary search, locate, selected path and focus restoration");

    deferCapture = true; let progressive!: Promise<UiSnapshot | null>;
    act(() => { progressive = workspace.inspectDevice("focus-fixture"); });
    act(() => preview?.({ requestId: pendingCapture.requestId, phase: "tree", snapshot: source(decorated) }));
    act(() => workspace.handleLayerAction("expand", svg)); act(() => workspace.handleLayerAction("expand", svgChild));
    act(() => workspace.handleLayerAction("collapse", ordinary)); act(() => workspace.setSelectedNode(svgChild));
    act(() => workspace.setTreeCollapsePreference({ version: 1, depth: 1, classes: [] }));
    const merged = structuredClone(decorated), newcomer = makeNode("new");
    newcomer.className = "android.widget.FrameLayout"; newcomer.attributes = { "view-ref": "View@new" }; newcomer.children = [makeNode("new-child")];
    const movedSvg = merged.children[0]; merged.children = [newcomer, merged.children[1], movedSvg, ...merged.children.slice(2)];
    const reindex = (node: UiNode, id: string) => { node.id = id; node.children.forEach((child, index) => { child.index = index; reindex(child, `${id}/${index}`); }); };
    reindex(merged, "0");
    act(() => preview?.({ requestId: pendingCapture.requestId, phase: "tree", snapshot: source(merged) }));
    assert(workspace.selectedNode?.id === "0/2/0" && workspace.treeExpandedIds.has("0/2") && workspace.treeExpandedIds.has("0/2/0") && !workspace.treeExpandedIds.has("0/1") && workspace.treeExpandedIds.has("0/0"), "later preview lost View identity, manual choices or frozen session rules");
    pendingCapture.resolve({ ...source(merged), inspectionSource: "debug-view" }); await progressive; await settle(); deferCapture = false;
    assert(workspace.treeExpandedIds.has("0/2/0") && !workspace.treeExpandedIds.has("0/1") && workspace.treeExpandedIds.has("0/0"), "final capture reset manual choices");
    const refreshParent = workspace.snapshot!.root!.children[1], newSvg = makeNode(`${refreshParent.id}/4`);
    newSvg.className = svg.className; newSvg.attributes = { "view-ref": "View@refresh-new-svg" }; newSvg.children = [makeNode(`${newSvg.id}/0`)];
    refresh = { nodes: [], failures: [], branch: { ...refreshParent, children: [...refreshParent.children, newSvg] } };
    await workspace.refreshViewNode(refreshParent, "branch"); await settle();
    assert(!workspace.treeExpandedIds.has(refreshParent.id) && !workspace.treeExpandedIds.has(newSvg.id) && workspace.treeExpandedIds.has("0/2/0"), "branch refresh reopened a closed parent or reset an unrelated manual open");
    checks.push("progressive previews/final keep manual choices and moved View identity; session rules frozen; refresh preserves closed/new branches");

    act(() => reactRoot.render(<Harness key="collapse-remount" />));
    assert(workspace.treeCollapsePreference.depth === 1, "collapse preference did not survive remount");
    act(() => workspace.showSnapshot(source(decorated))); assert(ids().length === 1, "persisted depth rule did not apply to a new session");
    localStorage.setItem(TREE_COLLAPSE_STORAGE_KEY, '{"version":99}'); act(() => reactRoot.render(<Harness key="corrupt-collapse" />));
    assert(JSON.stringify(workspace.treeCollapsePreference) === JSON.stringify(DEFAULT_TREE_COLLAPSE), "corrupt preferences prevented safe default expansion");
    checks.push("collapse preferences persist across workspace remount; invalid saved values fall back to full expansion");

    const copyRoot = createTree(21), copyBranch = copyRoot.children[0], copyChild = copyBranch.children[0], laterSelection = copyRoot.children[1];
    copyRoot.attributes = { "debug-name": "完整窗口名称", "debug-process-id": "fixture-pid", "debug-window-name": "fixture-window" };
    copyChild.text = `  完整文本\n${"长文本".repeat(400)}\n  `;
    copyChild.resourceId = "com.fixture:id/complete_identifier"; copyChild.className = "com.fixture.Full$NestedClass";
    act(() => workspace.showSnapshot(source(copyRoot)));
    act(() => workspace.handleLayerAction("focus-branch", copyBranch)); act(() => workspace.setTreeQuery("完整文本"));
    const copyRow = host.querySelector<HTMLElement>(`[data-tree-id="${copyChild.id}"]`)!;
    assert(copyRow, "filtered branch lost the right-click target");
    act(() => copyRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    const firstCopyMenu = menus.at(-1)!;
    assert(JSON.stringify(firstCopyMenu.options?.copyActions) === JSON.stringify(layerCopyActions), "available copy actions do not match the actual node");
    assert(!JSON.stringify(firstCopyMenu.options).includes("完整文本"), "native menu IPC received renderer copy values");
    act(() => workspace.setSelectedNode(laterSelection)); firstCopyMenu.resolve("copy-text"); await settle();
    assert(copies.length === 1 && copies[0].label === "文本" && copies[0].value === copyChild.text, "copy used the later selection or shortened the right-click text");
    for (const action of layerCopyActions.slice(1)) {
      act(() => { void workspace.openLayerMenu(copyChild, onCopyValue); }); menus.at(-1)!.resolve(action); await settle();
      assert(copies.at(-1)?.value === layerMenuCopyValues(copyRoot, copyChild)[action], `${action} changed the complete value`);
    }
    assert(copies.at(-1)?.value.startsWith("完整窗口名称"), "focused/filtered path omitted the full-tree ancestors");
    const completeCopies = copies.length;
    act(() => { void workspace.openLayerMenu(copyChild, onCopyValue); }); menus.at(-1)!.resolve(null); await settle();
    assert(copies.length === completeCopies, "cancelled menu copied a value");
    act(() => { void workspace.openLayerMenu(copyChild, onCopyValue); }); const lateCopy = menus.at(-1)!;
    act(() => { void workspace.openLayerMenu(laterSelection, onCopyValue); }); menus.at(-1)!.resolve(null); lateCopy.resolve("copy-text"); await settle();
    assert(copies.length === completeCopies, "older menu copied after a newer popup");
    deferCapture = true; let imageCapture!: Promise<UiSnapshot | null>;
    act(() => { imageCapture = workspace.inspectDevice("focus-fixture"); });
    act(() => preview?.({ requestId: pendingCapture.requestId, phase: "tree", snapshot: source(copyRoot) }));
    act(() => { void workspace.openLayerMenu(copyBranch, onCopyValue); }); const oldRootMenu = menus.at(-1)!;
    act(() => preview?.({ requestId: pendingCapture.requestId, phase: "layers", updates: [{ id: copyBranch.id, layerImageStatus: "captured" }] }));
    oldRootMenu.resolve("copy-text"); await settle();
    assert(copies.length === completeCopies, "image root replacement accepted an old copy menu");
    assert(workspace.selectedNode === flattenNodes(workspace.snapshot!.root!).get(copyBranch.id), "image update detached the current canvas menu selection from the actual tree node");
    const menuCount = menus.length;
    act(() => { void workspace.openLayerMenu(copyBranch, onCopyValue); });
    assert(menus.length === menuCount, "stale same-ID node opened a new menu");
    pendingCapture.resolve(source(workspace.snapshot!.root!)); await imageCapture; await settle(); deferCapture = false;
    act(() => { void workspace.openLayerMenu(copyChild, onCopyValue); }); const historyMenu = menus.at(-1)!;
    act(() => workspace.showSnapshot(source(createTree(5)))); historyMenu.resolve("copy-text"); await settle();
    assert(copies.length === completeCopies, "snapshot replacement accepted a stale copy");
    const missing = makeNode("0"); missing.text = ""; missing.resourceId = null; missing.className = null;
    act(() => workspace.showSnapshot(source(missing)));
    act(() => { void workspace.openLayerMenu(missing, onCopyValue); }); const missingMenu = menus.at(-1)!;
    assert(JSON.stringify(missingMenu.options?.copyActions) === '["copy-hierarchy-path"]', "missing fields remained in copy choices");
    missingMenu.resolve("copy-text"); await settle();
    assert(copies.length === completeCopies, "unavailable copy action reached the callback");
    act(() => { void workspace.openLayerMenu(missing, onCopyValue); }); menus.at(-1)!.resolve("copy-json" as LayerMenuAction); await settle();
    assert(copies.length === completeCopies && workspace.layerMenuError, "malformed menu action was accepted");
    checks.push("complete right-click values, fixed target after selection, focused/filtered full-tree path, missing fields and malformed replies");
    checks.push("cancelled/newer popups, image-root replacement and snapshot switches discard stale copy actions");

    capture = { ...source(copyRoot), inspectionSource: "debug-view" }; await workspace.inspectDevice(capture.serial); await settle();
    act(() => { void workspace.openLayerMenu(copyChild, onCopyValue); }); const refreshMenu = menus.at(-1)!;
    let releaseRefresh!: (value: ViewRefreshResult) => void;
    const originalRefresh = window.electronApi.refreshViewNode;
    window.electronApi.refreshViewNode = () => new Promise(resolve => { releaseRefresh = resolve; });
    try {
      let updating!: Promise<void>;
      act(() => { updating = workspace.refreshViewNode(copyChild); }); refreshMenu.resolve("copy-text"); await settle();
      assert(copies.length === completeCopies, "refresh-in-progress copied a stale node");
      const beforeRefreshMenu = menus.length; act(() => { void workspace.openLayerMenu(copyChild, onCopyValue); });
      assert(menus.length === beforeRefreshMenu, "refresh-in-progress opened another stale menu");
      releaseRefresh({ nodes: [{ ...copyChild, text: "刷新后的值" }], failures: [] }); await updating; await settle();
      const refreshedChild = flattenNodes(workspace.snapshot!.root!).get(copyChild.id)!;
      act(() => { void workspace.openLayerMenu(refreshedChild, onCopyValue); }); menus.at(-1)!.resolve("copy-text"); await settle();
      assert(copies.at(-1)?.value === "刷新后的值", "new menu did not copy the refreshed actual node");
    } finally { window.electronApi.refreshViewNode = originalRefresh; }
    const beforeClear = copies.length;
    act(() => { void workspace.openLayerMenu(workspace.snapshot!.root, onCopyValue); }); const clearedMenu = menus.at(-1)!;
    act(() => workspace.clearInspection()); clearedMenu.resolve("copy-hierarchy-path"); await settle();
    assert(copies.length === beforeClear, "cleared workspace accepted a stale copy");
    checks.push("refresh start blocks old/new copies; refreshed values work; cleared workspace rejects late actions");
    return { checks, fixtureOnly: true };
  } finally {
    act(() => reactRoot.unmount()); host.remove(); window.electronApi = oldApi;
    if (oldPreference === null) localStorage.removeItem("android-ui-inspector.double-click"); else localStorage.setItem("android-ui-inspector.double-click", oldPreference);
    if (oldCollapse === null) localStorage.removeItem(TREE_COLLAPSE_STORAGE_KEY); else localStorage.setItem(TREE_COLLAPSE_STORAGE_KEY, oldCollapse);
  }
}
