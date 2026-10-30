import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useInspectionWorkspace } from "../src/features/inspection/useInspectionWorkspace";
import { UiTree } from "../src/components/UiTree";
import { NodeHoverProvider } from "../src/features/inspection/NodeHoverContext";
import { flattenNodes } from "../shared/tree-utils";
import { nodeRefreshScopeOptions } from "../shared/node-refresh-options";
import { TREE_COLLAPSE_STORAGE_KEY } from "../shared/tree-collapse";
import type { InspectionPreview, InspectionSource, LayerMenuAction, LayerMenuMode, LayerMenuOptions, QmlGroupImage, UiNode, UiSnapshot, ViewRefreshResult } from "../shared/types";
import { makeNode } from "./fixtures";

export async function verifyNodeRefreshMenuChecks(keepVisual = false) {
  const oldApi = window.electronApi, storedCollapse = localStorage.getItem(TREE_COLLAPSE_STORAGE_KEY);
  localStorage.removeItem(TREE_COLLAPSE_STORAGE_KEY);
  const host = document.createElement("section"); host.className = "app-shell inspection-active node-refresh-menu-fixture";
  Object.assign(host.style, { position: "fixed", top: "24px", right: "16px", width: "248px", height: "calc(100vh - 48px)",
    display: "flex", flexDirection: "column", minHeight: "0", background: "var(--ref-panel)", color: "var(--ref-text-soft)",
    border: "1px solid var(--ref-line)", font: "11px/1.45 var(--ref-font-ui)" });
  document.body.append(host); const mounted = createRoot(host);
  const act = (action: () => void) => flushSync(action), tick = async () => { await Promise.resolve(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
  function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Node refresh menu: ${message}`); }
  const checks: string[] = [], unexpected: string[] = [], copies: { label: string; value: string }[] = [];
  const menus: { options?: LayerMenuOptions; resolve: (action: LayerMenuAction) => void }[] = [];
  const refreshes: { requestId: string; nodeId: string; scope: "node" | "branch" | "list"; resolve: (result: ViewRefreshResult) => void; reject: (error: Error) => void }[] = [];
  let workspace!: ReturnType<typeof useInspectionWorkspace>, blocked = false, captures = 0, deferCapture = false;
  let preview!: (event: InspectionPreview) => void, pendingCapture!: { requestId: string; resolve: (value: UiSnapshot) => void };
  const bitmap = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const image: QmlGroupImage = { dataUrl: bitmap, size: { width: 1, height: 1 }, capturedAt: "2026-10-13T00:00:00.000Z" };
  const node = (id: string, text: string, ref = id): UiNode => ({ ...makeNode(id), text, className: "android.widget.FrameLayout", resourceId: null, contentDesc: null,
    layerImageDataUrl: bitmap, layerImageSize: { width: 1, height: 1 }, layerImageStatus: "captured" as const, attributes: { "view-ref": `View@${ref}` } });
  function makeSource(source: InspectionSource = "debug-view") {
    const root = node("0", "当前窗口"), branch = node("0/0", "可刷新分支"), leaf = node("0/0/0", "叶子旧画面"), side = node("0/1", "旁侧控件"), noRef = node("0/2", "没有 View 引用");
    noRef.attributes = {};
    branch.children = [leaf]; root.children = [branch, side, noRef];
    root.attributes = { ...root.attributes, "debug-process-id": "self-owned-fixture", "debug-window-name": "fixture-window" };
    const snapshot: UiSnapshot = { serial: "node-refresh-fixture", root, nodeCount: flattenNodes(root).size, rawXml: null, screenshotDataUrl: null, xmlSize: 0,
      warning: null, error: null, inspectionSource: source, captureMode: "deep", layerGroupImages: [{ nodeId: root.id, image }, { nodeId: branch.id, image }] };
    return { root, branch, leaf, side, noRef, snapshot };
  }
  let source = makeSource();
  const forbid = (name: string) => async () => { unexpected.push(name); throw new Error(`Unexpected ${name} in refresh fixture`); };
  window.electronApi = { ...oldApi, runtime: { sandboxed: true, contextIsolated: true },
    onInspectionProgress: () => () => {}, onInspectionPreview: callback => { preview = callback; return () => {}; }, cancelInspection: async () => {},
    inspectDevice: (_serial, requestId) => {
      captures++;
      return deferCapture ? new Promise(resolve => { pendingCapture = { requestId: requestId!, resolve }; }) : Promise.resolve(source.snapshot);
    },
    refreshViewNode: (requestId, nodeId, scope = "node") => new Promise((resolve, reject) => { refreshes.push({ requestId, nodeId, scope, resolve, reject }); }),
    showLayerMenu: (_hide, _restore, _focus, options) => new Promise(resolve => { menus.push({ options, resolve }); }),
    captureGroup: forbid("capture-group"), readViewStyle: forbid("read-style"), copyText: forbid("copy-text-ipc"),
  } as typeof window.electronApi;
  function Harness() {
    workspace = useInspectionWorkspace({ refreshBlocked: () => blocked });
    const root = workspace.snapshot?.root;
    return <>
      <header style={{ padding: "8px", borderBottom: "1px solid var(--ref-line)" }}><strong>刷新菜单 · 自有请求替身</strong><p style={{ margin: "4px 0 0", color: "var(--ref-muted)" }}>此层／此分支各单次请求；旧回复隔离</p></header>
      <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--ref-line-soft)" }} data-refresh-fixture-status="true">
        <div>已核验 {checks.length} 组 · 刷新替身请求 {refreshes.length}</div><div>额外图片／样式／复制 IPC：{unexpected.length}</div>
        <div role="status">{workspace.viewRefreshStatus?.message ?? "当前为自有 Debug View 样例"}</div>
      </div>
      {root && <NodeHoverProvider root={root} sessionKey={workspace.treeSession}><div className="tree-pane" style={{ flex: "1 1 auto", minHeight: 0, width: "100%" }}>
        <UiTree root={root} filteredRoot={root} filterActive={false} filterKey="refresh-menu-fixture" selectedId={workspace.selectedNode?.id ?? null}
          expanded={workspace.treeExpandedIds} hiddenNodeIds={workspace.hiddenNodeIds} inspectionSource={workspace.snapshot?.inspectionSource} captureMode="deep"
          revealRequest={workspace.treeRevealRequest} restoreRequest={workspace.treeRestoreRequest} onExpandedChange={workspace.handleExpandedChange}
          onSelect={workspace.setSelectedNode} onClearFilter={workspace.clearTreeFilter} onContextMenu={value => void workspace.openLayerMenu(value)} />
      </div></NodeHoverProvider>}
    </>;
  }
  const render = () => act(() => mounted.render(<Harness />));
  const capture = async (next = makeSource()) => {
    source = next; let promise!: Promise<UiSnapshot | null>; act(() => { promise = workspace.inspectDevice(next.snapshot.serial); }); await promise; await tick();
    assert(workspace.snapshot === next.snapshot, "fixture capture did not reach real workspace"); return next;
  };
  const menu = async (target: UiNode | null, mode: LayerMenuMode = "layers3d") => {
    const before = menus.length; let promise!: Promise<void>;
    act(() => { promise = workspace.openLayerMenu(target, (label, value) => { copies.push({ label, value }); }, mode); }); await tick();
    assert(menus.length === before + 1, "expected current menu IPC missing"); return { promise, record: menus[before] };
  };
  const reply = async (pending: Awaited<ReturnType<typeof menu>>, action: LayerMenuAction) => { act(() => pending.record.resolve(action)); await pending.promise; await tick(); };
  const scopes = (target: UiNode | null) => workspace.refreshScopesForNode(target);
  const assertOptions = (target: UiNode | null, options: LayerMenuOptions | undefined) => assert(JSON.stringify(options?.refreshScopes) === JSON.stringify(scopes(target)), "menu capability differs from shared hook capability");
  const request = async (pending: Awaited<ReturnType<typeof menu>>, action: "refresh-node" | "refresh-branch") => {
    const before = refreshes.length; act(() => pending.record.resolve(action)); await tick();
    assert(refreshes.length === before + 1, `${action} did not send exactly one refresh request`); return refreshes[before];
  };
  const done = async (pending: Awaited<ReturnType<typeof menu>>, refresh: (typeof refreshes)[number], result: ViewRefreshResult) => {
    act(() => refresh.resolve(result)); await pending.promise; await tick();
    assert(!workspace.viewRefreshingNodeId, "refresh busy state did not clear");
  };
  const cleanup = () => { act(() => mounted.unmount()); host.remove(); };
  let retained = false;
  try {
    render(); await tick();
    act(() => workspace.showSnapshot(source.snapshot)); await tick();
    const offline = await menu(source.branch); assertOptions(source.branch, offline.record.options);
    assert(scopes(source.branch).every(option => !option.available && option.detail.includes("离线")), "offline allowed refresh");
    await reply(offline, "refresh-node"); assert(!refreshes.length, "offline menu requested device refresh");
    const beforeFlat = menus.length, beforeSelection = workspace.selectedNode;
    await workspace.openLayerMenu(null, undefined, "flat"); await tick();
    assert(menus.length === beforeFlat && workspace.selectedNode === beforeSelection, "flat null fell back to old selection/menu IPC");
    const foreign = structuredClone(source.branch);
    await workspace.openLayerMenu(foreign); await workspace.refreshViewNode(foreign); await tick();
    assert(menus.length === beforeFlat && !refreshes.length && scopes(foreign).every(option => !option.available), "foreign same-ID object used current tree");
    checks.push("offline capability disables both refreshes; flat null and foreign same-ID objects never enter menu IPC or refresh");

    deferCapture = true; let capturing!: Promise<UiSnapshot | null>;
    act(() => { capturing = workspace.inspectDevice(source.snapshot.serial); });
    act(() => preview({ requestId: pendingCapture.requestId, phase: "tree", snapshot: source.snapshot })); await tick();
    const capturingMenu = await menu(source.branch); assertOptions(source.branch, capturingMenu.record.options);
    assert(scopes(source.branch).every(option => !option.available && option.detail.includes("采集中")), "capture preview allowed refresh");
    await reply(capturingMenu, "refresh-branch"); await workspace.refreshViewNode(source.branch); assert(!refreshes.length, "capture preview sent refresh");
    act(() => pendingCapture.resolve(source.snapshot)); await capturing; await tick(); deferCapture = false;
    assert(workspace.viewLiveRequestId === pendingCapture.requestId && scopes(source.branch).every(option => option.available), "live capture did not enable parent node/branch");
    assert(scopes(source.leaf)[0].available && !scopes(source.leaf)[1].available && scopes(source.leaf)[1].detail.includes("没有子层"), "leaf offered branch refresh");
    assert(scopes(source.noRef).every(option => !option.available && option.detail.includes("View 引用")), "missing View ref offered refresh");
    const beforeLiveForeign = menus.length;
    const liveForeign = structuredClone(source.branch);
    await workspace.openLayerMenu(liveForeign); await workspace.refreshViewNode(liveForeign); await tick();
    assert(menus.length === beforeLiveForeign && !refreshes.length && scopes(liveForeign).every(option => !option.available && option.detail.includes("控件已变化")),
      "foreign same-ID object bypassed identity guard in a live workspace");
    const noRefMenu = await menu(source.noRef); assertOptions(source.noRef, noRefMenu.record.options); await reply(noRefMenu, "refresh-node"); assert(!refreshes.length, "no-ref menu requested refresh");
    const canceled = await menu(source.branch); assertOptions(source.branch, canceled.record.options); await reply(canceled, null);
    assert(!refreshes.length && !unexpected.length, "opening/canceling menu read device");
    blocked = true;
    assert(scopes(source.branch).every(option => !option.available && option.detail.includes("自动调试")), "dynamic debug block was ignored");
    const blockedMenu = await menu(source.branch); assertOptions(source.branch, blockedMenu.record.options); await reply(blockedMenu, "refresh-node");
    await workspace.refreshViewNode(source.branch); assert(!refreshes.length, "debug blocked direct or menu refresh sent a request"); blocked = false;
    checks.push("real live inspectDevice/preview: busy capture, View refs, leaf branch limits, cancel/open zero refreshes and latest debug block agree with capability helper");

    const currentBranch = source.branch, first = await menu(currentBranch, "flat"), firstRequest = await request(first, "refresh-node");
    assert(firstRequest.requestId === workspace.viewLiveRequestId && firstRequest.nodeId === currentBranch.id && firstRequest.scope === "node", "node menu target/request/scope changed");
    assert(scopes(currentBranch).every(option => !option.available && option.detail.includes("刷新中")), "busy refresh capability enabled");
    const beforeBusyMenu = menus.length;
    await workspace.openLayerMenu(currentBranch); await workspace.refreshViewNode(currentBranch); act(() => first.record.resolve("refresh-node")); await tick();
    assert(menus.length === beforeBusyMenu && refreshes.length === 1, "repeated click/direct refresh bypassed busy gate");
    await done(first, firstRequest, { nodes: [{ ...currentBranch, text: "此层已刷新", children: [] }], failures: [] });
    let liveRoot = workspace.snapshot!.root!, liveBranch = liveRoot.children[0];
    assert(liveRoot !== source.root && liveBranch.text === "此层已刷新" && liveBranch.children[0] === source.leaf && liveRoot.children[1] === source.side,
      "node refresh changed child tree or unrelated sibling");
    assert(workspace.selectedNode === liveBranch && !workspace.availableGroupImages.length && !workspace.snapshot?.layerGroupImages,
      "node refresh lost selected identity or retained branch/parent group cache");
    checks.push("flat refresh-node sends exactly one real hook request, busy/repeated replies cannot duplicate it; node replacement keeps children/sibling/selection and invalidates group caches");

    const partial = await menu(liveBranch), partialRequest = await request(partial, "refresh-node"), beforePartial = liveBranch;
    await done(partial, partialRequest, { nodes: [{ ...liveBranch, text: "补图失败不能显示这张新图", layerImageDataUrl: "invalid-new-image" }], failures: [{ id: liveBranch.id, message: "fixture node image failed" }] });
    liveRoot = workspace.snapshot!.root!; liveBranch = liveRoot.children[0];
    assert(liveBranch.text === beforePartial.text && liveBranch.layerImageDataUrl === beforePartial.layerImageDataUrl
      && liveBranch.attributes?.["image-refresh-error"] === "fixture node image failed", "partial node image failure overwrote old drawing");
    const failure = await menu(liveBranch), failureRequest = await request(failure, "refresh-node"), beforeFailure = workspace.snapshot;
    act(() => failureRequest.reject(new Error("fixture transport failed"))); await failure.promise; await tick();
    assert(workspace.snapshot === beforeFailure && !workspace.viewRefreshingNodeId && workspace.viewRefreshStatus?.message === "fixture transport failed", "refresh transport failure lost old snapshot/status");
    checks.push("partial image failure preserves old node text/pixels with failure reason; rejected refresh keeps old snapshot and clears busy with error feedback");

    source = await capture(); liveBranch = source.branch;
    act(() => workspace.handleLayerAction("hide", source.leaf)); await tick();
    const branchMenu = await menu(liveBranch), branchRequest = await request(branchMenu, "refresh-branch");
    act(() => workspace.setSelectedNode(source.leaf)); await tick();
    const movedLeaf = { ...source.leaf, id: "0/0/1", index: 1, text: "同一 View 已移位" }, newcomer = node("0/0/0", "新子层", "newcomer");
    const replacementBranch = { ...liveBranch, text: "分支已刷新", children: [newcomer, movedLeaf] };
    assert(branchRequest.nodeId === liveBranch.id && branchRequest.scope === "branch", "branch menu scope/target changed");
    await done(branchMenu, branchRequest, { nodes: [], failures: [{ id: movedLeaf.id, message: "fixture branch image failed" }], branch: replacementBranch });
    liveRoot = workspace.snapshot!.root!; liveBranch = liveRoot.children[0];
    assert(liveBranch === replacementBranch && liveRoot.children[1] === source.side && workspace.selectedNode === movedLeaf
      && workspace.hiddenNodeIds.has(movedLeaf.id) && !workspace.hiddenNodeIds.has(source.leaf.id), "branch refresh lost View identity/selection/hidden remap or changed sibling");
    assert(workspace.snapshot?.nodeCount === flattenNodes(liveRoot).size && !workspace.availableGroupImages.length && workspace.viewRefreshStatus?.message.includes("1 层补图失败"),
      "branch refresh retained group cache or lost count/partial feedback");
    checks.push("refresh-branch sends one branch request; replacement remaps selected/hidden moved View identity, keeps sibling, clears cached parent/branch images and reports partial failures");

    const selectedChange = await menu(liveBranch), beforeStale = refreshes.length;
    act(() => workspace.setSelectedNode(liveRoot.children[1])); await tick(); await reply(selectedChange, "refresh-node");
    assert(refreshes.length === beforeStale, "old menu refreshed after selection change");
    const dynamicallyBlocked = await menu(liveBranch); blocked = true; await reply(dynamicallyBlocked, "refresh-branch");
    assert(refreshes.length === beforeStale, "old enabled menu ignored later debug block"); blocked = false;
    const superseded = await menu(liveBranch), newer = await menu(liveRoot.children[1]); await reply(superseded, "refresh-node"); await reply(newer, null);
    const oldRootMenu = await menu(liveBranch), oldRefresh = workspace.refreshViewNode;
    const sameIdRoot = structuredClone(liveRoot);
    act(() => workspace.showSnapshot({ ...workspace.snapshot!, root: sameIdRoot })); await tick();
    await reply(oldRootMenu, "refresh-branch"); await oldRefresh(liveBranch); await workspace.refreshViewNode(liveBranch); await tick();
    assert(refreshes.length === beforeStale && workspace.snapshot?.root === sameIdRoot, "old menu/callback/current foreign node entered same-ID replacement root");
    source = await capture();
    const beforeFlatHide = menus.length, flat = await menu(source.branch, "flat"), beforeHidden = workspace.hiddenNodeIds;
    await reply(flat, "hide"); assert(workspace.hiddenNodeIds === beforeHidden && !workspace.layerFocus && refreshes.length === beforeStale, "flat injected hide changed local layer state");
    const beforeFlatNull = menus.length; await workspace.openLayerMenu(null, undefined, "flat"); await tick();
    assert(menus.length === beforeFlatNull && menus.length === beforeFlatHide + 1, "flat null reused old node after earlier menu");
    const copy = await menu(source.leaf, "flat"); await reply(copy, "copy-text");
    assert(copies.length === 1 && copies[0].value === source.leaf.text && !unexpected.length && refreshes.length === beforeStale, "copy invoked refresh/helper/device IPC");
    checks.push("late selection/debug block/superseded menu/same-ID root replies and retained direct callback reject refresh; flat injected hide/null keep state; copy uses original text without helper IPC");

    const unsupported = await capture(makeSource("uiautomator"));
    const unsupportedMenu = await menu(unsupported.branch); assertOptions(unsupported.branch, unsupportedMenu.record.options);
    assert(scopes(unsupported.branch).every(option => !option.available) && !workspace.viewLiveRequestId, "unsupported source created a live View refresh request");
    await reply(unsupportedMenu, "refresh-branch"); assert(refreshes.length === beforeStale, "unsupported source refreshed a branch");
    const helperUnsupported = nodeRefreshScopeOptions(unsupported.branch, { current: true, hasLiveRequest: true, source: "uiautomator" });
    assert(helperUnsupported[0].available && !helperUnsupported[1].available && helperUnsupported[1].detail.includes("采集来源"), "shared capability lost explicit unsupported branch source rule");
    assert(!unexpected.length, "refresh menus performed extra image/style/copy IPC");
    source = await capture();
    let direct!: Promise<void>; const beforeDirect = refreshes.length;
    act(() => { direct = workspace.refreshViewNode(source.noRef); }); await tick();
    assert(refreshes.length === beforeDirect + 1 && !scopes(source.noRef)[0].available,
      "existing direct refresh API acquired a new View-ref restriction or menu became enabled");
    act(() => refreshes[beforeDirect].resolve({ nodes: [{ ...source.noRef, text: "旧 direct API 可调用" }], failures: [] })); await direct; await tick();
    assert(workspace.snapshot?.root?.children[2].text === "旧 direct API 可调用", "direct API regression fixture did not replace current node");

    for (const reuseSnapshot of [false, true]) {
      const retainedRoot: UiNode = workspace.snapshot!.root!, retainedNode = retainedRoot.children[0];
      const retainedMenu = await menu(retainedNode), retainedRefresh = workspace.refreshViewNode, retainedRequest: string | null = workspace.viewLiveRequestId;
      const sameRootCapture: ReturnType<typeof makeSource> = { root: retainedRoot, branch: retainedNode, leaf: retainedNode.children[0], side: retainedRoot.children[1], noRef: retainedRoot.children[2],
        snapshot: reuseSnapshot ? workspace.snapshot! : { ...workspace.snapshot!, serial: "node-refresh-second-device" } };
      await capture(sameRootCapture);
      assert(workspace.viewLiveRequestId !== retainedRequest && workspace.selectedSerial === sameRootCapture.snapshot.serial,
        "same-root fixture did not replace device/request identity");
      const beforeRetained: number = refreshes.length;
      await reply(retainedMenu, "refresh-node");
      assert(refreshes.length === beforeRetained, "old menu entered a new device/request with the same root object");
      let retainedDirect!: Promise<void>;
      act(() => { retainedDirect = retainedRefresh(retainedNode); }); await tick();
      const staleRequested = refreshes.length !== beforeRetained;
      if (staleRequested) {
        act(() => refreshes[beforeRetained].resolve({ nodes: [{ ...retainedNode, text: "旧请求回复" }], failures: [] }));
      }
      await retainedDirect; await tick();
      assert(!staleRequested && workspace.snapshot === sameRootCapture.snapshot,
        `retained refresh callback requested an old device/request despite reused ${reuseSnapshot ? "snapshot" : "root"}`);
    }
    source = await capture(); act(() => workspace.setSelectedNode(source.leaf)); await tick();
    checks.push("unsupported capture never acquires live View request; same-root device/request replacement rejects old menu and direct callbacks; expected refresh requests only, no image/style/copy IPC");
    render(); await tick();
    const result = { passed: true, fixtureOnly: true, phoneOperations: 0, checks, expectedRefreshRequests: refreshes.length,
      refreshScopes: refreshes.map(({ scope }) => scope), fixtureCaptureRequests: captures, unexpected, cleanup };
    retained = keepVisual;
    return result;
  } finally {
    if (!retained) cleanup();
    window.electronApi = oldApi;
    if (storedCollapse === null) localStorage.removeItem(TREE_COLLAPSE_STORAGE_KEY); else localStorage.setItem(TREE_COLLAPSE_STORAGE_KEY, storedCollapse);
  }
}
