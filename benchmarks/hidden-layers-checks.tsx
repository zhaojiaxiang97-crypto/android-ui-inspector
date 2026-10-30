import { useMemo, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { UiTree } from "../src/components/UiTree";
import { useInspectionWorkspace } from "../src/features/inspection/useInspectionWorkspace";
import { NodeHoverProvider } from "../src/features/inspection/NodeHoverContext";
import type { ViewingScope } from "../src/features/inspection/viewing-scope";
import { manuallyHiddenLayers } from "../shared/tree-hidden-state";
import { indexTree } from "../shared/visible-tree";
import { filterTree, flattenNodes } from "../shared/tree-utils";
import type { UiNode, UiSnapshot, ViewRefreshResult } from "../shared/types";
import { createTree, makeNode } from "./fixtures";

export async function verifyHiddenLayers() {
  const oldApi = window.electronApi, oldTheme = document.documentElement.getAttribute("data-appearance");
  const host = document.createElement("div"); host.className = "app-shell inspection-active";
  Object.assign(host.style, { width: "306px", height: "calc(100vh - 32px)", minHeight: "0", margin: "16px", position: "relative" });
  document.body.append(host); const mounted = createRoot(host);
  let workspace!: ReturnType<typeof useInspectionWorkspace>, scope!: ViewingScope;
  let finishCapture!: (value: UiSnapshot) => void, finishRefresh!: (value: ViewRefreshResult) => void;
  const unexpected: string[] = [], checks: string[] = [];
  const act = (action: () => void) => flushSync(action);
  const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  function assert(value: unknown, message: string) { if (!value) throw new Error(`Hidden layers: ${message}`); }
  const snapshot = (root: UiNode): UiSnapshot => ({ serial: "hidden-layers-fixture", root, nodeCount: flattenNodes(root).size, rawXml: null,
    screenshotDataUrl: null, xmlSize: 0, warning: null, error: null, inspectionSource: "debug-view", captureMode: "deep" });
  window.electronApi = {
    probeAdb: async () => ({ adbPath: null, adbVersion: null, error: null, devices: [] }),
    runtime: { sandboxed: true, contextIsolated: true, fixtureMode: true }, showLayerMenu: async () => null, copyText: async () => {},
    exportSnapshot: async () => ({ canceled: true, filePath: null, error: null }), loadSnapshots: async () => ({ snapshots: [], error: null }),
    saveSnapshot: async () => ({ snapshots: [], error: null }), clearSnapshots: async () => ({ snapshots: [], error: null }),
    onInspectionProgress: () => () => {}, onInspectionPreview: () => () => {},
    inspectDevice: () => new Promise(resolve => { finishCapture = resolve; }), cancelInspection: async () => {},
    refreshViewNode: () => new Promise(resolve => { finishRefresh = resolve; }),
    captureGroup: async () => { unexpected.push("capture-group"); throw new Error("Unexpected device call"); },
    readViewStyle: async () => { unexpected.push("read-style"); throw new Error("Unexpected device call"); },
  } as typeof window.electronApi;
  function Harness() {
    workspace = useInspectionWorkspace();
    const full = workspace.snapshot?.root;
    const index = useMemo(() => full ? indexTree(full) : new Map(), [full]);
    const hidden = useMemo(() => manuallyHiddenLayers(index, workspace.hiddenNodeIds), [index, workspace.hiddenNodeIds]);
    const source = useMemo(() => ({ full, session: workspace.treeSession }), [full, workspace.treeSession]);
    const latest = useRef({ source, index, workspace }); latest.current = { source, index, workspace };
    function valid(node: UiNode) {
      const current = latest.current;
      return current.source === source && current.index.get(node.id)?.node === node && !current.workspace.viewingScope.disabledReason
        && current.workspace.hiddenNodeIds.has(node.id);
    }
    scope = { ...workspace.viewingScope, hiddenLayers: hidden, hiddenListScope: source,
      locateHiddenLayer: node => valid(node) && Boolean(full) && latest.current.workspace.navigateToNode(node, full!),
      restoreHiddenLayer: node => {
        if (!valid(node)) return false;
        latest.current.workspace.handleLayerAction("restore-selected", node); return true;
      },
    };
    const root = workspace.layerFocus?.kind === "branch" ? workspace.layerFocus.node : full;
    if (!full || !root) return null;
    const filter = { query: workspace.treeQuery, interactiveOnly: workspace.interactiveOnly, identifiedOnly: workspace.identifiedOnly };
    const filtered = Boolean(filter.query.trim() || filter.interactiveOnly || filter.identifiedOnly);
    return <NodeHoverProvider root={root} sessionKey={workspace.treeSession}><div className="tree-pane" style={{ height: "100%", width: "100%" }}>
      <UiTree key={workspace.treeSession} root={root} filteredRoot={filterTree(root, filter)} filter={filter} filterActive={filtered} filterKey={JSON.stringify(filter)}
        selectedId={workspace.selectedNode?.id ?? null} expanded={workspace.treeExpandedIds} hiddenNodeIds={workspace.hiddenNodeIds} viewingScope={scope}
        revealRequest={workspace.treeRevealRequest} restoreRequest={workspace.treeRestoreRequest} focusKey={workspace.layerFocus ? `${workspace.layerFocus.kind}:${workspace.layerFocus.node.id}` : null}
        inspectionSource="debug-view" captureMode="deep" expansionDisabled={workspace.inspectionLoading || Boolean(workspace.viewRefreshingNodeId)}
        onExpandedChange={workspace.handleExpandedChange} onSelect={workspace.setSelectedNode} onClearFilter={workspace.clearTreeFilter}
        onContextMenu={workspace.openLayerMenu} history={workspace.nodeHistory} historyView={workspace.nodeHistoryView} />
    </div></NodeHoverProvider>;
  }
  const element = <T extends HTMLElement>(selector: string) => { const value = document.querySelector<T>(selector); assert(value, `missing ${selector}`); return value!; };
  const click = (selector: string) => act(() => element<HTMLElement>(selector).click());
  const key = (target: HTMLElement, value: string, extra: KeyboardEventInit = {}) => act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...extra })));
  const row = (node: UiNode) => { const value = Array.from(document.querySelectorAll<HTMLElement>(".hidden-layer-item")).find(item => item.dataset.nodeId === node.id); assert(value, `missing row ${node.id}`); return value!; };
  const action = (node: UiNode, name: "locate" | "restore") => act(() => row(node).querySelector<HTMLButtonElement>(`.hidden-layer-${name}`)!.click());
  const show = async (root: UiNode, nodes: UiNode[]) => {
    act(() => workspace.showSnapshot(snapshot(root))); await tick();
    act(() => nodes.forEach(node => workspace.handleLayerAction("hide", node))); await tick();
  };
  try {
    act(() => mounted.render(<Harness />)); await tick();
    const root = { ...makeNode("window"), text: "当前窗口", resourceId: null, className: "android.view.Window",
      attributes: { "debug-process-id": "hidden-layers-fixture", "debug-window-name": "Fixture" } };
    const parent = { ...makeNode("opaque-parent"), text: "隐藏父层", resourceId: null }, child = { ...makeNode("opaque-child"), text: "同名控件", resourceId: "app:id/长路径_详细标识" };
    const sibling = { ...makeNode("opaque-sibling"), text: "同名控件", resourceId: "app:id/另一个同名控件" };
    const invisible = { ...makeNode("device-invisible"), text: "设备不可见", visibleToUser: false, layerImageStatus: "unavailable" as const };
    root.children = [parent, sibling, invisible]; parent.children = [child];
    const before = JSON.stringify(root);
    await show(root, [parent, child, sibling]);
    const selection = workspace.selectedNode;
    click(".hidden-layers-toggle"); await tick();
    assert(workspace.selectedNode === selection && scope.hiddenLayers?.length === 3, "opening changed selection or omitted records");
    assert(row(child).querySelector(".hidden-layer-ancestor")?.textContent?.includes(parent.text!), "closest hidden parent was missing");
    assert(!document.querySelector('[data-node-id="device-invisible"]'), "device-invisible node invented a manual record");
    const path = row(child).querySelector<HTMLDetailsElement>(".hidden-layer-path")!; act(() => { path.open = true; });
    assert(path.textContent?.includes("当前窗口") && path.textContent?.includes("隐藏父层") && !path.textContent?.includes("opaque-parent"), "ID was misrepresented as a full hierarchy path");
    action(child, "restore"); await tick();
    assert(workspace.hiddenNodeIds.has(parent.id) && workspace.hiddenNodeIds.has(sibling.id) && !workspace.hiddenNodeIds.has(child.id)
      && document.querySelector(".hidden-layers-popup") && workspace.selectedNode === selection, "restore affected another node, selection or popup");
    assert(row(sibling).querySelector(".hidden-layer-restore") === document.activeElement, "restore lost keyboard focus");
    act(() => workspace.handleLayerAction("hide", child)); await tick();
    action(parent, "restore"); await tick();
    assert(workspace.hiddenNodeIds.has(child.id) && workspace.hiddenNodeIds.has(sibling.id) && !row(child).querySelector(".hidden-layer-ancestor"), "removed parent reason remained");
    assert(JSON.stringify(root) === before, "view operation changed captured node values");
    checks.push("manual parent/child/same-name list, full hierarchy vs opaque IDs, device visibility exclusion, isolated restore, live reasons, unchanged selection and captured data");

    act(() => { workspace.handleLayerAction("focus-branch", sibling); workspace.setTreeQuery("不存在的筛选"); }); await tick();
    action(child, "locate"); await tick();
    assert(workspace.selectedNode === child && !workspace.layerFocus && !workspace.treeQuery && workspace.hiddenNodeIds.has(child.id)
      && !document.querySelector(".hidden-layers-popup"), "locate did not clear restricting view or restored a node");
    click(".hidden-layers-toggle"); await tick(); click(".hidden-layers-restore-all"); await tick();
    assert(!workspace.hiddenNodeIds.size && element(".hidden-layers-empty").textContent?.includes("没有手动隐藏"), "explicit restore all did not keep completion feedback");
    key(element(".hidden-layers-close"), "Escape"); await tick();
    assert(!document.querySelector(".hidden-layers-popup") && document.activeElement === element('[role="tree"]'), "empty close did not return to tree");
    checks.push("explicit locate exits focus/clears filters without restoring; restore-all stays explicit and shows empty completion");

    for (const count of [0, 1, 30, 31, 1000]) {
      const wide = createTree(count + 1, "wide"); wide.text = "分页窗口";
      wide.children.forEach((node, index) => { node.text = "同名控件"; node.resourceId = `app:id/完整_${index}_${"长资源ID".repeat(12)}`; });
      await show(wide, wide.children);
      if (!count) { assert(!document.querySelector(".hidden-layers-toggle"), "zero records showed a fake nonempty entry"); continue; }
      click(".hidden-layers-toggle"); await tick();
      assert(document.querySelectorAll(".hidden-layer-item").length === Math.min(count, 30) && scope.hiddenLayers?.length === count, `first page limit/count ${count}`);
      const selections = workspace.selectedNode;
      const allIds: string[] = [];
      for (let page = 0; page < Math.ceil(count / 30); page++) {
        const shown = Array.from(document.querySelectorAll<HTMLElement>(".hidden-layer-item")); allIds.push(...shown.map(item => item.dataset.nodeId!));
        assert(shown.length <= 30 && element(".hidden-layers-pagination").textContent?.includes(`共 ${count} 项`), `page count ${count}/${page}`);
        if (page < Math.ceil(count / 30) - 1) click(".hidden-layers-next");
        await tick();
      }
      assert(new Set(allIds).size === count && workspace.selectedNode === selections, `all results not reachable or paging selected ${count}`);
      assert(element<HTMLButtonElement>(".hidden-layers-next").disabled, "last page offered an empty next page");
      if (count === 31) {
        action(wide.children[30], "restore"); await tick();
        assert(element(".hidden-layers-pagination").textContent?.includes("第 1–30 项，共 30 项") && document.querySelectorAll(".hidden-layer-item").length === 30, "restoring final page did not clamp to a valid page");
      }
      click(".hidden-layers-close"); await tick();
    }
    checks.push("0/1/30/31/1000 records; 30-per-page bound; every same-name ID reachable; paging preserves selection and clamps after final-page restore");

    await show(root, [parent, child, sibling]); click(".hidden-layers-toggle"); await tick();
    key(element(".hidden-layers-close"), "Escape", { isComposing: true }); assert(document.querySelector(".hidden-layers-popup"), "IME Esc closed list");
    act(() => element(".hidden-layers-close").dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    key(element(".hidden-layers-close"), "Escape"); assert(document.querySelector(".hidden-layers-popup"), "composition tracking missed Esc");
    act(() => element(".hidden-layers-close").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    key(element(".hidden-layers-close"), "Escape", { keyCode: 229 }); assert(document.querySelector(".hidden-layers-popup"), "IME keyCode closed list");
    key(element(".hidden-layers-close"), "Escape"); await tick();
    assert(!document.querySelector(".hidden-layers-popup") && document.activeElement === element(".hidden-layers-toggle"), "Esc did not close/return to opener");
    click(".hidden-layers-toggle"); await tick();
    const outside = document.createElement("button"); outside.textContent = "外部正常按钮"; host.append(outside);
    let outsideClicks = 0; outside.onclick = () => { outsideClicks++; };
    act(() => { outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); outside.focus(); outside.click(); }); await tick();
    assert(!document.querySelector(".hidden-layers-popup") && outsideClicks === 1 && document.activeElement === outside, "outside close stole focus or click");
    click(".hidden-layers-toggle"); await tick(); act(() => outside.focus()); await tick();
    assert(!document.querySelector(".hidden-layers-popup") && document.activeElement === outside,
      `keyboard focus leaving list was not respected: popup=${Boolean(document.querySelector(".hidden-layers-popup"))}, active=${document.activeElement?.outerHTML.slice(0, 200)}`);
    click(".hidden-layers-toggle"); await tick(); act(() => window.dispatchEvent(new Event("blur"))); await tick();
    assert(!document.querySelector(".hidden-layers-popup"), "window blur retained list"); outside.remove();
    checks.push("IME-safe Esc with opener focus; pointer outside preserves ordinary click/focus; keyboard leaving and window blur close");

    click(".hidden-layers-toggle"); await tick();
    const oldScope = scope, oldRestore = row(child).querySelector<HTMLButtonElement>(".hidden-layer-restore")!;
    const replacement = { ...root, children: [{ ...parent, children: [{ ...child, text: "新的同 ID 控件" }] }, { ...sibling }, { ...invisible }] };
    await show(replacement, [replacement.children[0].children[0]]);
    assert(!document.querySelector(".hidden-layers-popup") && !oldScope.restoreHiddenLayer?.(child) && !oldScope.locateHiddenLayer?.(child), "source change accepted old callback or kept list");
    act(() => oldRestore.click()); assert(workspace.hiddenNodeIds.has(child.id), "detached button entered same-ID new snapshot");
    click(".hidden-layers-toggle"); await tick();
    const busyScope = scope;
    let capture!: Promise<UiSnapshot | null>; act(() => { capture = workspace.inspectDevice("fixture"); }); await tick();
    assert(!document.querySelector(".hidden-layers-popup") && !busyScope.restoreHiddenLayer?.(replacement.children[0].children[0]), "capture kept list or accepted retained action");
    act(() => finishCapture(snapshot(root))); await capture; await tick();
    act(() => [parent, child, sibling].forEach(node => workspace.handleLayerAction("hide", node))); await tick();
    click(".hidden-layers-toggle"); await tick();
    const refreshScope = scope;
    let refresh!: Promise<void>; act(() => { refresh = workspace.refreshViewNode(root, "branch"); }); await tick();
    assert(!document.querySelector(".hidden-layers-popup") && !refreshScope.restoreHiddenLayer?.(child), "refresh busy retained popup/action");
    act(() => finishRefresh({ nodes: [], failures: [], branch: { ...root, children: [{ ...parent, children: [] }, sibling, invisible] } })); await refresh; await tick(); await tick();
    assert(!scope.hiddenLayers?.some(item => item.node === child) && !workspace.hiddenNodeIds.has(child.id), "local refresh retained removed manual record");
    checks.push("same-ID new snapshot closes/rejects retained callbacks and detached buttons; capture/refresh busy gates; refreshed removed-node records pruned");

    const deep = Array.from({ length: 512 }, (_, i) => ({ ...makeNode(`opaque-deep-${i}`, i), text: `长路径层级 ${i} · Unicode 🌲`, resourceId: null, className: null }));
    deep.forEach((node, i) => { if (deep[i + 1]) node.children = [deep[i + 1]]; });
    await show(deep[0], [deep[0], deep[510], deep[511]]); click(".hidden-layers-toggle"); await tick();
    const deepPath = row(deep[511]).querySelector<HTMLDetailsElement>(".hidden-layer-path")!;
    act(() => { deepPath.open = true; }); await tick();
    assert(deepPath.querySelector("p")?.textContent?.split(" > ").length === 512 && deepPath.scrollWidth <= deepPath.clientWidth + 1, "512-level path was truncated or overflowed");
    click(".hidden-layers-close"); await tick();
    const wide = createTree(25_000, "wide"); wide.text = "当前窗口";
    const wideChildren = wide.children.slice(0, 65); wideChildren.forEach((node, index) => { node.text = `同名控件 · ${index}`; node.resourceId = `app:id/${"非常长的资源标识_".repeat(8)}${index}`; });
    await show(wide, [wide, ...wideChildren]); click(".hidden-layers-toggle"); await tick();
    assert(document.querySelectorAll(".hidden-layer-item").length === 30 && host.querySelectorAll(".tree-row").length < 80
      && element<HTMLElement>('[role="tree"]').dataset.virtual === "true", "25k tree or hidden list rendered unbounded rows");
    checks.push("512-level complete Unicode path stays in pane; 25k tree remains virtual and hidden list mounts only 30");
    const visual = async (theme: string, width: number) => {
      document.documentElement.dataset.appearance = theme; host.style.width = `${width}px`;
      if (document.querySelector(".hidden-layers-popup")) click(".hidden-layers-close");
      await tick(); click(".hidden-layers-toggle"); await tick(); await tick();
      const first = document.querySelector<HTMLDetailsElement>(".hidden-layer-path")!; act(() => { first.open = true; }); await tick();
      const popup = element<HTMLElement>(".hidden-layers-popup"), pane = element<HTMLElement>(".tree-pane"), bounds = popup.getBoundingClientRect(), paneBounds = pane.getBoundingClientRect();
      assert(bounds.left >= -1 && bounds.right <= innerWidth + 1 && bounds.top >= -1 && bounds.bottom <= innerHeight + 1, `popup leaves viewport ${theme}/${width}`);
      assert(Math.abs(bounds.width - paneBounds.width) <= 1 && popup.scrollWidth <= popup.clientWidth + 1, `width/overflow ${theme}/${width}`);
      for (const selector of [".hidden-layers-pagination", ".hidden-layers-restore-all", ".hidden-layer-detail", ".hidden-layer-path", ".tree-viewing-scope"]) {
        const control = element<HTMLElement>(selector); assert(control.scrollWidth <= control.clientWidth + 1, `control overflow ${selector}/${theme}/${width}`);
      }
      return { theme, paneWidth: paneBounds.width, viewport: [innerWidth, innerHeight], pixelRatio: devicePixelRatio, mountedHiddenRows: document.querySelectorAll(".hidden-layer-item").length,
        mountedTreeRows: host.querySelectorAll(".tree-row").length, total: scope.hiddenLayers?.length };
    };
    Object.assign(window, {
      setHiddenLayersVisual: visual,
      hiddenLayersNativePrepare: () => { if (document.querySelector(".hidden-layers-popup")) click(".hidden-layers-close"); act(() => element(".hidden-layers-toggle").focus()); },
      hiddenLayersNativeCheck: (open: boolean) => { assert(Boolean(document.querySelector(".hidden-layers-popup")) === open, `native keyboard open=${open}`); if (!open) assert(document.activeElement === element(".hidden-layers-toggle"), "native Esc lost opener focus"); },
    });
    for (const theme of ["dark", "light"]) for (const width of [306, 248]) await visual(theme, width);
    const checkpoint = (window as typeof window & { hiddenLayersVisualCheckpoint?: () => Promise<void> }).hiddenLayersVisualCheckpoint;
    if (checkpoint) await checkpoint();
    assert(!unexpected.length, "local list requested device work");
    checks.push("actual dark/light 306/248px popup bounds, long identifiers, page controls and explicit full restore reachable; zero device image/style requests");
    return { passed: true, fixtureOnly: true, guardSource: "stand-in derived from existing workspace; App integration remains owned by parent", phoneOperations: 0, checks, unexpected };
  } finally {
    act(() => mounted.unmount()); host.remove(); window.electronApi = oldApi;
    if (oldTheme === null) document.documentElement.removeAttribute("data-appearance"); else document.documentElement.setAttribute("data-appearance", oldTheme);
  }
}
