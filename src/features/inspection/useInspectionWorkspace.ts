import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type { InspectionPort } from "../../platform/desktop-services";
import type { LayerFocus, LayerImageAction, LayerImageScopeOption, LayerMenuAction, LayerMenuMode, InspectionPreview, TreeDoubleClickAction, UiNode, UiSnapshot } from "../../../shared/types";
import { flattenNodes, nodeDisplayLabel, mergeLayerImages, remapViewNodeIds } from "../../../shared/tree-utils";
import { collapseTreeBranch, expandAncestors, indexTree } from "../../../shared/visible-tree";
import { DEFAULT_TREE_COLLAPSE, initialTreeExpansion, MAX_COLLAPSE_PREFERENCE_LENGTH, parseTreeCollapsePreference, reconcileTreeExpansion, treeExpansionForBranch, treeExpansionToContent, TREE_COLLAPSE_STORAGE_KEY, type TreeCollapsePreference } from "../../../shared/tree-collapse";
import { findNodePath } from "./locators";
import { createNodeVisitHistory, reconcileNodeVisits, rememberNodeReading, stepNodeVisit, visitNode,
  type NodeHistoryControlsState, type NodeHistoryView, type NodeHistoryViewRequest, type NodeReadingPositions } from "./node-visit-history";
import type { ViewingScope } from "./viewing-scope";
import { isLayerCopyAction, isLayerImageAction, isLayerRefreshAction, layerRefreshActionScope, layerMenuActionEnabled, isLayerMenuAction, layerCopyActions, layerCopyLabels, layerMenuCopyValues } from "../../../shared/layer-context-menu";

import { manuallyHiddenAncestor, manuallyHiddenLayers } from "../../../shared/tree-hidden-state";
import { stepTreeSearchMatch, treeSearchMatches, type TreeSearchNavigation } from "../../../shared/tree-search-navigation";
import { useInspectionSession } from "./useInspectionSession";
import { useSnapshotAugmentation } from "./useSnapshotAugmentation";
import type { RefreshedDocument } from "./inspection-refresh";
import { captureTreePresentation } from "./inspection-presentation";

export function expandedTreeNodeIds(root: UiNode) {
  return new Set([...flattenNodes(root).values()].filter(node => node.children.length > 0).map(node => node.id));
}

// Owns browsing state. Capture and augmentation controllers own their request lifetimes.
export function useInspectionWorkspace(options: {
  api?: InspectionPort;
  onImageAction?: (action: LayerImageAction, node: UiNode) => void;
  imageScopesForNode?: (node: UiNode) => LayerImageScopeOption[];
  refreshBlocked?: () => boolean;
} = {}) {
  const api = options.api ?? window.electronApi;
  const previousApiRef = useRef(api);
  const imageOptionsRef = useRef(options);
  imageOptionsRef.current = options;
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null);
  const [preferredSerial, setPreferredSerial] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<UiSnapshot | null>(null);
  const [requiresRecapture, setRequiresRecapture] = useState(false);
  const [treeCapturedAt, setTreeCapturedAt] = useState<string | null>(null);
  const [layerFocus, setLayerFocus] = useState<LayerFocus | null>(null);
  const [hiddenNodeIds, setHiddenNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [layerMenuError, setLayerMenuError] = useState<string | null>(null);
  const [treeRestoreRequest, setTreeRestoreRequest] = useState(0);
  const focusReturnRef = useRef<{ root: UiNode; expanded: ReadonlySet<string>; selectedId: string | null } | null>(null);
  const menuRequestRef = useRef(0);
  const nodeNavigationEpochRef = useRef(0);
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
  const captureTreeTouchedRef = useRef(false);
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
  const [warningDismissed, setWarningDismissed] = useState(false);
  const [selectedNode, setSelectedNodeState] = useState<UiNode | null>(null);
  const [treeQuery, setTreeQuery] = useState("");
  const [interactiveOnly, setInteractiveOnly] = useState(false);
  const [identifiedOnly, setIdentifiedOnly] = useState(false);
  const [treeSession, setTreeSession] = useState(0);
  useEffect(() => setWarningDismissed(false), [treeSession]);
  const [treeExpandedIds, setTreeExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const handleExpandedChange = useCallback((next: SetStateAction<ReadonlySet<string>>) => {
    captureTreeTouchedRef.current = true;
    setTreeExpandedIds(next);
  }, []);
  const [treeRevealRequest, setTreeRevealRequest] = useState(0);
  const currentSnapshotRef = useRef(snapshot);
  currentSnapshotRef.current = snapshot;
  const nodes = useMemo(() => snapshot?.root ? flattenNodes(snapshot.root) : new Map<string, UiNode>(), [snapshot?.root]);
  const treeIndex = useMemo(() => snapshot?.root ? indexTree(snapshot.root) : new Map(), [snapshot?.root]);
  const selectedNodeRef = useRef(selectedNode);
  selectedNodeRef.current = selectedNode;
  const session = useInspectionSession(api, {
    begin: serial => beginCapture(serial), preview: event => previewCapture(event),
    complete: result => completeCapture(result), discard: reason => discardCapture(reason),
    open: (next, nodeId, capturedAt) => presentExternalSnapshot(next, nodeId, capturedAt), clear: () => clearPresentedSnapshot(),
  });
  const { inspectionLoading, inspectionStage, inspectionElapsed, inspectionError, captureFailures,
    qmlLiveRequestId, viewLiveRequestId } = session;
  const { cancelInspection } = session.controller;
  const augmentation = useSnapshotAugmentation({ api, snapshot, qmlLiveRequestId, viewLiveRequestId,
    isCapturing: session.controller.isCapturing,
    refreshBlocked: () => Boolean(imageOptionsRef.current.refreshBlocked?.()),
    document: {
      current: () => currentSnapshotRef.current,
      canRefresh: (node, source) => source === currentSnapshotRef.current && actionEpoch === nodeNavigationEpochRef.current && nodes.get(node.id) === node,
      invalidateMenus: () => { menuRequestRef.current++; },
      replace: change => replaceRefreshedDocument(change),
    },
  });
  const { viewRefreshingNodeId, viewRefreshStatus, cancelViewRefresh, refreshViewNode, refreshScopesForNode,
    groupRequestId, requestGroup, availableGroupImages, snapshotForStorage, dismissViewRefreshStatus } = augmentation;
  const invalidateLiveInspection = useCallback(() => {
    if (!session.controller.isConnected()) return;
    menuRequestRef.current++;
    augmentation.invalidateLiveRequests(); session.controller.invalidateLiveRequests();
    setRequiresRecapture(Boolean(currentSnapshotRef.current?.root));
  }, [augmentation.invalidateLiveRequests, session.controller]);
  const resetPresentation = useCallback(() => {
    setRequiresRecapture(false);
    menuRequestRef.current++; nodeNavigationEpochRef.current++;
    augmentation.invalidateGroups(); focusReturnRef.current = null;
    setLayerFocus(null); setHiddenNodeIds(new Set()); setLayerMenuError(null);
  }, [augmentation.invalidateGroups]);
  useEffect(() => () => { menuRequestRef.current++; }, [api]);

  function beginCapture(serial: string) {
    resetPresentation(); currentSnapshotRef.current = null; captureTreeRef.current = null;
    captureTreeTouchedRef.current = false; sessionCollapseRef.current = collapsePreferenceRef.current;
    setTreeSession(value => value + 1); setPreferredSerial(serial); setSelectedSerial(serial);
    setSnapshot(null); setTreeCapturedAt(null); augmentation.clearRefreshStatus();
    setSelectedNodeState(null); setTreeExpandedIds(new Set());
    setTreeQuery(""); setInteractiveOnly(false); setIdentifiedOnly(false);
  }
  function discardCapture(reason: "cancel" | "failure") {
    if (reason === "cancel") resetPresentation();
    captureTreeRef.current = null;
    setSnapshot(null); setTreeCapturedAt(null); setSelectedNodeState(null); setTreeExpandedIds(new Set());
  }
  function presentCaptureTree(root: UiNode | null, previous: UiNode | null) {
    const present = captureTreePresentation(previous, root, captureTreeTouchedRef.current, sessionCollapseRef.current);
    setSelectedNodeState(present.select); setTreeExpandedIds(present.expand);
    if (present.restore) setTreeRestoreRequest(value => value + 1);
  }
  function previewCapture(event: InspectionPreview) {
    menuRequestRef.current++;
    if (event.phase === "layers") {
      const current = currentSnapshotRef.current;
      if (!current?.root) return;
      const root = mergeLayerImages(current.root, event.updates), next = { ...current, root };
      captureTreeRef.current = root; currentSnapshotRef.current = next; setSnapshot(next);
      if (!captureTreeTouchedRef.current) setTreeExpandedIds(initialTreeExpansion(root, sessionCollapseRef.current));
      const updatedNodes = flattenNodes(root);
      setSelectedNodeState(selected => selected ? updatedNodes.get(selected.id) ?? null : null);
      return;
    }
    const preview = event.snapshot, previous = captureTreeRef.current;
    captureTreeRef.current = preview.root; currentSnapshotRef.current = preview;
    setSnapshot(preview); setTreeCapturedAt(new Date().toISOString()); presentCaptureTree(preview.root, previous);
  }
  function completeCapture(result: UiSnapshot) {
    const previous = captureTreeRef.current; captureTreeRef.current = null;
    setSnapshot(result); setTreeCapturedAt(result.root ? new Date().toISOString() : null); presentCaptureTree(result.root, previous);
  }
  function replaceRefreshedDocument(change: RefreshedDocument) {
    const sourceRoot = change.before.root!, replacement = change.after.root!;
    setSnapshot(change.after);
    if (change.scope === "node") {
      setTreeCapturedAt(new Date().toISOString());
      setSelectedNodeState(current => current ? findNodePath(replacement, current.id)?.at(-1) ?? current : current);
      return;
    }
    const freshNodes = flattenNodes(replacement), remap = remapViewNodeIds(sourceRoot, replacement);
    setTreeExpandedIds(previous => reconcileTreeExpansion(sourceRoot, replacement, previous, sessionCollapseRef.current));
    setTreeRestoreRequest(value => value + 1);
    setSelectedNodeState(current => {
      if (!current) return null;
      const path = findNodePath(sourceRoot, current.id) ?? [];
      for (let index = path.length - 1; index >= 0; index--) {
        const mapped = remap.get(path[index].id);
        if (mapped && freshNodes.has(mapped)) return freshNodes.get(mapped)!;
      }
      return change.branch!;
    });
  }

  const scopeRevision = useMemo(() => ({}), [snapshot?.root, layerFocus, hiddenNodeIds, treeQuery, interactiveOnly, identifiedOnly]);
  const currentScopeRevision = useRef(scopeRevision);
  currentScopeRevision.current = scopeRevision;
  const previousRootRef = useRef<UiNode | null>(null);

  const [nodeHistoryState, setNodeHistoryState] = useState(() => createNodeVisitHistory(null, 0, null));
  const nodeHistoryRef = useRef(nodeHistoryState);
  const [historyViewRequest, setHistoryViewRequest] = useState<NodeHistoryViewRequest | null>(null);
  const historyViewRevision = useRef(0);
  const historyReaders = useRef(new Map<keyof NodeReadingPositions, Parameters<NodeHistoryView["register"]>[1]>());
  const registerHistoryView: NodeHistoryView["register"] = useCallback((surface, reader) => {
    historyReaders.current.set(surface, reader);
    return () => { if (historyReaders.current.get(surface) === reader) historyReaders.current.delete(surface); };
  }, []);
  const rememberCurrentVisit = useCallback(() => {
    const history = nodeHistoryRef.current, current = history.visits[history.cursor];
    if (!current) return history;
    const positions: NodeReadingPositions = {};
    for (const [surface, reader] of historyReaders.current) {
      const read = reader();
      if (read?.node === current.node) positions[surface] = read.position;
    }
    return nodeHistoryRef.current = rememberNodeReading(history, positions);
  }, []);
  const recordNodeVisit = useCallback((node: UiNode) => {
    captureTreeTouchedRef.current = true;
    const before = rememberCurrentVisit(), next = visitNode(before, node);
    nodeHistoryRef.current = next; setNodeHistoryState(next);
    if (before.visits[before.cursor]?.node !== node && next.root) setHistoryViewRequest({
      root: next.root, node, revision: ++historyViewRevision.current, positions: {}, restoring: false,
    });
  }, [rememberCurrentVisit]);
  useLayoutEffect(() => {
    const root = snapshot?.root ?? null, history = nodeHistoryRef.current;
    const current = selectedNode && nodes.get(selectedNode.id) === selectedNode ? selectedNode : null;
    const next = reconcileNodeVisits(history, root, treeSession, current);
    if (history.root !== root || history.session !== treeSession) setHistoryViewRequest(null);
    if (next !== history) { nodeHistoryRef.current = next; setNodeHistoryState(next); }
  }, [snapshot?.root, treeSession, nodes, selectedNode]);
  const selectionEpoch = nodeNavigationEpochRef.current;
  const setSelectedNode = useCallback((node: UiNode | null) => {
    if (selectionEpoch !== nodeNavigationEpochRef.current || snapshot?.root !== currentSnapshotRef.current?.root
      || node && nodes.get(node.id) !== node) return false;
    if (node) recordNodeVisit(node);
    selectedNodeRef.current = node; setSelectedNodeState(node); return true;
  }, [selectionEpoch, snapshot?.root, nodes, recordNodeVisit]);

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
      if (saved) { setTreeExpandedIds(saved.expanded); setSelectedNodeState(nodes.get(saved.selectedId ?? "") ?? root); }
      setTreeRestoreRequest(value => value + 1);
    }
  }, [snapshot?.root, nodes, resetPresentation]);

  const exitLayerFocus = useCallback((recordVisit = true) => {
    menuRequestRef.current++;
    const saved = focusReturnRef.current;
    focusReturnRef.current = null;
    setLayerFocus(null);
    if (saved && saved.root === currentSnapshotRef.current?.root) {
      setTreeExpandedIds(saved.expanded);
      const target = saved.selectedId ? flattenNodes(saved.root).get(saved.selectedId) ?? saved.root : null;
      if (recordVisit && target) recordNodeVisit(target);
      setSelectedNodeState(target);
      setTreeRestoreRequest(value => value + 1);
    }
  }, [recordNodeVisit]);

  // Tree, canvas, context menus and the menu bar all dispatch here.
  const actionEpoch = nodeNavigationEpochRef.current;
  const handleLayerAction = useCallback((action: LayerMenuAction, requestedNode: UiNode | null = selectedNode, skipEmptyLayers = false) => {
    if (!isLayerMenuAction(action) || !action || isLayerCopyAction(action) || isLayerImageAction(action)) return;
    if (!snapshot?.root || currentSnapshotRef.current?.root !== snapshot.root || actionEpoch !== nodeNavigationEpochRef.current
      || scopeRevision !== currentScopeRevision.current || augmentation.isRefreshing()) return;
    const localAction = action === "restore-selected" || action === "locate-hidden-ancestor" || action === "expand-branch" || action === "collapse-children";
    if (localAction && session.controller.isCapturing()) return;
    const node = requestedNode && nodes.get(requestedNode.id);
    if (requestedNode && node !== requestedNode) return;
    menuRequestRef.current++;
    if (action === "exit-focus") { exitLayerFocus(); return; }
    if (action === "restore") { setHiddenNodeIds(new Set()); setLayerMenuError(null); return; }
    if (!node) return;
    if (action === "restore-selected") {
      if (!hiddenNodeIds.has(node.id)) return;
      setHiddenNodeIds(current => { const next = new Set(current); next.delete(node.id); return next; });
      setLayerMenuError(null);
    } else if (action === "locate-hidden-ancestor") {
      const ancestor = manuallyHiddenAncestor(treeIndex, node, hiddenNodeIds);
      if (!ancestor) return;
      recordNodeVisit(ancestor);
      if (layerFocus && (layerFocus.kind === "layer" ? layerFocus.node !== ancestor : !findNodePath(layerFocus.node, ancestor.id))) exitLayerFocus(false);
      setSelectedNodeState(ancestor);
      setTreeQuery(""); setInteractiveOnly(false); setIdentifiedOnly(false);
      setTreeRevealRequest(value => value + 1);
      setLayerMenuError(null);
    } else if (action === "focus" || action === "focus-branch") {
      if (snapshot.captureMode === "fast") { setLayerMenuError("当前快照没有独立图层，请使用深度采集后聚焦。"); return; }
      const kind = action === "focus-branch" ? "branch" : "layer";
      if (layerFocus?.node.id === node.id && layerFocus.kind === kind) return;
      focusReturnRef.current ??= { root: snapshot.root, expanded: treeExpandedIds, selectedId: selectedNode?.id ?? null };
      recordNodeVisit(node);
      setLayerFocus({ node, kind });
      setSelectedNodeState(node);
      // Focus narrows the inspection scope; keep existing folds so preloaded
      // pages and component internals appear only when explicitly expanded.
    } else if (action === "hide") {
      if (node.visibleToUser && node.bounds) setHiddenNodeIds(current => new Set([...current, node.id]));
    } else if (node.children.length && !treeQuery.trim() && !interactiveOnly && !identifiedOnly) {
      if (action === "expand-branch" || action === "collapse-children")
        handleExpandedChange(current => treeExpansionForBranch(node, action, current, selectedNode?.id ?? null));
      else if (action === "expand" || action === "collapse")
        handleExpandedChange(current => action === "collapse" ? collapseTreeBranch(current, node.id)
          : skipEmptyLayers ? treeExpansionToContent(node, current) : new Set([...current, node.id]));
    }
  }, [snapshot?.root, nodes, selectedNode, layerFocus, hiddenNodeIds, treeIndex, treeExpandedIds, treeQuery, interactiveOnly, identifiedOnly, actionEpoch, scopeRevision, exitLayerFocus, handleExpandedChange, recordNodeVisit]);

  const handleNodeDoubleClick = useCallback((node: UiNode) => {
    if (doubleClickAction === "focus-branch") handleLayerAction("focus-branch", node);
    else handleLayerAction(doubleClickAction === "toggle" && treeExpandedIds.has(node.id) ? "collapse" : "expand", node, true);
  }, [doubleClickAction, treeExpandedIds, handleLayerAction]);



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
  const inspectDevice = useCallback((serial: string, priorityViewRef?: string | null, diagnostic?: { expectedPackage: string; requestId: string }) => {
    if (!session.controller.isConnected()) return Promise.resolve(null);
    if (diagnostic && session.controller.isCapturing()) return Promise.reject(new Error("已有采集正在运行。"));
    cancelViewRefresh();
    return session.controller.inspectDevice(serial, priorityViewRef, diagnostic);
  }, [cancelViewRefresh, session.controller]);

  const handleScreenshotSelect = useCallback((node: UiNode) => {
    if (!setSelectedNode(node)) return;
    setTreeQuery("");
    setInteractiveOnly(false);
    setIdentifiedOnly(false);
    setTreeRevealRequest((value) => value + 1);
  }, [setSelectedNode]);

  const openLayerMenu = useCallback(async (node: UiNode | null, onCopyValue?: (label: string, value: string) => void | Promise<void>, mode: LayerMenuMode = "layers3d") => {
    const sourceRoot = snapshot?.root;
    if (!sourceRoot || sourceRoot !== currentSnapshotRef.current?.root || actionEpoch !== nodeNavigationEpochRef.current
      || scopeRevision !== currentScopeRevision.current || augmentation.isRefreshing()) return;
    const target = node && nodes.get(node.id) || null;
    if (node && target !== node || mode === "flat" && !target) return;
    const copyValues = onCopyValue ? layerMenuCopyValues(sourceRoot, target) : {};
    if (target) { recordNodeVisit(target); selectedNodeRef.current = target; setSelectedNodeState(target); }
    const request = ++menuRequestRef.current;
    setLayerMenuError(null);
    const canHide = Boolean(target?.visibleToUser && target.bounds && !hiddenNodeIds.has(target.id));
    const ancestor = target ? manuallyHiddenAncestor(treeIndex, target, hiddenNodeIds) : null;
    const valid = () => request === menuRequestRef.current && sourceRoot === currentSnapshotRef.current?.root
      && actionEpoch === nodeNavigationEpochRef.current && scopeRevision === currentScopeRevision.current
      && !augmentation.isRefreshing();
    try {
      const busy = Boolean(session.controller.isCapturing());
      const availableScopes = target && imageOptionsRef.current.onImageAction ? imageOptionsRef.current.imageScopesForNode?.(target) : undefined;
      const imageScopes = busy ? availableScopes?.map(scope => ({ ...scope, available: false, detail: "采集中，完成后可操作图片" })) : availableScopes;
      const options = {
        mode, refreshScopes: target ? refreshScopesForNode(target) : undefined,
        canFocus: Boolean(target && snapshot.captureMode !== "fast"), expandable: Boolean(target?.children.length && !busy && !treeQuery.trim() && !interactiveOnly && !identifiedOnly),
        expanded: Boolean(target && treeExpandedIds.has(target.id)), hasChildren: Boolean(target?.children.length),
        canRestoreSelected: Boolean(target && !busy && hiddenNodeIds.has(target.id)),
        hiddenAncestorLabel: ancestor && !busy ? nodeDisplayLabel(ancestor).slice(0, 160) : undefined,
        imageScopes,
        copyActions: layerCopyActions.filter(action => copyValues[action] !== undefined),
      };
      const action = await api.showLayerMenu(canHide, hiddenNodeIds.size > 0, Boolean(layerFocus), options);
      if (!valid()) return;
      if (!isLayerMenuAction(action)) throw new Error("图层菜单动作无效。");
      if (!layerMenuActionEnabled(action, options)) return;
      if (isLayerCopyAction(action)) {
        const value = copyValues[action];
        if (value !== undefined && onCopyValue) await onCopyValue(layerCopyLabels[action], value);
      } else if (isLayerRefreshAction(action)) {
        if (!target || selectedNodeRef.current !== target) return;
        const scope = layerRefreshActionScope(action);
        if (!refreshScopesForNode(target).some(option => option.scope === scope && option.available)) return;
        await refreshViewNode(target, scope);
      } else if (isLayerImageAction(action)) {
        if (!session.controller.isCapturing() && target && selectedNodeRef.current === target)
          imageOptionsRef.current.onImageAction?.(action, target);
      } else {
        if ((action === "restore-selected" || action === "locate-hidden-ancestor" || action === "expand-branch" || action === "collapse-children")
          && selectedNodeRef.current !== target) return;
        handleLayerAction(action, target);
      }
    } catch {
      if (valid()) setLayerMenuError("无法打开图层菜单，请重试。");
    }
  }, [snapshot?.root, nodes, hiddenNodeIds, treeIndex, layerFocus, treeQuery, interactiveOnly, identifiedOnly, treeExpandedIds, actionEpoch, scopeRevision, handleLayerAction, recordNodeVisit, refreshScopesForNode, refreshViewNode, api]);

  const clearTreeFilter = useCallback(() => {
    setTreeQuery("");
    setInteractiveOnly(false);
    setIdentifiedOnly(false);
  }, []);

  const nodeNavigationEpoch = nodeNavigationEpochRef.current;
  const hiddenListScope = useMemo(() => ({}), [snapshot?.root, treeSession, nodeNavigationEpoch]);
  const hiddenLayers = useMemo(() => manuallyHiddenLayers(treeIndex, hiddenNodeIds), [treeIndex, hiddenNodeIds]);
  const changeViewingScope = useCallback((action: "query" | "interactive" | "identified" | "focus" | "hidden" | "all") => {
    const root = snapshot?.root;
    if (!root || root !== currentSnapshotRef.current?.root || nodeNavigationEpoch !== nodeNavigationEpochRef.current
      || scopeRevision !== currentScopeRevision.current || session.controller.isCapturing() || augmentation.isRefreshing()) return false;
    menuRequestRef.current++;
    if (action === "all") clearTreeFilter();
    else if (action === "query") setTreeQuery("");
    else if (action === "interactive") setInteractiveOnly(false);
    else if (action === "identified") setIdentifiedOnly(false);
    if ((action === "focus" || action === "all") && layerFocus) exitLayerFocus();
    if (action === "hidden" || action === "all") setHiddenNodeIds(new Set());
    return true;
  }, [snapshot?.root, nodeNavigationEpoch, scopeRevision, layerFocus, exitLayerFocus, clearTreeFilter]);
  const selectedHiddenAncestor = selectedNode ? manuallyHiddenAncestor(treeIndex, selectedNode, hiddenNodeIds) : null;
  const canChangeHiddenLayer = (node: UiNode) => Boolean(snapshot?.root && snapshot.root === currentSnapshotRef.current?.root
    && nodeNavigationEpoch === nodeNavigationEpochRef.current && scopeRevision === currentScopeRevision.current
    && !session.controller.isCapturing() && !augmentation.isRefreshing() && nodes.get(node.id) === node && hiddenNodeIds.has(node.id));
  const viewingScope: ViewingScope = {
    hiddenLayers, hiddenListScope,
    locateHiddenLayer: node => {
      const root = snapshot?.root;
      return Boolean(root && canChangeHiddenLayer(node) && navigateToNode(node, root));
    },
    restoreHiddenLayer: node => {
      if (!canChangeHiddenLayer(node)) return false;
      handleLayerAction("restore-selected", node); return true;
    },
    selectedHiddenAncestorLabel: selectedHiddenAncestor ? nodeDisplayLabel(selectedHiddenAncestor) : null,
    locateHiddenAncestor: () => {
      if (!selectedHiddenAncestor || selectedNodeRef.current !== selectedNode || viewingScope.disabledReason || scopeRevision !== currentScopeRevision.current
        || nodeNavigationEpoch !== nodeNavigationEpochRef.current || snapshot?.root !== currentSnapshotRef.current?.root
        || session.controller.isCapturing() || augmentation.isRefreshing()) return false;
      handleLayerAction("locate-hidden-ancestor", selectedNode); return true;
    },
    focusLabel: layerFocus ? nodeDisplayLabel(layerFocus.node) : null, focusKind: layerFocus?.kind ?? null,
    query: treeQuery, interactiveOnly, identifiedOnly, hiddenCount: hiddenNodeIds.size,
    disabledReason: inspectionLoading ? "采集中，完成后可调整查看范围" : viewRefreshingNodeId ? "刷新中，完成后可调整查看范围" : !snapshot?.root ? "暂无快照" : null,
    clearQuery: () => changeViewingScope("query"), clearInteractive: () => changeViewingScope("interactive"),
    clearIdentified: () => changeViewingScope("identified"), exitFocus: () => changeViewingScope("focus"),
    restoreHidden: () => changeViewingScope("hidden"), restoreAll: () => changeViewingScope("all"),
  };
  const searchRoot = layerFocus?.kind === "branch" ? layerFocus.node : snapshot?.root;
  const searchActive = Boolean(treeQuery.trim() || interactiveOnly || identifiedOnly);
  const searchMatches = useMemo(() => searchActive && searchRoot ? treeSearchMatches(searchRoot, { query: treeQuery, interactiveOnly, identifiedOnly }) : [],
    [searchRoot, searchActive, treeQuery, interactiveOnly, identifiedOnly]);
  const searchPosition = selectedNode ? searchMatches.indexOf(selectedNode) : -1;
  const moveSearchMatch = useCallback((direction: -1 | 1) => {
    const root = snapshot?.root;
    if (!root || root !== currentSnapshotRef.current?.root || nodeNavigationEpoch !== nodeNavigationEpochRef.current
      || scopeRevision !== currentScopeRevision.current || session.controller.isCapturing() || augmentation.isRefreshing()) return false;
    const target = stepTreeSearchMatch(searchMatches, selectedNodeRef.current, direction);
    if (!target || nodes.get(target.id) !== target) return false;
    menuRequestRef.current++;
    recordNodeVisit(target); selectedNodeRef.current = target; setSelectedNodeState(target); setTreeRevealRequest(value => value + 1);
    return true;
  }, [snapshot?.root, nodeNavigationEpoch, scopeRevision, searchMatches, nodes, recordNodeVisit]);
  const treeSearchNavigation: TreeSearchNavigation = {
    active: searchActive, count: searchMatches.length, position: searchPosition < 0 ? null : searchPosition + 1,
    disabledReason: inspectionLoading ? "采集中，完成后可巡览匹配" : viewRefreshingNodeId ? "刷新中，完成后可巡览匹配" : !searchMatches.length ? "没有匹配的控件" : null,
    previous: () => moveSearchMatch(-1), next: () => moveSearchMatch(1),
  };
  const navigateToNode = useCallback((node: UiNode, sourceRoot: UiNode) => {
    if (nodeNavigationEpoch !== nodeNavigationEpochRef.current || sourceRoot !== snapshot?.root
      || sourceRoot !== currentSnapshotRef.current?.root || nodes.get(node.id) !== node
      || session.controller.isCapturing() || augmentation.isRefreshing()) return false;
    menuRequestRef.current++;
    recordNodeVisit(node);
    if (layerFocus && (layerFocus.kind === "layer" ? layerFocus.node !== node : !findNodePath(layerFocus.node, node.id))) exitLayerFocus(false);
    setSelectedNodeState(node);
    clearTreeFilter();
    setTreeRevealRequest(value => value + 1);
    return true;
  }, [nodeNavigationEpoch, snapshot?.root, nodes, layerFocus, exitLayerFocus, clearTreeFilter, recordNodeVisit]);

  const moveNodeHistory = useCallback((direction: -1 | 1) => {
    const root = snapshot?.root;
    if (!root || root !== currentSnapshotRef.current?.root || nodeNavigationEpoch !== nodeNavigationEpochRef.current
      || session.controller.isCapturing() || augmentation.isRefreshing() || nodeHistoryRef.current.root !== root
      || nodeHistoryRef.current.session !== treeSession) return false;
    const before = rememberCurrentVisit(), next = stepNodeVisit(before, direction);
    const target = next.visits[next.cursor];
    if (next === before || !target || nodes.get(target.node.id) !== target.node) return false;
    menuRequestRef.current++;
    if (layerFocus && (layerFocus.kind === "layer" ? layerFocus.node !== target.node : !findNodePath(layerFocus.node, target.node.id))) exitLayerFocus(false);
    nodeHistoryRef.current = next; setNodeHistoryState(next);
    setSelectedNodeState(target.node); clearTreeFilter(); setTreeRevealRequest(value => value + 1);
    setHistoryViewRequest({ root, node: target.node, revision: ++historyViewRevision.current, positions: target.positions, restoring: true });
    return true;
  }, [snapshot?.root, nodeNavigationEpoch, treeSession, nodes, layerFocus, exitLayerFocus, clearTreeFilter, rememberCurrentVisit]);
  const historyCurrent = nodeHistoryState.root === snapshot?.root && nodeHistoryState.session === treeSession;
  const backTarget = historyCurrent ? nodeHistoryState.visits[nodeHistoryState.cursor - 1]?.node : null;
  const forwardTarget = historyCurrent ? nodeHistoryState.visits[nodeHistoryState.cursor + 1]?.node : null;
  const nodeHistory: NodeHistoryControlsState = {
    canBack: Boolean(backTarget), canForward: Boolean(forwardTarget),
    backLabel: backTarget ? nodeDisplayLabel(backTarget) : null, forwardLabel: forwardTarget ? nodeDisplayLabel(forwardTarget) : null,
    disabledReason: inspectionLoading ? "采集中，完成后可查看历史" : viewRefreshingNodeId ? "正在刷新控件，完成后可查看历史" : !snapshot?.root ? "暂无快照" : null,
    back: () => moveNodeHistory(-1), forward: () => moveNodeHistory(1),
  };
  const nodeHistoryView = useMemo<NodeHistoryView>(() => ({ request: historyViewRequest, register: registerHistoryView }), [historyViewRequest, registerHistoryView]);

  function clearPresentedSnapshot() {
    resetPresentation();
    currentSnapshotRef.current = null;
    setSelectedSerial(null);
    setSnapshot(null);
    setTreeCapturedAt(null);
    augmentation.clearRefreshStatus();
    setSelectedNodeState(null);
    setTreeExpandedIds(new Set());
  }
  const clearInspection = useCallback(() => {
    if (!session.controller.isConnected()) return;
    cancelViewRefresh(); session.controller.clearInspection();
  }, [cancelViewRefresh, session.controller]);

  useEffect(() => {
    if (previousApiRef.current === api) return;
    previousApiRef.current = api;
    // Old-port cleanup has already canceled its requests. Their finally blocks
    // must not restore this state or leave the new connection permanently busy.
    clearInspection();
  }, [api, clearInspection]);

  // History and automation take ownership before old promises/events can settle.
  function presentExternalSnapshot(next: UiSnapshot, selectedNodeId?: string | null, capturedAt: string | null = null) {
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
    augmentation.clearRefreshStatus();
    setSelectedNodeState((selectedNodeId && next.root ? flattenNodes(next.root).get(selectedNodeId) : null) ?? next.root);
    setTreeExpandedIds(next.root ? initialTreeExpansion(next.root, preference) : new Set());
    clearTreeFilter();
    setTreeRevealRequest(value => value + 1);
    setWarningDismissed(false);
  }
  const showSnapshot = useCallback((next: UiSnapshot, selectedNodeId?: string | null, capturedAt: string | null = null) => {
    if (!session.controller.isConnected()) return;
    cancelViewRefresh(); session.controller.showSnapshot(next, selectedNodeId, capturedAt);
  }, [cancelViewRefresh, session.controller]);

  const canApplyTreeCollapse = Boolean(snapshot?.root && !inspectionLoading && !viewRefreshingNodeId
    && !layerFocus && !treeQuery.trim() && !interactiveOnly && !identifiedOnly);
  const applyTreeCollapsePreference = useCallback((value: TreeCollapsePreference) => {
    const preference = parseTreeCollapsePreference(value), root = snapshot?.root;
    if (!preference || !root || !canApplyTreeCollapse || session.controller.isCapturing() || augmentation.isRefreshing() || currentSnapshotRef.current?.root !== root) return;
    setTreeCollapsePreference(preference);
    sessionCollapseRef.current = preference;
    setTreeExpandedIds(expandAncestors(indexTree(root), initialTreeExpansion(root, preference), selectedNode?.id ?? null));
  }, [snapshot?.root, selectedNode?.id, canApplyTreeCollapse, setTreeCollapsePreference]);

  return {
    selectedSerial, preferredSerial, setPreferredSerial, snapshot, treeCapturedAt, selectedNode, setSelectedNode, nodeHistory, nodeHistoryView, viewingScope, treeSearchNavigation,
    inspectionLoading, inspectionStage, inspectionElapsed, inspectionError, captureFailures,
    warningDismissed, setWarningDismissed, treeQuery, setTreeQuery, interactiveOnly, setInteractiveOnly,
    identifiedOnly, setIdentifiedOnly, treeSession, treeExpandedIds, setTreeExpandedIds: handleExpandedChange, treeRevealRequest,
    viewLiveRequestId, viewRefreshingNodeId, viewRefreshStatus, requiresRecapture, invalidateLiveInspection,
    dismissViewRefreshStatus, groupRequestId, requestGroup, refreshViewNode, refreshScopesForNode, snapshotForStorage, availableGroupImages,
    inspectDevice, cancelInspection, clearInspection, showSnapshot, clearTreeFilter, handleExpandedChange,
    handleScreenshotSelect, navigateToNode, layerFocus, hiddenNodeIds, layerMenuError, treeRestoreRequest,
    doubleClickAction, setDoubleClickAction, handleNodeDoubleClick, handleLayerAction, openLayerMenu,
    treeCollapsePreference, setTreeCollapsePreference, applyTreeCollapsePreference, canApplyTreeCollapse,
  };
}
