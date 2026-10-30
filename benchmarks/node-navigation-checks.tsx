import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { NodePropertiesPanel } from "../src/components/NodePropertiesPanel";
import { UiTree } from "../src/components/UiTree";
import { useInspectionWorkspace } from "../src/features/inspection/useInspectionWorkspace";
import { filterTree, flattenNodes } from "../shared/tree-utils";
import type { InspectionPreview, LayerMenuAction, UiNode, UiSnapshot, ViewRefreshResult } from "../shared/types";
import { makeNode } from "./fixtures";

export async function verifyNodeNavigation() {
  const oldApi = window.electronApi;
  const savedStorage = Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!; return [key, localStorage.getItem(key)!] as const;
  });
  const host = document.createElement("div"); document.body.append(host);
  let renderer = createRoot(host);
  let workspace!: ReturnType<typeof useInspectionWorkspace>;
  let preview: ((value: InspectionPreview) => void) | null = null;
  let pendingCapture: { id: string; resolve: (value: UiSnapshot) => void } | null = null;
  let finishRefresh: ((value: ViewRefreshResult) => void) | null = null;
  let finishMenu: ((value: LayerMenuAction) => void) | null = null, deferMenu = false;
  let captures = 0, refreshes = 0, deferCapture = false;
  const unexpected: string[] = [], checks: string[] = [];
  const act = (action: () => void) => flushSync(action);
  const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Node navigation: ${message}`); }
  const until = async (condition: () => boolean, message: string) => {
    const deadline = performance.now() + 4000;
    while (!condition()) { assert(performance.now() < deadline, `timeout: ${message}`); await tick(); }
  };
  function chain(depth: number, prefix: string, long = false): UiNode[] {
    const nodes = Array.from({ length: depth }, (_, level) => ({ ...makeNode(`${prefix}-${level}`, level),
      text: long ? `第${level + 1}级很长的真实业务名称${"内容".repeat(100)}` : `路径容器 ${level + 1}`,
      resourceId: null, contentDesc: null, attributes: { "view-ref": `View@${prefix}-${level}` } }));
    nodes.forEach((node, level) => { if (nodes[level + 1]) node.children = [nodes[level + 1]]; });
    return nodes;
  }
  const short = chain(7, "opaque-id");
  short[0].attributes = { ...short[0].attributes, "debug-process-id": "fixture-pid", "debug-window-name": "fixture-window" };
  let fixture: UiSnapshot = { serial: "node-navigation-fixture", root: short[0], nodeCount: short.length, xmlSize: 0, rawXml: null,
    screenshotDataUrl: null, warning: null, error: null, inspectionSource: "debug-view", captureMode: "deep" };
  const source = (root: UiNode): UiSnapshot => ({ ...fixture, root, nodeCount: flattenNodes(root).size });
  window.electronApi = {
    runtime: { sandboxed: true, contextIsolated: true },
    probeAdb: async () => ({ adbPath: "fixture", adbVersion: "fixture", error: null,
      devices: [{ serial: fixture.serial, state: "device", model: "fixture", androidVersion: "15", product: null, transportId: null }] }),
    inspectDevice: (_serial, requestId) => {
      captures++;
      return deferCapture ? new Promise(resolve => { pendingCapture = { id: requestId, resolve }; }) : Promise.resolve(structuredClone(fixture));
    },
    onInspectionPreview: callback => { preview = callback; return () => { preview = null; }; },
    onInspectionProgress: () => () => {}, cancelInspection: async () => {},
    showLayerMenu: async () => deferMenu ? new Promise<LayerMenuAction>(resolve => { finishMenu = resolve; }) : null,
    captureGroup: async () => { unexpected.push("group"); throw new Error("Unexpected navigation group read"); },
    readViewStyle: async () => { unexpected.push("style"); throw new Error("Unexpected navigation style read"); },
    refreshViewNode: async () => { refreshes++; return new Promise(resolve => { finishRefresh = resolve; }); },
    copyText: async () => {}, loadSnapshots: async () => ({ snapshots: [], error: null }),
    exportSnapshot: async () => ({ canceled: true, filePath: null, error: null }),
    saveSnapshot: async () => ({ snapshots: [], error: null }), clearSnapshots: async () => ({ snapshots: [], error: null }),
  };
  const click = (selector: string) => {
    const control = host.querySelector<HTMLElement>(selector);
    assert(control && !(control instanceof HTMLButtonElement && control.disabled), `unavailable: ${selector}`);
    act(() => control.click());
  };
  const panel = () => host.querySelector<HTMLElement>(".floating-inspector")!;
  const path = () => panel().querySelector<HTMLElement>(".inspector-node-path")!;
  const selected = () => host.querySelector<HTMLElement>('.tree-row[aria-selected="true"]');
  const viewport = () => host.querySelector<HTMLElement>('[role="tree"]')!;
  function Harness() {
    workspace = useInspectionWorkspace();
    const fullRoot = workspace.snapshot?.root, treeRoot = workspace.layerFocus?.kind === "branch" ? workspace.layerFocus.node : fullRoot;
    if (!fullRoot || !treeRoot || !workspace.selectedNode) return null;
    const filter = { query: workspace.treeQuery, interactiveOnly: workspace.interactiveOnly, identifiedOnly: workspace.identifiedOnly };
    return <div className="inspector-workspace" style={{ height: 600, width: 1000 }}><div className="inspector-grid is-resizable" style={{ height: 480 }}>
      <div className="tree-pane" style={{ height: 480, width: 300 }}>
        <UiTree key={workspace.treeSession} root={treeRoot} filteredRoot={filterTree(treeRoot, filter)} selectedId={workspace.selectedNode.id}
          expanded={workspace.treeExpandedIds} filter={filter} filterActive={Boolean(filter.query || filter.interactiveOnly || filter.identifiedOnly)} filterKey={JSON.stringify(filter)}
          revealRequest={workspace.treeRevealRequest} restoreRequest={workspace.treeRestoreRequest}
          focusKey={workspace.layerFocus ? `${workspace.layerFocus.kind}:${workspace.layerFocus.node.id}` : null}
          onExpandedChange={workspace.handleExpandedChange} onSelect={workspace.setSelectedNode} onClearFilter={workspace.clearTreeFilter} />
      </div><div aria-hidden="true" /><div className="preview-pane" style={{ height: 480 }}>
        <NodePropertiesPanel root={fullRoot} node={workspace.selectedNode} imageSessionKey={workspace.treeSession} screenshotSize={null} toolbarHost={null}
          onCopy={() => {}} copyStatus={null} docked onNavigateNode={workspace.navigateToNode}
          navigationDisabled={workspace.inspectionLoading || Boolean(workspace.viewRefreshingNodeId)}>{null}</NodePropertiesPanel>
      </div></div></div>;
  }
  try {
    localStorage.clear();
    act(() => renderer.render(<App />));
    await until(() => Boolean(host.querySelector<HTMLButtonElement>(".capture-button") && !host.querySelector<HTMLButtonElement>(".capture-button")!.disabled), "App ready");
    click(".capture-button");
    await until(() => Boolean(host.querySelector('.tree-row[data-tree-id="opaque-id-6"]')), "App capture");
    click('.tree-row[data-tree-id="opaque-id-6"]');
    assert(path().querySelectorAll(".inspector-path-compact > li").length === 4 && path().querySelector("[aria-current]")?.textContent === short[6].text, "actual App did not display compact ancestry");
    click('.inspector-path-node[data-path-node-id="opaque-id-5"]');
    assert(selected()?.dataset.treeId === short[5].id && path().querySelector("[aria-current]") === document.activeElement, "actual App navigation did not select/reveal or preserve keyboard context");
    click('.inspector-path-node[data-path-node-id="opaque-id-0"]');
    assert(selected()?.dataset.treeId === short[0].id && !path().querySelector("button"), "root path did not stop at the root");
    assert(captures === 1 && refreshes === 0 && !unexpected.length, "App navigation requested device data");
    checks.push("actual App: arbitrary IDs, compact parent/root path, tree selection/reveal and accessible current-node focus; zero additional reads");

    act(() => renderer.unmount()); host.className = "app-shell inspection-active"; renderer = createRoot(host);
    act(() => renderer.render(<Harness />)); await tick();
    const deep = chain(200, "deep-opaque", true), deepSnapshot = source(deep[0]);
    const original = JSON.stringify(deepSnapshot);
    act(() => workspace.showSnapshot(deepSnapshot, deep[199].id));
    for (const width of [300, 248]) {
      panel().style.width = `${width}px`; await tick();
      assert(Math.abs(panel().getBoundingClientRect().width - width) <= 1, `fixture did not provide an actual ${width}px panel`);
      assert(path().scrollWidth <= path().clientWidth + 1 && path().querySelectorAll(".inspector-path-compact > li").length === 4,
        `compact path overflow at ${width}px: ${JSON.stringify({ width: path().clientWidth, scroll: path().scrollWidth,
          items: [...path().querySelectorAll(".inspector-path-compact > li")].map(item => ({ width: item.clientWidth, scroll: item.scrollWidth })) })}`);
      click(".inspector-path-overflow");
      const full = path().querySelector<HTMLElement>(".inspector-path-full")!;
      assert(full.children.length === 200 && full.clientHeight <= 162 && full.scrollHeight > full.clientHeight, "full path was not bounded and scrollable");
      const middle = full.querySelector<HTMLButtonElement>('[data-path-node-id="deep-opaque-99"]')!;
      assert(middle.title.includes(deep[99].text!) && middle.title.startsWith("100级"), "deep labels lost full names/depth");
      act(() => full.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      assert(!path().querySelector(".inspector-path-full") && document.activeElement === path().querySelector(".inspector-path-overflow"), "Escape did not close the full path and restore focus");
    }
    click(".inspector-path-overflow"); click('.inspector-path-full [data-path-node-id="deep-opaque-99"]');
    assert(workspace.selectedNode === deep[99] && !path().querySelector(".inspector-path-full"), "middle ancestor navigation failed or kept obsolete full path");
    assert(JSON.stringify(deepSnapshot) === original, "navigation changed captured data");
    checks.push("200-level path and complete names/depth; 300/248px clipping, bounded list, Escape/current focus and immutable data");

    const branch = chain(7, "focused"), unrelated = chain(3, "unrelated");
    const fullRoot: UiNode = { ...makeNode("global-root"), children: [unrelated[0], ...Array.from({ length: 750 }, (_, index) => makeNode(`wide-${index}`, index + 1)), branch[0]] };
    act(() => workspace.showSnapshot(source(fullRoot), branch[6].id));
    act(() => { workspace.setTreeExpandedIds(new Set([fullRoot.id])); workspace.setTreeQuery(branch[6].text!); workspace.setInteractiveOnly(true); workspace.setIdentifiedOnly(true); });
    assert(workspace.navigateToNode !== undefined, "workspace handler missing");
    act(() => { assert(workspace.navigateToNode(branch[4], fullRoot), "filtered ancestor refused"); });
    await tick();
    assert(!workspace.treeQuery && !workspace.interactiveOnly && !workspace.identifiedOnly && selected()?.dataset.treeId === branch[4].id, "explicit navigate did not clear filters and reveal the target");
    assert(host.querySelector('[data-virtual="true"]') && host.querySelectorAll(".tree-row").length < 80, "navigation left the virtual tree or mounted unbounded rows");
    assert(!workspace.treeExpandedIds.has(unrelated[0].id), "navigation expanded an unrelated branch");
    checks.push("explicit ancestor navigation clears filters, opens only required ancestry and reveals virtual rows");

    act(() => workspace.handleLayerAction("hide", branch[3]));
    act(() => workspace.handleLayerAction("focus-branch", branch[0]));
    act(() => { assert(workspace.navigateToNode(branch[1], fullRoot), "in-focus ancestor refused"); });
    assert(workspace.layerFocus?.node === branch[0], "in-branch navigation exited focus");
    act(() => { assert(workspace.navigateToNode(fullRoot, fullRoot), "outside-focus root refused"); });
    await tick();
    assert(!workspace.layerFocus && selected()?.dataset.treeId === fullRoot.id && viewport().scrollTop === 0 && workspace.hiddenNodeIds.has(branch[3].id), "exit-focus restore overrode explicit root reveal or revived a hidden layer");
    act(() => workspace.setSelectedNode(branch[6])); await tick();
    const previousScroll = viewport().scrollTop;
    assert(previousScroll > 1000, "focus scroll fixture did not reach its remote branch");
    act(() => workspace.handleLayerAction("focus-branch", branch[0]));
    act(() => workspace.handleLayerAction("exit-focus")); await tick();
    assert(Math.abs(viewport().scrollTop - previousScroll) <= 1, `ordinary exit-focus lost its saved scroll position: ${previousScroll} → ${viewport().scrollTop}`);
    act(() => workspace.handleLayerAction("focus", branch[2]));
    act(() => { assert(workspace.navigateToNode(branch[1], fullRoot), "single-layer parent refused"); });
    assert(!workspace.layerFocus && workspace.selectedNode === branch[1], "single-layer isolation survived navigation to another layer");
    checks.push("focus-aware navigation prioritizes explicit reveal, retains hidden layers and preserves ordinary exit-focus scrolling");

    deferMenu = true;
    let menu!: Promise<void>;
    act(() => { menu = workspace.openLayerMenu(branch[1]); });
    act(() => { assert(workspace.navigateToNode(fullRoot, fullRoot), "navigation during a pending menu refused"); });
    assert(finishMenu, "menu fixture was not connected");
    (finishMenu as (value: LayerMenuAction) => void)("focus-branch"); await menu; await tick(); deferMenu = false;
    assert(!workspace.layerFocus && workspace.selectedNode === fullRoot, "late menu reply replaced explicit navigation");

    const oldNavigate = workspace.navigateToNode;
    act(() => workspace.showSnapshot(source(fullRoot), branch[6].id));
    const expectedSelected = workspace.selectedNode, expectedExpanded = workspace.treeExpandedIds;
    act(() => { assert(!oldNavigate(fullRoot, fullRoot), "old callback crossed a same-object reopened snapshot");
      assert(!workspace.navigateToNode({ ...branch[1] }, fullRoot), "foreign same-ID object was accepted"); });
    assert(workspace.selectedNode === expectedSelected && workspace.treeExpandedIds === expectedExpanded, "rejected navigation changed presentation");
    const staleNavigate = workspace.navigateToNode;
    act(() => workspace.showSnapshot(source(structuredClone(fullRoot))));
    act(() => { assert(!staleNavigate(branch[1], fullRoot), "stale callback crossed a new root with identical IDs"); });
    checks.push("same-object reopen, same-ID replacement and foreign-node callbacks are rejected; late menus cannot replace explicit navigation");

    fixture = source(short[0]); deferCapture = true;
    let capturing!: Promise<UiSnapshot | null>;
    act(() => { capturing = workspace.inspectDevice(fixture.serial); });
    assert(pendingCapture && preview, "capture fixture was not connected");
    const waiting = pendingCapture as { id: string; resolve: (value: UiSnapshot) => void };
    act(() => (preview as (event: InspectionPreview) => void)({ requestId: waiting.id, phase: "tree", snapshot: fixture }));
    act(() => workspace.setSelectedNode(short[6]));
    act(() => { assert(!workspace.navigateToNode(short[2], short[0]), "navigation ran during capture"); });
    const busyButtons = [...path().querySelectorAll<HTMLButtonElement>(".inspector-path-node")];
    assert(busyButtons.length > 0 && busyButtons.every(button => button.disabled), "capture navigation controls remained enabled");
    waiting.resolve(structuredClone(fixture)); await capturing; await tick(); deferCapture = false;
    const refreshedRoot = workspace.snapshot!.root!;
    act(() => workspace.setSelectedNode(refreshedRoot.children[0].children[0]));
    const beforeRefresh = workspace.navigateToNode;
    let refreshing!: Promise<void>;
    act(() => { refreshing = workspace.refreshViewNode(refreshedRoot.children[0]); });
    assert(finishRefresh && workspace.viewRefreshingNodeId, "refresh fixture was not connected");
    act(() => { assert(!workspace.navigateToNode(refreshedRoot.children[0], refreshedRoot), "navigation ran during refresh"); });
    (finishRefresh as (value: ViewRefreshResult) => void)({ nodes: [refreshedRoot.children[0]], failures: [] }); await refreshing; await tick();
    act(() => { assert(!beforeRefresh(refreshedRoot.children[0], refreshedRoot), "old path survived a refreshed tree"); });
    assert(Number(captures) === 2 && Number(refreshes) === 1 && !unexpected.length, "navigation itself added capture/refresh/group/style calls");
    checks.push("capture/refresh navigation is disabled; refreshed roots invalidate old targets, with zero automatic device reads");
    return checks;
  } finally {
    act(() => renderer.unmount()); host.remove(); window.electronApi = oldApi;
    localStorage.clear(); savedStorage.forEach(([key, value]) => localStorage.setItem(key, value));
  }
}
