import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InspectionPort } from "../../platform/desktop-services";
import type { LayerRefreshScopeOption, UiNode, UiSnapshot } from "../../../shared/types";
import { flattenNodes } from "../../../shared/tree-utils";
import { nodeRefreshScopeOptions } from "../../../shared/node-refresh-options";
import { createGroupImageCache } from "./group-image-cache";
import { refreshedDocument, type RefreshedDocument } from "./inspection-refresh";

type DocumentPort = {
  current(): UiSnapshot | null;
  canRefresh(node: UiNode, source: UiSnapshot): boolean;
  replace(change: RefreshedDocument): void;
  invalidateMenus(): void;
};
type Options = {
  api: InspectionPort; snapshot: UiSnapshot | null;
  viewLiveRequestId: string | null; qmlLiveRequestId: string | null;
  isCapturing(): boolean; refreshBlocked(): boolean;
  document: DocumentPort;
};

/** Owns local refresh identity and group-image cache, separate from capture busy state. */
export function useSnapshotAugmentation(options: Options) {
  const { api, snapshot, viewLiveRequestId, qmlLiveRequestId } = options;
  const current = useRef(options); current.current = options;
  const [groupImageRevision, setGroupImageRevision] = useState(0);
  const groups = useMemo(() => createGroupImageCache(api, () => current.current.document.current(),
    () => setGroupImageRevision(value => value + 1)), [api]);
  const lifetime = useMemo(() => ({ active: false }), [api]);
  const activeRefresh = useRef<{ requestId: string } | null>(null);
  const [viewRefreshingNodeId, setViewRefreshingNodeId] = useState<string | null>(null);
  const [viewRefreshStatus, setViewRefreshStatus] = useState<{ nodeId: string; message: string } | null>(null);
  const cancelViewRefresh = useCallback(() => {
    const active = activeRefresh.current; activeRefresh.current = null;
    if (active) void api.cancelInspection(active.requestId);
    setViewRefreshingNodeId(null);
  }, [api]);
  useEffect(() => {
    lifetime.active = true; groups.activate();
    return () => {
      lifetime.active = false; groups.dispose();
      const active = activeRefresh.current; activeRefresh.current = null;
      if (active) void api.cancelInspection(active.requestId);
    };
  }, [api, groups, lifetime]);
  const groupRequestId = qmlLiveRequestId ?? (snapshot?.inspectionSource === "debug-hybrid" ? viewLiveRequestId : null);
  const requestGroup = useCallback((node: UiNode) => groups.request(groupRequestId, node, snapshot), [groups, groupRequestId, snapshot]);
  const availableGroupImages = useMemo(() => groups.images(snapshot), [groups, snapshot?.root, snapshot?.layerGroupImages, groupImageRevision]);
  const document = options.document;
  const nodes = useMemo(() => snapshot?.root ? flattenNodes(snapshot.root) : new Map<string, UiNode>(), [snapshot?.root]);
  const refreshViewNode = useCallback(async (node: UiNode, scope: "node" | "branch" | "list" = "node") => {
    if (!lifetime.active || !snapshot?.root || !document.canRefresh(node, snapshot) || !viewLiveRequestId || activeRefresh.current
      || current.current.isCapturing() || current.current.refreshBlocked()) return;
    const active = { requestId: viewLiveRequestId };
    activeRefresh.current = active; document.invalidateMenus();
    setViewRefreshingNodeId(node.id); setViewRefreshStatus(null);
    const valid = () => lifetime.active && activeRefresh.current === active && current.current.document.current() === snapshot && !current.current.isCapturing();
    try {
      const result = await api.refreshViewNode(viewLiveRequestId, node.id, scope);
      if (!valid()) return;
      const change = refreshedDocument(snapshot, node, scope, result);
      document.replace(change);
      const message = scope === "node" ? "已刷新当前控件"
        : `${scope === "list" ? "可见项分批刷新完成" : "分支已更新"}，共 ${flattenNodes(result.branch!).size} 层${result.failures.length ? `，${result.failures.length} 层补图失败` : ""}`;
      setViewRefreshStatus({ nodeId: node.id, message });
    } catch (error) {
      if (valid()) setViewRefreshStatus({ nodeId: node.id, message: error instanceof Error ? error.message : "当前控件刷新失败" });
    } finally {
      if (activeRefresh.current === active) { activeRefresh.current = null; setViewRefreshingNodeId(null); }
    }
  }, [snapshot, viewLiveRequestId, document, api, lifetime]);
  const refreshScopesForNode = useCallback((node: UiNode | null, retainWhileRefreshing = false): LayerRefreshScopeOption[] => nodeRefreshScopeOptions(node, {
    current: Boolean(lifetime.active && node && snapshot?.root === current.current.document.current()?.root && nodes.get(node.id) === node),
    hasLiveRequest: Boolean(viewLiveRequestId), source: snapshot?.inspectionSource,
    busy: current.current.isCapturing() ? "capture" : activeRefresh.current && !retainWhileRefreshing ? "refresh" : undefined,
    blocked: current.current.refreshBlocked(),
  }), [snapshot?.root, snapshot?.inspectionSource, viewLiveRequestId, nodes, lifetime]);
  const dismissViewRefreshStatus = useCallback(() => { if (snapshot === current.current.document.current()) setViewRefreshStatus(null); }, [snapshot]);
  const clearRefreshStatus = useCallback(() => setViewRefreshStatus(null), []);
  return { groupRequestId, requestGroup, availableGroupImages, snapshotForStorage: groups.snapshotForStorage, invalidateGroups: groups.invalidate,
    refreshViewNode, refreshScopesForNode, cancelViewRefresh, clearRefreshStatus, dismissViewRefreshStatus,
    viewRefreshingNodeId, viewRefreshStatus, isRefreshing: () => activeRefresh.current !== null };
}
