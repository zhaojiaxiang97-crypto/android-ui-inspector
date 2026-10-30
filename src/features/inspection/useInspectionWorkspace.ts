import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type { LayerFocus, LayerMenuAction, QmlGroupImage, TreeDoubleClickAction, UiNode, UiSnapshot } from "../../../shared/types";
import { isGroupImage } from "../../../shared/snapshot-validation";
import { flattenNodes, mergeLayerImages, remapViewNodeIds, replaceTreeBranch } from "../../../shared/tree-utils";
import { collapseTreeBranch, expandAncestors, indexTree } from "../../../shared/visible-tree";
import { DEFAULT_TREE_COLLAPSE, initialTreeExpansion, MAX_COLLAPSE_PREFERENCE_LENGTH, parseTreeCollapsePreference, reconcileTreeExpansion, TREE_COLLAPSE_STORAGE_KEY, type TreeCollapsePreference } from "../../../shared/tree-collapse";
import { rememberCaptureFailures, type CaptureFailureRecord } from "../../../shared/capture-feedback";
import { findNodePath } from "./locators";
import { isLayerCopyAction, isLayerMenuAction, layerCopyActions, layerCopyLabels, layerMenuCopyValues } from "../../../shared/layer-context-menu";

export function expandedTreeNodeIds(root: UiNode) {
  return new Set([...flattenNodes(root).values()].filter(node => node.children.length > 0).map(node => node.id));
}

// Owns the displayed tree and the requests allowed to change it.
export function useInspectionWorkspace() {
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null);
  const [preferredSerial, setPreferredSerial] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<UiSnapshot | null>(null);
  const [treeCapturedAt, setTreeCapturedAt] = useState<string | null>(null);
  const [layerFocus, setLayerFocus] = useState<LayerFocus | null>(null);
  const [hiddenNodeIds, setHiddenNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [layerMenuError, setLayerMenuError] = useState<string | null>(null);
  const [treeRestoreRequest, setTreeRestoreRequest] = useState(0);
  const focusReturnRef = useRef<{ root: UiNode; expanded: ReadonlySet<string>; selectedId: string | null } | null>(null);
  const menuRequestRef = useRef(0);
  const nodeNavigationEpochRef = useRef(0);
  const groupEpochRef = useRef(0);
  const capturedGroupsRef = useRef<{ root: UiNode; images: Map<string, QmlGroupImage> } | null>(null);
  const [groupImageRevision, setGroupImageRevision] = useState(0);
  const pendingGroupsRef = useRef<{ root: UiNode; epoch: number; requestId: string; requests: Map<string, Promise<QmlGroupImage | null>> } | null>(null);
  const [treeCollapsePreference, setCollapsePreference] = useState<TreeCollapsePreference>(() => {
    try {
      const stored = localStorage.getItem(TREE_COLLAPSE_STORAGE_KEY);
      if (stored && stored.length <= MAX_COLLAPSE_PREFERENCE_LENGTH)
        return parseTreeCollapsePreference(JSON.parse(stored)) ?? DEFAULT_TREE_COLLAPSE;
    } catch { /* Inspection remains usable with a blocked or damaged preference store. */ }
    return DEFAULT_TREE_COLLAPSE;
  });
  const collapsePreferenceRef = useRef(treeCollapsePreference);
  const sessionCollapseRef = useRef(treeCollapsePreference);
  const captureTreeRef = useRef<UiNode | null>(null);
  const setTreeCollapsePreference = useCallback((value: TreeCollapsePreference) => {
    const preference = parseTreeCollapsePreference(value);
    if (!preference) return;
    collapsePreferenceRef.current = preference;
    setCollapsePreference(preference);
    try { localStorage.setItem(TREE_COLLAPSE_STORAGE_KEY, JSON.stringify(preference)); } catch { /* Keep the preference in this window. */ }
  }, []);
  const [doubleClickAction, setDoubleClickPreference] = useState<TreeDoubleClickAction>(() => {
    try { const value = localStorage.getItem("android-ui-inspector.double-click");
      if (value === "toggle" || value === "focus-branch" || value === "expand") return value;
    } catch { /* A blocked preference store does not prevent inspection. */ }
    return "toggle";
  });
  const setDoubleClickAction = useCallback((value: TreeDoubleClickAction) => {
    setDoubleClickPreference(value);
    try { localStorage.setItem("android-ui-inspector.double-click", value); } catch { /* Keep the preference for this window. */ }
  }, []);
  const resetPresentation = useCallback(() => {
    menuRequestRef.current++;
    nodeNavigationEpochRef.current++;
    groupEpochRef.current++;
    capturedGroupsRef.current = null;
    focusReturnRef.current = null;
    setLayerFocus(null);
    setHiddenNodeIds(new Set());
    setLayerMenuError(null);
  }, []);
  const [qmlLiveRequestId, setQmlLiveRequestId] = useState<string | null>(null);
  const [viewLiveRequestId, setViewLiveRequestId] = useState<string | null>(null);
  const [viewRefreshingNodeId, setViewRefreshingNodeId] = useState<string | null>(null);
  const viewRefreshActiveRef = useRef<{ requestId: string } | null>(null);
  const [viewRefreshStatus, setViewRefreshStatus] = useState<{ nodeId: string; message: string } | null>(null);
  const cancelViewRefresh = useCallback(() => {
    const active = viewRefreshActiveRef.current;
    viewRefreshActiveRef.current = null;
    if (active) void window.electronApi.cancelInspection(active.requestId);
    setViewRefreshingNodeId(null);
  }, []);
  const [warningDismissed, setWarningDismissed] = useState(false);
  const [selectedNode, setSelectedNode] = useState<UiNode | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const activeInspectionRef = useRef<string | null>(null);
  const previewShownRef = useRef(false);
  const inspectionStartedRef = useRef(0);
  const [inspectionStage, setInspectionStage] = useState("连接 Debug App");
  const [inspectionElapsed, setInspectionElapsed] = useState(0);
  useEffect(() => window.electronApi.onInspectionProgress((progress) => {
    if (progress.requestId === activeInspectionRef.current) setInspectionStage(progress.stage);
  }), []);
  useEffect(() => window.electronApi.onInspectionPreview((event) => {
    if (event.requestId !== activeInspectionRef.current) return;
    if (event.phase === "layers") {
      if (!previewShownRef.current) return;
      const current = currentSnapshotRef.current;
      if (!current?.root) return;
      menuRequestRef.current++;
      const root = mergeLayerImages(current.root, event.updates), next = { ...current, root };
      currentSnapshotRef.current = next;
      setSnapshot(next);
      const updatedNodes = flattenNodes(root);
      setSelectedNode(selected => selected ? updatedNodes.get(selected.id) ?? null : null);
      return;
    }
    const preview = event.snapshot;
    if (!preview.root) return;
    menuRequestRef.current++;
    const first = !previewShownRef.current;
    const previousTree = captureTreeRef.current;
    const preference = sessionCollapseRef.current;
    captureTreeRef.current = preview.root;
    previewShownRef.current = true;
    currentSnapshotRef.current = preview;
    setSnapshot(preview);
    setTreeCapturedAt(new Date().toISOString());
    if (first) {
      setSelectedNode(preview.root);
      setTreeExpandedIds(initialTreeExpansion(preview.root, preference));
    } else {
      const nodes = flattenNodes(preview.root);
      const remap = previousTree ? remapViewNodeIds(previousTree, preview.root) : null;
      setSelectedNode((current) => (current && nodes.get(remap ? remap.get(current.id) ?? "" : current.id)) ?? preview.root);
      setTreeExpandedIds((current) => reconcileTreeExpansion(previousTree, preview.root!, current, preference));
      setTreeRestoreRequest(value => value + 1);
    }
  }), []);
  useEffect(() => {
    if (!inspectionLoading) return;
    const timer = setInterval(() => setInspectionElapsed(Math.floor((performance.now() - inspectionStartedRef.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [inspectionLoading]);
  useEffect(() => () => {
    const requestId = activeInspectionRef.current;
    const refresh = viewRefreshActiveRef.current;
    activeInspectionRef.current = null;
    viewRefreshActiveRef.current = null;
    previewShownRef.current = false;
    menuRequestRef.current++;
    groupEpochRef.current++;
    capturedGroupsRef.current = null;
    if (requestId) void window.electronApi.cancelInspection(requestId);
    if (refresh) void window.electronApi.cancelInspection(refresh.requestId);
  }, []);
  const cancelInspection = useCallback((onlyRequestId?: string) => {
    const requestId = activeInspectionRef.current;
    if (onlyRequestId && onlyRequestId !== requestId) return;
    activeInspectionRef.current = null;
    captureTreeRef.current = null;
    if (previewShownRef.current) {
      resetPresentation();
      setSnapshot(null);
      setTreeCapturedAt(null);
      setSelectedNode(null);
      setTreeExpandedIds(new Set());
    }
    previewShownRef.current = false;
    if (requestId) void window.electronApi.cancelInspection(requestId);
    setInspectionLoading(false);
    if (requestId) setInspectionError("已取消采集，可以重新开始。");
  }, [resetPresentation]);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [captureFailures, setCaptureFailures] = useState<CaptureFailureRecord[]>([]);
  const [treeQuery, setTreeQuery] = useState("");
  const [interactiveOnly, setInteractiveOnly] = useState(false);
  const [identifiedOnly, setIdentifiedOnly] = useState(false);
  const [treeSession, setTreeSession] = useState(0);
  useEffect(() => setWarningDismissed(false), [treeSession]);
  const [treeExpandedIds, setTreeExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const handleExpandedChange = useCallback((next: SetStateAction<ReadonlySet<string>>) => {
    setTreeExpandedIds(next);
  }, []);
  const [treeRevealRequest, setTreeRevealRequest] = useState(0);
  const currentSnapshotRef = useRef(snapshot);
  currentSnapshotRef.current = snapshot;
  const nodes = useMemo(() => snapshot?.root ? flattenNodes(snapshot.root) : new Map<string, UiNode>(), [snapshot?.root]);
  const previousRootRef = useRef<UiNode | null>(null);

  useLayoutEffect(() => {
    const root = snapshot?.root ?? null, previous = previousRootRef.current;
    previousRootRef.current = root;
    if (!root) {
      if (previous) resetPresentation();
      return;
    }
    if (!previous || root === previous) return;
    menuRequestRef.current++;
    const remap = remapViewNodeIds(previous, root);
    const mapIds = (ids: ReadonlySet<string>) => new Set([...ids].flatMap(id => remap.has(id) ? [remap.get(id)!] : []));
    setHiddenNodeIds(current => mapIds(current));
    const saved = focusReturnRef.current;
    if (saved) {
      saved.expanded = reconcileTreeExpansion(saved.root, root, saved.expanded, sessionCollapseRef.current);
      saved.root = root;
      saved.selectedId = saved.selectedId ? remap.get(saved.selectedId) ?? root.id : null;
    }
    if (!layerFocus) return;
    const target = nodes.get(remap.get(layerFocus.node.id) ?? "");
    if (target) setLayerFocus({ ...layerFocus, node: target });
    else {
      setLayerFocus(null);
      focusReturnRef.current = null;
      if (saved) { setTreeExpandedIds(saved.expanded); setSelectedNode(nodes.get(saved.selectedId ?? "") ?? root); }
      setTreeRestoreRequest(value => value + 1);
    }
  }, [snapshot?.root, nodes, resetPresentation]);

  const exitLayerFocus = useCallback(() => {
    menuRequestRef.current++;
    const saved = focusReturnRef.current;
    focusReturnRef.current = null;
    setLayerFocus(null);
    if (saved && saved.root === currentSnapshotRef.current?.root) {
      setTreeExpandedIds(saved.expanded);
      setSelectedNode(saved.selectedId ? flattenNodes(saved.root).get(saved.selectedId) ?? saved.root : null);
      setTreeRestoreRequest(value => value + 1);
    }
  }, []);

  // Tree, canvas, context menus and the menu bar all dispatch here.
  const handleLayerAction = useCallback((action: LayerMenuAction, requestedNode: UiNode | null = selectedNode) => {
    if (!isLayerMenuAction(action) || !action || isLayerCopyAction(action)) return;
    menuRequestRef.current++;
    if (action === "exit-focus") { exitLayerFocus(); return; }
    if (action === "restore") { setHiddenNodeIds(new Set()); return; }
    if (!snapshot?.root || currentSnapshotRef.current?.root !== snapshot.root) return;
    const node = requestedNode && nodes.get(requestedNode.id);
    if (!node) return;
    if (action === "focus" || action === "focus-branch") {
      if (snapshot.captureMode === "fast") { setLayerMenuError("当前快照没有独立图层，请使用深度采集后聚焦。"); return; }
      const kind = action === "focus-branch" ? "branch" : "layer";
      if (layerFocus?.node.id === node.id && layerFocus.kind === kind) return;
      focusReturnRef.current ??= { root: snapshot.root, expanded: treeExpandedIds, selectedId: selectedNode?.id ?? null };
      setLayerFocus({ node, kind });
      setSelectedNode(node);
      if (kind === "branch") setTreeExpandedIds(current => new Set([...current, ...expandedTreeNodeIds(node)]));
    } else if (action === "hide") {
      if (node.visibleToUser && node.bounds) setHiddenNodeIds(current => new Set([...current, node.id]));
    } else if (node.children.length && !treeQuery.trim() && !interactiveOnly && !identifiedOnly) {
      handleExpandedChange(current => action === "collapse" ? collapseTreeBranch(current, node.id) : new Set([...current, node.id]));
    }
  }, [snapshot?.root, nodes, selectedNode, layerFocus, treeExpandedIds, treeQuery, interactiveOnly, identifiedOnly, exitLayerFocus, handleExpandedChange]);

  const handleNodeDoubleClick = useCallback((node: UiNode) => {
    if (doubleClickAction === "focus-branch") handleLayerAction("focus-branch", node);
    else handleLayerAction(doubleClickAction === "toggle" && treeExpandedIds.has(node.id) ? "collapse" : "expand", node);
  }, [doubleClickAction, treeExpandedIds, handleLayerAction]);

  const openLayerMenu = useCallback(async (node: UiNode | null, onCopyValue?: (label: string, value: string) => void | Promise<void>) => {
    const sourceRoot = snapshot?.root;
    if (!sourceRoot || sourceRoot !== currentSnapshotRef.current?.root || viewRefreshActiveRef.current) return;
    const target = node && nodes.get(node.id) || null;
    if (node && target !== node) return;
    const copyValues = onCopyValue ? layerMenuCopyValues(sourceRoot, target) : {};
    if (target) setSelectedNode(target);
    const request = ++menuRequestRef.current;
    setLayerMenuError(null);
    const canHide = Boolean(target?.visibleToUser && target.bounds && !hiddenNodeIds.has(target.id));
    try {
      const action = await window.electronApi.showLayerMenu(canHide, hiddenNodeIds.size > 0, Boolean(layerFocus), {
        canFocus: Boolean(target && snapshot.captureMode !== "fast"), expandable: Boolean(target?.children.length && !treeQuery.trim() && !interactiveOnly && !identifiedOnly),
        expanded: Boolean(target && treeExpandedIds.has(target.id)),
        copyActions: layerCopyActions.filter(action => copyValues[action] !== undefined),
      });
      if (request !== menuRequestRef.current || sourceRoot !== currentSnapshotRef.current?.root || viewRefreshActiveRef.current) return;
      if (!isLayerMenuAction(action)) throw new Error("图层菜单动作无效。");
      if (isLayerCopyAction(action)) {
        const value = copyValues[action];
        if (value !== undefined && onCopyValue) await onCopyValue(layerCopyLabels[action], value);
      } else handleLayerAction(action, target);
    } catch {
      if (request === menuRequestRef.current && sourceRoot === currentSnapshotRef.current?.root) setLayerMenuError("无法打开图层菜单，请重试。");
    }
  }, [snapshot?.root, nodes, hiddenNodeIds, layerFocus, treeQuery, interactiveOnly, identifiedOnly, treeExpandedIds, handleLayerAction]);

  useEffect(() => {
    if (!layerFocus) return;
    const escape = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "Escape" || event.defaultPrevented || target?.closest("input, textarea, select, [contenteditable=true], details[open]")) return;
      event.preventDefault(); exitLayerFocus();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [layerFocus, exitLayerFocus]);
  const inspectDevice = useCallback(async (serial: string, priorityViewRef?: string | null, diagnostic?: { expectedPackage: string; requestId: string }): Promise<UiSnapshot | null> => {
    if (diagnostic && activeInspectionRef.current) throw new Error("已有采集正在运行。");
    cancelViewRefresh();
    resetPresentation();
    currentSnapshotRef.current = null;
    if (activeInspectionRef.current) void window.electronApi.cancelInspection(activeInspectionRef.current);
    const requestId = diagnostic?.requestId ?? crypto.randomUUID();
    activeInspectionRef.current = requestId;
    previewShownRef.current = false;
    captureTreeRef.current = null;
    sessionCollapseRef.current = collapsePreferenceRef.current;
    inspectionStartedRef.current = performance.now();
    setInspectionStage("连接 Debug App");
    setInspectionElapsed(0);
    setTreeSession((value) => value + 1);
    setPreferredSerial(serial);
    setSelectedSerial(serial);
    setSnapshot(null);
    setTreeCapturedAt(null);
    setQmlLiveRequestId(null);
    setViewLiveRequestId(null);
    setViewRefreshStatus(null);
    setSelectedNode(null);
    setTreeExpandedIds(new Set());
    setInspectionError(null);
    setTreeQuery("");
    setInteractiveOnly(false);
    setIdentifiedOnly(false);
    setInspectionLoading(true);

    try {
      const result = await window.electronApi.inspectDevice(serial, requestId, priorityViewRef, diagnostic ? true : undefined,
        diagnostic ? { expectedPackage: diagnostic.expectedPackage } : undefined);
      if (activeInspectionRef.current !== requestId) return null;
      const hadPreview = previewShownRef.current;
      const previousTree = captureTreeRef.current;
      const preference = sessionCollapseRef.current;
      captureTreeRef.current = result.root;
      setCaptureFailures(previous => rememberCaptureFailures(previous, result, requestId));
      setSnapshot(result);
      setTreeCapturedAt(result.root ? new Date().toISOString() : null);
      setQmlLiveRequestId(result.inspectionSource === "debug-qml" && result.root?.attributes?.["qml-process-id"] ? requestId : null);
      setViewLiveRequestId((result.inspectionSource === "debug-view" || result.inspectionSource === "debug-hybrid")
        && result.root?.attributes?.["debug-process-id"] && result.root.attributes["debug-window-name"] ? requestId : null);
      if (hadPreview && result.root) {
        const nodes = flattenNodes(result.root);
        const remap = previousTree ? remapViewNodeIds(previousTree, result.root) : null;
        setSelectedNode((current) => (current && nodes.get(remap ? remap.get(current.id) ?? "" : current.id)) ?? result.root);
        setTreeExpandedIds(current => reconcileTreeExpansion(previousTree, result.root!, current, preference));
        setTreeRestoreRequest(value => value + 1);
      } else {
        setSelectedNode(result.root);
        setTreeExpandedIds(result.root ? initialTreeExpansion(result.root, preference) : new Set());
      }
      if (result.error) {
        setInspectionError(result.error);
      }
      return result;
    } catch (error) {
      if (activeInspectionRef.current !== requestId) return null;
      const message = typeof error === "string" ? error : error instanceof Error ? error.message : "读取 UI hierarchy 失败，请确认设备仍保持连接。";
      setCaptureFailures(previous => rememberCaptureFailures(previous, { serial, root: null, nodeCount: 0, xmlSize: 0,
        rawXml: null, screenshotDataUrl: null, warning: null, error: message }, requestId));
      if (previewShownRef.current) {
        setSnapshot(null);
        setTreeCapturedAt(null);
        setSelectedNode(null);
        setTreeExpandedIds(new Set());
      }
      setInspectionError(message);
      if (diagnostic) throw error;
      return null;
    } finally {
      if (activeInspectionRef.current === requestId) {
        activeInspectionRef.current = null;
        captureTreeRef.current = null;
        setInspectionLoading(false);
      }
    }
  }, [cancelViewRefresh, resetPresentation]);

  const handleScreenshotSelect = useCallback((node: UiNode) => {
    setSelectedNode(node);
    setTreeQuery("");
    setInteractiveOnly(false);
    setIdentifiedOnly(false);
    setTreeRevealRequest((value) => value + 1);
  }, []);

  const groupRequestId = qmlLiveRequestId ?? (snapshot?.inspectionSource === "debug-hybrid" ? viewLiveRequestId : null);
  const requestGroup = useCallback(async (node: UiNode) => {
    const source = currentSnapshotRef.current;
    if (!groupRequestId || !source?.root) return null;
    const sourceRoot = source.root;
    const epoch = groupEpochRef.current;
    const cached = capturedGroupsRef.current?.root === source.root ? capturedGroupsRef.current.images.get(node.id) : null;
    if (cached) return cached;
    if (pendingGroupsRef.current?.root !== source.root || pendingGroupsRef.current.epoch !== epoch || pendingGroupsRef.current.requestId !== groupRequestId)
      pendingGroupsRef.current = { root: source.root, epoch, requestId: groupRequestId, requests: new Map() };
    const requests = pendingGroupsRef.current.requests;
    const pending = requests.get(node.id);
    if (pending) return pending;
    const result = (async () => {
      const image = await window.electronApi.captureGroup(groupRequestId, node.id);
      if (!isGroupImage(image) || epoch !== groupEpochRef.current || currentSnapshotRef.current !== source) return null;
      if (capturedGroupsRef.current?.root !== sourceRoot) capturedGroupsRef.current = { root: sourceRoot, images: new Map() };
      capturedGroupsRef.current.images.set(node.id, image);
      setGroupImageRevision(value => value + 1);
      return image;
    })();
    requests.set(node.id, result);
    try { return await result; }
    finally { if (requests.get(node.id) === result) requests.delete(node.id); }
  }, [groupRequestId]);

  const availableGroupImages = useMemo(() => {
    const groups = new Map((snapshot?.layerGroupImages ?? []).map(group => [group.nodeId, group.image]));
    if (snapshot?.root && capturedGroupsRef.current?.root === snapshot.root)
      for (const [nodeId, image] of capturedGroupsRef.current.images) groups.set(nodeId, image);
    return [...groups].map(([nodeId, image]) => ({ nodeId, image }));
  }, [snapshot?.root, snapshot?.layerGroupImages, groupImageRevision]);

  const snapshotForStorage = useCallback(() => {
    const current = currentSnapshotRef.current;
    if (!current?.root || capturedGroupsRef.current?.root !== current.root) return current;
    const groups = new Map((current.layerGroupImages ?? []).map(group => [group.nodeId, group.image]));
    for (const [nodeId, image] of capturedGroupsRef.current.images) groups.set(nodeId, image);
    return { ...current, layerGroupImages: [...groups].map(([nodeId, image]) => ({ nodeId, image })) };
  }, []);

  const refreshViewNode = useCallback(async (node: UiNode, scope: "node" | "branch" | "list" = "node") => {
    if (!snapshot?.root || !viewLiveRequestId || viewRefreshActiveRef.current || inspectionLoading) return;
    const active = { requestId: viewLiveRequestId };
    viewRefreshActiveRef.current = active;
    menuRequestRef.current++;
    const sourceSnapshot = snapshot;
    const sourceRoot = snapshot.root;
    setViewRefreshingNodeId(node.id);
    setViewRefreshStatus(null);
    try {
      const result = await window.electronApi.refreshViewNode(viewLiveRequestId, node.id, scope);
      if (viewRefreshActiveRef.current !== active || currentSnapshotRef.current !== sourceSnapshot || activeInspectionRef.current) return;
      if (scope === "branch" || scope === "list") {
        if (!result.branch) throw new Error("没有返回可更新的分支。");
        const replacement = replaceTreeBranch(sourceRoot, node.id, result.branch);
        const freshNodes = flattenNodes(replacement);
        if (result.failures.some(failure => !freshNodes.has(failure.id))) throw new Error("分支补图结果无效。");
        const remap = remapViewNodeIds(sourceRoot, replacement);
        setSnapshot({ ...sourceSnapshot, root: replacement, nodeCount: freshNodes.size, layerGroupImages: undefined });
        const preference = sessionCollapseRef.current;
        setTreeExpandedIds(previous => reconcileTreeExpansion(sourceRoot, replacement, previous, preference));
        setTreeRestoreRequest(value => value + 1);
        setSelectedNode(current => {
          if (!current) return null;
          const path = findNodePath(sourceRoot, current.id) ?? [];
          for (let index = path.length - 1; index >= 0; index--) {
            const mapped = remap.get(path[index].id);
            if (mapped && freshNodes.has(mapped)) return freshNodes.get(mapped)!;
          }
          return result.branch!;
        });
        setViewRefreshStatus({ nodeId: node.id, message: `${scope === "list" ? "可见项分批刷新完成" : "分支已更新"}，共 ${flattenNodes(result.branch).size} 层${result.failures.length ? `，${result.failures.length} 层补图失败` : ""}` });
        return;
      }
      const sourceNodes = flattenNodes(sourceRoot);
      const validId = (id: string) => sourceNodes.has(id) && id === node.id;
      if (!result.nodes.length || result.nodes.some(updated => !validId(updated.id)) || result.failures.some(failure => !validId(failure.id)))
        throw new Error("控件已变化，请重新采集整页。");
      const updates = new Map(result.nodes.map(updated => [updated.id, updated]));
      for (const failure of result.failures) {
        const old = sourceNodes.get(failure.id)!;
        updates.set(failure.id, { ...old, attributes: { ...old.attributes, "image-refresh-error": failure.message } });
      }
      const replace = (current: UiNode): UiNode => {
        const children = current.children.map(replace);
        const updated = updates.get(current.id);
        return updated ? { ...updated, children } : children.some((child, index) => child !== current.children[index]) ? { ...current, children } : current;
      };
      const replacement = replace(sourceRoot);
      setSnapshot({ ...sourceSnapshot, root: replacement, layerGroupImages: undefined });
      setTreeCapturedAt(new Date().toISOString());
      setSelectedNode(current => current ? findNodePath(replacement, current.id)?.at(-1) ?? current : current);
      setViewRefreshStatus({ nodeId: node.id, message: "已刷新当前控件" });
    } catch (error) {
      if (viewRefreshActiveRef.current === active && currentSnapshotRef.current === sourceSnapshot) setViewRefreshStatus({ nodeId: node.id, message: error instanceof Error ? error.message : "当前控件刷新失败" });
    } finally {
      if (viewRefreshActiveRef.current === active) { viewRefreshActiveRef.current = null; setViewRefreshingNodeId(null); }
    }
  }, [snapshot, viewLiveRequestId, inspectionLoading]);

  const clearTreeFilter = useCallback(() => {
    setTreeQuery("");
    setInteractiveOnly(false);
    setIdentifiedOnly(false);
  }, []);

  const nodeNavigationEpoch = nodeNavigationEpochRef.current;
  const navigateToNode = useCallback((node: UiNode, sourceRoot: UiNode) => {
    if (nodeNavigationEpoch !== nodeNavigationEpochRef.current || sourceRoot !== snapshot?.root
      || sourceRoot !== currentSnapshotRef.current?.root || nodes.get(node.id) !== node
      || activeInspectionRef.current || viewRefreshActiveRef.current) return false;
    menuRequestRef.current++;
    if (layerFocus && (layerFocus.kind === "layer" ? layerFocus.node !== node : !findNodePath(layerFocus.node, node.id))) exitLayerFocus();
    setSelectedNode(node);
    clearTreeFilter();
    setTreeRevealRequest(value => value + 1);
    return true;
  }, [nodeNavigationEpoch, snapshot?.root, nodes, layerFocus, exitLayerFocus, clearTreeFilter]);

  const clearInspection = useCallback(() => {
    cancelViewRefresh();
    cancelInspection();
    resetPresentation();
    currentSnapshotRef.current = null;
    setSelectedSerial(null);
    setSnapshot(null);
    setTreeCapturedAt(null);
    setQmlLiveRequestId(null);
    setViewLiveRequestId(null);
    setViewRefreshStatus(null);
    setSelectedNode(null);
    setTreeExpandedIds(new Set());
    setInspectionError(null);
  }, [cancelInspection, cancelViewRefresh, resetPresentation]);

  // History and automation take ownership before old promises/events can settle.
  const showSnapshot = useCallback((next: UiSnapshot, selectedNodeId?: string | null, capturedAt: string | null = null) => {
    cancelViewRefresh();
    cancelInspection();
    resetPresentation();
    currentSnapshotRef.current = next;
    captureTreeRef.current = null;
    const preference = collapsePreferenceRef.current;
    sessionCollapseRef.current = preference;
    setTreeSession(value => value + 1);
    setPreferredSerial(next.serial);
    setSelectedSerial(next.serial);
    setSnapshot(next);
    setTreeCapturedAt(capturedAt);
    setQmlLiveRequestId(null);
    setViewLiveRequestId(null);
    setViewRefreshStatus(null);
    setSelectedNode((selectedNodeId && next.root ? flattenNodes(next.root).get(selectedNodeId) : null) ?? next.root);
    setTreeExpandedIds(next.root ? initialTreeExpansion(next.root, preference) : new Set());
    clearTreeFilter();
    setTreeRevealRequest(value => value + 1);
    setInspectionError(next.error);
    setWarningDismissed(false);
  }, [cancelInspection, cancelViewRefresh, clearTreeFilter, resetPresentation]);

  const canApplyTreeCollapse = Boolean(snapshot?.root && !inspectionLoading && !viewRefreshingNodeId
    && !layerFocus && !treeQuery.trim() && !interactiveOnly && !identifiedOnly);
  const applyTreeCollapsePreference = useCallback((value: TreeCollapsePreference) => {
    const preference = parseTreeCollapsePreference(value), root = snapshot?.root;
    if (!preference || !root || !canApplyTreeCollapse || activeInspectionRef.current || viewRefreshActiveRef.current || currentSnapshotRef.current?.root !== root) return;
    setTreeCollapsePreference(preference);
    sessionCollapseRef.current = preference;
    setTreeExpandedIds(expandAncestors(indexTree(root), initialTreeExpansion(root, preference), selectedNode?.id ?? null));
  }, [snapshot?.root, selectedNode?.id, canApplyTreeCollapse, setTreeCollapsePreference]);

  return {
    selectedSerial, preferredSerial, setPreferredSerial, snapshot, treeCapturedAt, selectedNode, setSelectedNode,
    inspectionLoading, inspectionStage, inspectionElapsed, inspectionError, captureFailures,
    warningDismissed, setWarningDismissed, treeQuery, setTreeQuery, interactiveOnly, setInteractiveOnly,
    identifiedOnly, setIdentifiedOnly, treeSession, treeExpandedIds, setTreeExpandedIds, treeRevealRequest,
    viewLiveRequestId, viewRefreshingNodeId, viewRefreshStatus, groupRequestId, requestGroup, refreshViewNode, snapshotForStorage, availableGroupImages,
    inspectDevice, cancelInspection, clearInspection, showSnapshot, clearTreeFilter, handleExpandedChange,
    handleScreenshotSelect, navigateToNode, layerFocus, hiddenNodeIds, layerMenuError, treeRestoreRequest,
    doubleClickAction, setDoubleClickAction, handleNodeDoubleClick, handleLayerAction, openLayerMenu,
    treeCollapsePreference, setTreeCollapsePreference, applyTreeCollapsePreference, canApplyTreeCollapse,
  };
}
