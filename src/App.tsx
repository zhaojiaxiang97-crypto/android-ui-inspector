import { AppIcon } from "./components/AppIcon";
import { useInspectionWorkspace, expandedTreeNodeIds } from "./features/inspection/useInspectionWorkspace";
import { useInspectionMode } from "./features/inspection/useInspectionMode";
import { useColorAliases } from "./features/inspection/useColorAliases";
import { useInspectorGroups } from "./features/inspection/useInspectorGroups";
import { useAppearance } from "./features/inspection/useAppearance";
import { useWorkspaceLayout } from "./features/inspection/useWorkspaceLayout";
import { useColorDisplay } from "./features/inspection/useColorDisplay";
import type { WorkspaceLayout } from "../shared/workspace-layout";
import { useContextHints } from "./features/inspection/useContextHints";
import { NodeHoverProvider } from "./features/inspection/NodeHoverContext";
import { useDebugSession } from "./features/automation/useDebugSession";
import { DebugSessionProgress } from "./features/automation/DebugSessionProgress";
import { DebugTaskEditor, type DebugTaskEditorApi } from "./features/automation/DebugTaskEditor";
import { uniqueSnapshotNode } from "./features/automation/selector-match-diagnostics";
import { ConnectionDiagnosticsPanel } from "./features/diagnostics/ConnectionDiagnosticsPanel";
import { LivePreviewPanel } from "./features/preview/LivePreviewPanel";
import { SnapshotHistory, SnapshotDiffDetails } from "./features/history/SnapshotHistory";
import { TestReportPanel } from "./features/reports/TestReportPanel";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./styles/tokens.css";
import "./App.css";
import "./styles/workbench.css";
import "./styles/entry.css";
import "./styles/appearance.css";
import "./styles/artemis-tools.css";
import "./styles/home.css";
import type { AdbProbeResult, AppMenuState, LayerImageAction, LayerImageScopeOption, LayerMenuMode, UiNode, UiSnapshot } from "../shared/types";
import { layerImageActionDetails } from "../shared/layer-context-menu";
import { nodeImageScopeOptions } from "./features/layers/node-image-action-options";
import { useNodeImageActionController, type NodeImageActionRequest } from "./features/layers/useNodeImageActionController";
import { NodeImageActionOverlay } from "./components/NodeImageActions";
import { useWorkbenchCommands } from "./features/workbench/useWorkbenchCommands";
import { useSnapshotLibrary } from "./features/history/useSnapshotLibrary";
import { createDesktopServices } from "./platform/desktop-services";
import { commandEnabled, commandShortcut, doubleClickChoices, workbenchCommands } from "../shared/workbench-commands";
import { homeStateIsConnected, homeStateIsError, resolveHomeState } from "../shared/device-state";
import { filterTree, nodeDisplayLabel } from "../shared/tree-utils";
import { AppHeader } from "./components/AppHeader";
import { UiTree } from "./components/UiTree";
import { TreeSearchInput } from "./components/TreeSearchInput";
import { ScreenshotPreview } from "./components/ScreenshotPreview";
import { NodePropertiesPanel, type NodePropertiesRevealRequest } from "./components/NodePropertiesPanel";
import { LongTextValue } from "./components/LongTextValue";
import { DeviceHomeView } from "./components/DeviceHomeView";
import { EntryDialog } from "./components/EntryDialog";
import { PreferencesPanel } from "./components/PreferencesPanel";
import type { PreferencesReadingPosition, PreferencesSection } from "./features/inspection/preferences-navigation";
import { TreePaneResizer } from "./components/TreePaneResizer";
import { CaptureFailureFeedback, CaptureFailureHistory } from "./components/CaptureFailureFeedback";
import { diffSummary } from "./features/history/model";
import { xpathForNode, uiSelectorForNode, adbTapCommand, nodeJson } from "./features/inspection/locators";


function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function inspectionSourceLabel(snapshot: UiSnapshot) {
  if (snapshot.inspectionSource === "debug-hybrid") return "SDK 树 + 独立画面";
  if (snapshot.inspectionSource === "debug-qml") return "QML Debug";
  if (snapshot.inspectionSource === "debug-view") return "View Debug";
  if (snapshot.inspectionSource === "accessibility-helper") return "无障碍 Helper";
  if (snapshot.hierarchyDumpMode === "full") return "完整 hierarchy";
  if (snapshot.hierarchyDumpMode === "compressed") return "压缩 hierarchy";
  return "Debug hierarchy";
}

function App() {
  const services = useMemo(() => createDesktopServices(window.electronApi), []);
  const [preparing3d, setPreparing3d] = useState<{ screenshot: string | null } | null>(null);
  const imageMenuCallbacks = useRef<{ onImageAction?: (action: LayerImageAction, node: UiNode) => void; imageScopesForNode?: (node: UiNode) => LayerImageScopeOption[]; refreshBlocked?: boolean }>({});
  const inspection = useInspectionWorkspace({
    api: services.inspection,
    onImageAction: (action, node) => imageMenuCallbacks.current.onImageAction?.(action, node),
    imageScopesForNode: node => imageMenuCallbacks.current.imageScopesForNode?.(node) ?? [],
    refreshBlocked: () => imageMenuCallbacks.current.refreshBlocked ?? false,
  });
  const { colorAliases, saveColorAliases } = useColorAliases();
  const { inspectorGroups, saveInspectorGroups } = useInspectorGroups();
  const { appearance, resolvedAppearance, saveAppearance, appearanceSaveError } = useAppearance();
  const { workspaceLayout, saveWorkspaceLayout, resetWorkspaceLayout, workspaceLayoutError } = useWorkspaceLayout();
  const { colorFormat, saveColorFormat, colorFormatSaveError } = useColorDisplay();
  const saveTreeWidth = useCallback((treeWidth: number) => saveWorkspaceLayout({ ...workspaceLayout, treeWidth }), [workspaceLayout, saveWorkspaceLayout]);
  const saveInspectorLayout = useCallback((inspector: WorkspaceLayout["inspector"]) => saveWorkspaceLayout({ ...workspaceLayout, inspector }), [workspaceLayout, saveWorkspaceLayout]);
  const {
    selectedSerial, preferredSerial, setPreferredSerial, snapshot, treeCapturedAt, selectedNode, setSelectedNode,
    inspectionLoading, inspectionStage, inspectionElapsed, inspectionError, captureFailures,
    warningDismissed, setWarningDismissed, treeQuery, setTreeQuery, interactiveOnly, setInteractiveOnly,
    identifiedOnly, setIdentifiedOnly, treeSession, treeExpandedIds, setTreeExpandedIds, treeRevealRequest,
    viewLiveRequestId, viewRefreshingNodeId, viewRefreshStatus, dismissViewRefreshStatus, groupRequestId, requestGroup, refreshViewNode, refreshScopesForNode, snapshotForStorage, availableGroupImages,
    cancelInspection, clearInspection, showSnapshot, clearTreeFilter, handleExpandedChange,
    handleScreenshotSelect, navigateToNode, layerFocus, hiddenNodeIds, layerMenuError, treeRestoreRequest,
    doubleClickAction, setDoubleClickAction, handleNodeDoubleClick, handleLayerAction, openLayerMenu,
    treeCollapsePreference, setTreeCollapsePreference, applyTreeCollapsePreference, canApplyTreeCollapse,
    nodeHistory, nodeHistoryView, viewingScope, treeSearchNavigation,
  } = inspection;
  useEffect(() => { if (!inspectionLoading) setPreparing3d(null); }, [inspectionLoading]);
  const contextHints = useContextHints(treeSession, inspectionLoading || Boolean(viewRefreshingNodeId));
  const [probe, setProbe] = useState<AdbProbeResult | null>(null);
  const probeRequest = useRef(0);
  const probePending = useRef(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  // The first render happens before the probe effect runs. Start in loading so
  // the home state never flashes an error while the bridge is being queried.
  const [loading, setLoading] = useState(true);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const copyRequest = useRef(0);
  const [sceneToolbarHost, setSceneToolbarHost] = useState<HTMLDivElement | null>(null);
  const [testReportOpen, setTestReportOpen] = useState(false);
  const [debugReportRequest, setDebugReportRequest] = useState(0);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [homeHistoryOpen, setHomeHistoryOpen] = useState(false);
  const [preferencesSection, setPreferencesSection] = useState<PreferencesSection | undefined>(undefined);
  const preferencesReading = useRef<PreferencesReadingPosition | undefined>(undefined);
  const [menuImageRequest, setMenuImageRequest] = useState<NodeImageActionRequest | null>(null);
  const menuImageSequence = useRef(0);
  const [connectionDiagnosticsOpen, setConnectionDiagnosticsOpen] = useState(false);
  const [debugTaskEditorVisibility, setDebugTaskEditorVisibility] = useState<"unopened" | "open" | "closed">("unopened");
  const [livePreviewSerial, setLivePreviewSerial] = useState<string | null>(null);
  const connectionDiagnosticApi = services.diagnostics;
  const debugTaskEditorApi = useMemo<DebugTaskEditorApi | undefined>(() => {
    const api = window.electronApi;
    return api.loadDebugTaskTemplates && api.saveDebugTaskTemplate && api.deleteDebugTaskTemplate && api.defineDebugTask && api.checkDebugTask
      ? { loadDebugTaskTemplates: api.loadDebugTaskTemplates, saveDebugTaskTemplate: api.saveDebugTaskTemplate,
        deleteDebugTaskTemplate: api.deleteDebugTaskTemplate, defineDebugTask: api.defineDebugTask, checkDebugTask: api.checkDebugTask,
        loadDebugTaskFragments: api.loadDebugTaskFragments, saveDebugTaskFragment: api.saveDebugTaskFragment,
        deleteDebugTaskFragment: api.deleteDebugTaskFragment, importDebugTaskTemplates: api.importDebugTaskTemplates,
        exportDebugTaskTemplates: api.exportDebugTaskTemplates } : undefined;
  }, []);
  const [propertiesRevealRequest, setPropertiesRevealRequest] = useState<NodePropertiesRevealRequest | null>(null);
  const snapshotApi = services.snapshots;
  const menuApi = services.menu;
  const clearCopyStatus = useCallback(() => setCopyStatus(null), []);
  const library = useSnapshotLibrary({ api: snapshotApi, snapshot, treeCapturedAt, snapshotForStorage, showSnapshot,
    beforeOpen: async () => { setLivePreviewSerial(null); await stopMcpSharing("history"); }, clearCopyStatus });
  const { savedSnapshots, snapshotsLoading, snapshotStoreError, snapshotStatus, snapshotOrigin, diffExportStatus,
    latestDiff, diffExpanded, setDiffExpanded, exportStatus, openingSnapshot, snapshotFileStatus, dismissSnapshotFileStatus,
    invalidateSnapshotFile, resetForCapture, resetForHome, showLiveSnapshot,
    exportCurrentSnapshot, exportLatestDiff, saveCurrentSnapshot, clearSavedSnapshots, viewSavedSnapshot, openSnapshotFile } = library;
  const { mcpSharing, mcpBusy, debugState, debugStatus, setDebugStatus,
    stopMcpSharing, shareMcpSnapshot, copyMcpConfig, androidLogsEnabled, setAndroidLogsEnabled, startDebugSession: startDebug } = useDebugSession({
      snapshot, selectedNode, inspectionLoading, showSnapshot: showLiveSnapshot,
    });
  const inspectionMode = useInspectionMode(services.inspectionMode, inspection.invalidateLiveInspection,
    inspectionLoading || Boolean(viewRefreshingNodeId) || Boolean(debugState?.active));

  function revealTaskMatch(nodeId: string, sourceSnapshot: UiSnapshot) {
    if (sourceSnapshot !== snapshot) return false;
    const node = uniqueSnapshotNode(snapshot, nodeId);
    if (!node || !sourceSnapshot.root || !navigateToNode(node, sourceSnapshot.root)) return false;
    setDebugTaskEditorVisibility("closed");
    return true;
  }

  const refreshDevices = useCallback(async () => {
    if (probePending.current) return;
    probePending.current = true;
    const request = ++probeRequest.current;
    setLoading(true);
    setRuntimeError(null);

    try {
      const result = await window.electronApi.probeAdb();
      if (probeRequest.current !== request) return;
      setProbe(result);
      setCheckedAt(new Date());
    } catch (error) {
      if (probeRequest.current !== request) return;
      setRuntimeError(
        typeof error === "string"
          ? error
          : error instanceof Error ? error.message : "无法连接到 Electron 后端，请使用桌面应用启动。",
      );
      setCheckedAt(new Date());
    } finally {
      if (probeRequest.current === request) {
        probePending.current = false;
        setLoading(false);
      }
    }
  }, []);

  const inspectDevice = useCallback((serial: string, priorityViewRef?: string | null, diagnostic?: { expectedPackage: string; requestId: string }, layerCapture: "on-demand" | "full" = "on-demand") => {
    if (layerCapture !== "full" || diagnostic) setPreparing3d(null);
    resetForCapture();
    setCopyStatus(null);
    return inspection.inspectDevice(serial, priorityViewRef, diagnostic, diagnostic ? "full" : layerCapture);
  }, [inspection.inspectDevice, resetForCapture]);

  const closeInspector = useCallback(() => {
    setPreparing3d(null);
    setLivePreviewSerial(null);
    resetForHome();
    clearInspection();
    void stopMcpSharing("home");
    setCopyStatus(null);
  }, [clearInspection, stopMcpSharing, resetForHome]);

  useEffect(() => {
    void refreshDevices();
    return () => { probeRequest.current++; probePending.current = false; };
  }, [refreshDevices]);

  const devices = probe?.devices ?? [];
  const readyDevices = useMemo(
    () => devices.filter((device) => device.state === "device"),
    [devices],
  );
  const detailNode = selectedNode ?? snapshot?.root ?? null;
  const fontApi = window.electronApi;
  const canReadSelectedFont = Boolean(fontApi.readViewFont && viewLiveRequestId && selectedNode?.attributes?.["view-ref"]
    && (snapshot?.inspectionSource === "debug-view" || snapshot?.inspectionSource === "debug-hybrid")
    && !inspectionLoading && !debugState?.active && !viewRefreshingNodeId);
  const readSelectedFont = useCallback(() => {
    if (!canReadSelectedFont || !fontApi.readViewFont || !viewLiveRequestId || !selectedNode) return Promise.reject(new Error("当前快照不能读取字体，请重新采集。"));
    // An explicit font read takes priority over this visit's delayed/background pixels.
    inspection.demandImages.invalidate();
    return fontApi.readViewFont(viewLiveRequestId, selectedNode.id);
  }, [canReadSelectedFont, fontApi.readViewFont, viewLiveRequestId, selectedNode, inspection.demandImages.invalidate]);
  const cancelFont = useCallback((requestId: string) => fontApi.cancelViewFont?.(requestId) ?? Promise.resolve(), [fontApi.cancelViewFont]);
  const detailGroupImage = detailNode ? availableGroupImages.find(group => group.nodeId === detailNode.id)?.image ?? null : null;
  const imageActions = useNodeImageActionController({ root: snapshot?.root ?? null, node: detailNode, sessionKey: treeSession, groupImage: detailGroupImage });
  imageMenuCallbacks.current = {
    refreshBlocked: Boolean(debugState?.active),
    imageScopesForNode: node => nodeImageScopeOptions(node, availableGroupImages.find(group => group.nodeId === node.id)?.image ?? null),
    onImageAction: (action, node) => {
      if (!snapshot?.root || inspectionLoading || viewRefreshingNodeId) return;
      setMenuImageRequest({ root: snapshot.root, node, sessionKey: treeSession, key: ++menuImageSequence.current,
        groupImage: availableGroupImages.find(group => group.nodeId === node.id)?.image ?? null, ...layerImageActionDetails(action) });
    },
  };
  useLayoutEffect(() => {
    if (!menuImageRequest) return;
    if (menuImageRequest.root === snapshot?.root && menuImageRequest.node === detailNode && menuImageRequest.sessionKey === treeSession) imageActions.run(menuImageRequest);
    setMenuImageRequest(null);
  }, [menuImageRequest, snapshot?.root, detailNode, treeSession, imageActions.run]);
  const detailRefreshScopes = refreshScopesForNode(detailNode, true);
  const canRefreshDetail = detailRefreshScopes.some(scope => scope.scope === "node" && scope.available);
  const canRefreshDetailBranch = detailRefreshScopes.some(scope => scope.scope === "branch" && scope.available);
  const displayedOrigin = snapshotOrigin?.snapshot.root === snapshot?.root ? snapshotOrigin : null;
  const measurementSnapshot = {
    id: displayedOrigin?.id,
    capturedAt: treeCapturedAt ?? undefined,
    label: displayedOrigin?.label ?? "当前采集快照",
  };
  const detailAttributes = useMemo(
    () => Object.entries(detailNode?.attributes ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    [detailNode],
  );
  const hasTreeFilter = Boolean(treeQuery.trim()) || interactiveOnly || identifiedOnly;
  const workspaceRoot = layerFocus?.kind === "branch" ? layerFocus.node : snapshot?.root ?? null;
  const hasIndependentImageCapture = snapshot?.captureMode !== "fast"
    && ["debug-view", "debug-qml", "debug-hybrid"].includes(snapshot?.inspectionSource ?? "");
  const filteredRoot = useMemo(
    () => workspaceRoot
      ? filterTree(workspaceRoot, { query: treeQuery, interactiveOnly, identifiedOnly })
      : null,
    [identifiedOnly, interactiveOnly, workspaceRoot, treeQuery],
  );
  const selectorData = useMemo(() => snapshot?.root && detailNode
    ? {
        xpath: xpathForNode(snapshot.root, detailNode),
        uiSelector: uiSelectorForNode(detailNode),
        adbTap: adbTapCommand(snapshot.serial, detailNode),
        json: nodeJson(detailNode),
      }
    : null, [snapshot?.root, snapshot?.serial, detailNode]);

  useLayoutEffect(() => {
    copyRequest.current++;
    setCopyStatus(null);
    return () => { copyRequest.current++; };
  }, [detailNode?.id, snapshot?.root, snapshot?.serial]);

  const copyScopeRef = useRef({ node: detailNode, root: snapshot?.root ?? null });
  copyScopeRef.current = { node: detailNode, root: snapshot?.root ?? null };
  const copyValue = useCallback(async (label: string, value: string, scope?: { node: UiSnapshot["root"]; root: UiSnapshot["root"] }) => {
    const eligible = !scope || scope.node === copyScopeRef.current.node && scope.root === copyScopeRef.current.root;
    const request = eligible ? ++copyRequest.current : copyRequest.current;
    if (eligible) setCopyStatus(null);
    const canReport = () => eligible && request === copyRequest.current
      && (!scope || scope.node === copyScopeRef.current.node && scope.root === copyScopeRef.current.root);
    try {
      await window.electronApi.copyText(value);
      if (canReport()) setCopyStatus(`${label} 已复制`);
    } catch {
      if (canReport()) setCopyStatus(`${label} 复制失败`);
    }
  }, []);

  const selectDevice = useCallback((serial: string) => {
    setLivePreviewSerial(null);
    invalidateSnapshotFile();
    void stopMcpSharing("device-change");
    const nextSerial = serial || null;
    setPreferredSerial(nextSerial);
    if (selectedSerial && nextSerial) {
      void inspectDevice(nextSerial);
      return;
    }
    if (selectedSerial && !nextSerial) {
      closeInspector();
    }
  }, [closeInspector, inspectDevice, selectedSerial, stopMcpSharing, invalidateSnapshotFile]);

  const preferredDevice = preferredSerial ? devices.find((device) => device.serial === preferredSerial) ?? null : null;
  const selectedDevice = selectedSerial ? devices.find((device) => device.serial === selectedSerial) ?? null : null;
  const defaultDevice = readyDevices[0] ?? devices[0] ?? null;
  const toolbarDevice = selectedDevice ?? preferredDevice ?? defaultDevice;
  const toolbarSerial = toolbarDevice?.serial ?? selectedSerial ?? preferredSerial ?? "";
  const livePreviewOpen = Boolean(livePreviewSerial && livePreviewSerial === toolbarSerial);
  const windowMode = selectedSerial || preferencesOpen || testReportOpen || connectionDiagnosticsOpen || livePreviewOpen || debugTaskEditorVisibility === "open" ? "workspace" : "home";
  useEffect(() => {
    void window.electronApi.setWindowMode?.(windowMode).catch(() => {});
  }, [windowMode]);
  const previewConnected = Boolean(toolbarDevice?.state === "device" && probe?.adbPath && !probe.error && !runtimeError);
  useEffect(() => {
    if (livePreviewSerial && livePreviewSerial !== toolbarSerial) setLivePreviewSerial(null);
  }, [livePreviewSerial, toolbarSerial]);
  useEffect(() => { if (selectedSerial) setHomeHistoryOpen(false); }, [selectedSerial]);
  const homeState = resolveHomeState({ loading, runtimeError, probe, selectedDevice: toolbarDevice });
  const statusTone = homeStateIsError(homeState) ? "danger" : homeStateIsConnected(homeState) ? "success" : "neutral";
  const captureSerial = homeStateIsConnected(homeState) && toolbarDevice?.state === "device" ? toolbarDevice.serial : null;
  const canSelectDevice = !loading && !inspectionLoading && Boolean(probe?.adbPath && !probe.error && !runtimeError);
  const captureSelected = useCallback(() => {
    if (!captureSerial) return;
    const priorityViewRef = snapshot?.serial === captureSerial ? selectedNode?.attributes?.["view-ref"] ?? null : null;
    void inspectDevice(captureSerial, priorityViewRef);
  }, [captureSerial, inspectDevice, selectedNode, snapshot?.serial]);
  const captureComplete = useCallback(() => {
    if (!captureSerial || inspectionLoading) return;
    const intent = { screenshot: snapshot?.screenshotDataUrl ?? null };
    setPreparing3d(intent);
    const finish = () => setPreparing3d(current => current === intent ? null : current);
    void inspectDevice(captureSerial, null, undefined, "full").then(finish, finish);
  }, [captureSerial, inspectionLoading, snapshot?.screenshotDataUrl, inspectDevice]);
  const startDebugSession = useCallback(() => captureSerial ? startDebug(captureSerial) : Promise.resolve(), [captureSerial, startDebug]);

  const appMenuState = useMemo<AppMenuState>(() => ({
      devices: devices.map(({ serial, model, state }) => ({ serial, model, state })),
      selectedSerial: toolbarSerial, loading, capturing: inspectionLoading,
      inspecting: Boolean(selectedSerial), hasSnapshot: Boolean(snapshot?.root), filtered: hasTreeFilter, mcpSharing,
      canCapture: Boolean(captureSerial), hasRawXml: Boolean(snapshot?.rawXml), hasScreenshot: Boolean(snapshot?.screenshotDataUrl),
      canSelectDevice,
      historyLoading: snapshotsLoading,
      openingSnapshot,
      canFocus: Boolean(selectedNode && snapshot?.captureMode !== "fast"), canHideLayer: Boolean(selectedNode?.visibleToUser && selectedNode.bounds && !hiddenNodeIds.has(selectedNode.id)),
      hasHiddenLayers: hiddenNodeIds.size > 0, hasLayerFocus: Boolean(layerFocus), selectedExpandable: Boolean(selectedNode?.children.length),
      selectedExpanded: Boolean(selectedNode && treeExpandedIds.has(selectedNode.id)), doubleClickAction,
    }), [devices, toolbarSerial, loading, inspectionLoading, selectedSerial, snapshot, hasTreeFilter, mcpSharing, captureSerial, canSelectDevice, snapshotsLoading, openingSnapshot, selectedNode, hiddenNodeIds, layerFocus, treeExpandedIds, doubleClickAction]);

  const { dispatch: dispatchMenuAction, nativeMenu } = useWorkbenchCommands({
    api: menuApi, state: appMenuState, debugActive: Boolean(debugState?.active), debugStarting: mcpBusy,
    onDevice: selectDevice, onDoubleClick: setDoubleClickAction,
    handlers: {
      capture: captureSelected, cancel: cancelInspection, refresh: () => void refreshDevices(), home: closeInspector,
      search: () => { document.querySelector<HTMLInputElement>(".inspection-active .tree-search")?.focus(); },
      save: () => void saveCurrentSnapshot(), "open-snapshot": () => void openSnapshotFile(),
      "export-snapshot": () => void exportCurrentSnapshot("snapshot"), "export-json": () => void exportCurrentSnapshot("json"),
      "export-xml": () => void exportCurrentSnapshot("xml"), "export-png": () => void exportCurrentSnapshot("png"),
      preferences: () => setPreferencesOpen(true), "test-report": () => setTestReportOpen(true),
      history: () => {
        if (!appMenuState.inspecting) { setHomeHistoryOpen(true); return; }
        const history = document.querySelector<HTMLDetailsElement>(".snapshot-drawer:not(.debug-drawer)");
        if (history) { history.open = true; history.querySelector("summary")?.focus(); }
      },
      "mcp-share": () => void shareMcpSnapshot(), "mcp-stop": () => void stopMcpSharing(), "mcp-config": () => void copyMcpConfig(),
      "debug-start": () => void startDebugSession(),
      "expand-all": () => { if (workspaceRoot) handleExpandedChange(current => new Set([...current, ...expandedTreeNodeIds(workspaceRoot)])); },
      "collapse-all": () => setTreeExpandedIds(new Set()),
      "focus-branch": () => handleLayerAction("focus-branch"), "focus-layer": () => handleLayerAction("focus"),
      "exit-focus": () => handleLayerAction("exit-focus"), "expand-selected": () => handleLayerAction("expand"),
      "collapse-selected": () => handleLayerAction("collapse"), "hide-selected": () => handleLayerAction("hide"),
      "restore-layers": () => handleLayerAction("restore"),
    },
  });

  // Stop remains outside collapsed tool menus while automation is authorized.
  const debugStopControl = (debugState?.active || mcpSharing) && <button className="close-button debug-stop" type="button" onClick={() => dispatchMenuAction({ type: "mcp-stop" })}>立即停止</button>;
  const observationControls = <>
    <button type="button" className="close-button" data-command="capture-complete" disabled={!captureSerial || inspectionLoading}
      onClick={captureComplete}>完整采集所有图层</button>
    <button type="button" className="close-button" data-command="debug-task-template" disabled={!debugTaskEditorApi}
      onClick={() => setDebugTaskEditorVisibility("open")}>任务模板</button>
    <button type="button" className="close-button" data-command="connection-diagnosis" disabled={!connectionDiagnosticApi}
      onClick={() => setConnectionDiagnosticsOpen(true)}>连接诊断</button>
    <button type="button" className="close-button" data-command="live-preview" aria-pressed={livePreviewOpen}
      disabled={!captureSerial || !window.electronApi.startLivePreview} onClick={() => setLivePreviewSerial(value => value ? null : toolbarSerial)}>2D 实时预览</button>
  </>;
  const debugControls = window.electronApi.startDebugSession && <>
    <details className="snapshot-drawer debug-drawer" name="home-tools">
      <summary aria-label="自动调试" title={debugState?.active ? debugState.busy ? "AI 调试中…" : "AI 已授权" : mcpSharing ? "MCP 已共享" : "自动调试"}>
        {mcpSharing ? "MCP" : selectedSerial ? "AI" : "自动调试"}<span className="visually-hidden">{debugState?.active ? "自动调试已授权" : mcpSharing ? "MCP 已共享" : "自动调试"}</span>
      </summary>
      <div className="snapshot-drawer-body">
        <strong>{debugState?.active ? debugState.packageName : "自动 UI 调试"}</strong>
        <p>{debugState?.active ? `设备 ${debugState.serial} · ${new Date(debugState.expiresAt).toLocaleTimeString()} 到期` : "只授权指定 Debug App；支持观察、点击、滚动、返回和结果验证。"}</p>
        <DebugSessionProgress state={debugState} onStop={() => dispatchMenuAction({ type: "mcp-stop" })}
          androidLogsEnabled={androidLogsEnabled} onAndroidLogsChange={setAndroidLogsEnabled} disabled={inspectionLoading || mcpBusy} />
        <div className="snapshot-actions">
          <button className="close-button" type="button" disabled={!captureSerial || inspectionLoading || mcpBusy || debugState?.active} onClick={() => dispatchMenuAction({ type: "debug-start" })}>{mcpBusy ? "正在连接…" : "开启自动调试…"}</button>
          <button className="close-button" type="button" onClick={() => dispatchMenuAction({ type: "mcp-config" })}>复制 MCP 配置</button>
          {debugState?.evidencePath && <button className="close-button" type="button" onClick={() => void window.electronApi.openDebugEvidence?.().catch(() => setDebugStatus("打开记录目录失败。"))}>打开失败证据</button>}
          {debugState?.reportPath && <button className="close-button" type="button" onClick={() => { setDebugReportRequest(value => value + 1); setTestReportOpen(true); }}>查看调试记录</button>}
        </div>
        {debugStatus && <p role="status">{debugStatus}</p>}
        {!debugState?.active && debugState?.stopReason && <p role="status">已停止：{debugState.stopReason}</p>}
        <ol className="debug-step-list" aria-label="自动调试操作记录" aria-live="polite">
          {debugState?.steps.slice(-10).reverse().map(step => <li key={step.id} data-status={step.status}>
            <span>#{step.id} · {step.action} · {step.status === "running" ? "执行中" : step.status === "failed" ? "失败" : "完成"}</span>
            <p>{step.message}</p>
          </li>)}
        </ol>
      </div>
    </details>
  </>;

  const homeSnapshot = savedSnapshots.slice().reverse().find(entry => entry.snapshot.serial === toolbarDevice?.serial && entry.snapshot.screenshotDataUrl);
  const homeMenu = !nativeMenu && <details className="home-application-menu" onKeyDown={event => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus();
  }}>
    <summary aria-label="应用菜单"><AppIcon name="more" size={16} /><span>菜单</span></summary>
    <div className="home-application-menu-body">
      {(["open-snapshot", "history", "preferences", "test-report", "debug-start", "mcp-config"] as const).map(type => <button key={type} type="button" data-command={type}
        disabled={!commandEnabled(type, appMenuState, Boolean(debugState?.active), mcpBusy) || type === "open-snapshot" && !window.electronApi.importSnapshotFile || type === "debug-start" && !window.electronApi.startDebugSession}
        title={commandShortcut(type) || undefined} onClick={event => {
          const menu = event.currentTarget.closest("details")!; menu.open = false; menu.querySelector("summary")?.focus();
          dispatchMenuAction({ type });
        }}>{workbenchCommands[type].label}</button>)}
    </div>
  </details>;

  return (
    <div className={`app-shell ${selectedSerial ? "inspection-active" : ""} ${nativeMenu ? "native-menu" : ""}`}>
      <AppHeader
        homeMenu={homeMenu}
        inspectionActive={Boolean(selectedSerial)}
        selectedSerial={selectedSerial}
        devices={devices}
        toolbarSerial={toolbarSerial}
        toolbarDevice={toolbarDevice}
        statusTone={statusTone}
        runtimeError={runtimeError}
        probeError={probe?.error ?? null}
        loading={loading}
        inspectionLoading={inspectionLoading}
        captureSerial={captureSerial}
        canSelectDevice={canSelectDevice}
        onBack={() => dispatchMenuAction({ type: "home" })}
        onSelectDevice={serial => dispatchMenuAction({ type: "device", serial })}
        onRefresh={() => dispatchMenuAction({ type: "refresh" })}
        onCapture={() => dispatchMenuAction({ type: "capture" })}
        onCancel={() => dispatchMenuAction({ type: "cancel" })}
        sceneToolbarRef={setSceneToolbarHost}
        inspectionStage={inspectionStage}
        inspectionElapsed={inspectionElapsed}
      />

      {snapshotFileStatus && <aside className="snapshot-file-status" role={snapshotFileStatus.error ? "alert" : "status"}>
        <span>{snapshotFileStatus.message}</span>
        {!openingSnapshot && <button type="button" className="close-button" aria-label="关闭快照提示" onClick={dismissSnapshotFileStatus}><AppIcon name="close" size={14} /></button>}
      </aside>}
      {inspection.requiresRecapture && <aside className="snapshot-file-status" role="status">
        <span>采集模式已更改，请重新采集。当前快照和图片已保留，实时补图与刷新已暂停。</span>
      </aside>}

      {selectedSerial && sceneToolbarHost ? createPortal(<>{debugStopControl}<details className="workbench-utilities" onKeyDown={event => {
        if (event.key !== "Escape") return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }}>
        <summary aria-label="更多工具" title="偏好设置、快照导出与测试报告"><span>更多工具</span><AppIcon name="chevron" size={12} /></summary>
        <div className="workbench-utilities-body">
          {(["test-report", "preferences", "open-snapshot", "save"] as const).map(type => <button key={type} type="button" className="close-button" data-command={type}
            disabled={!commandEnabled(type, appMenuState, Boolean(debugState?.active), mcpBusy) || type === "open-snapshot" && !window.electronApi.importSnapshotFile} title={commandShortcut(type) || undefined} onClick={event => {
              const menu = event.currentTarget.closest("details")!; menu.open = false; menu.querySelector("summary")?.focus();
              dispatchMenuAction({ type });
            }}>{workbenchCommands[type].label}</button>)}
          <div className="workbench-export-actions" role="group" aria-label="导出快照">
            {(["export-snapshot", "export-json", "export-xml", "export-png"] as const).map(type => <button key={type} type="button" className="close-button" data-command={type}
              disabled={!commandEnabled(type, appMenuState)} title={commandShortcut(type) || undefined} onClick={event => {
                event.currentTarget.closest("details")!.open = false; dispatchMenuAction({ type });
              }}>{workbenchCommands[type].label}</button>)}
          </div>
          {debugControls}
          {observationControls}
        </div>
      </details></>, sceneToolbarHost) : null}
      {!selectedSerial && debugStopControl && <aside className="home-emergency-control" aria-label="自动调试状态">{debugStopControl}</aside>}
      {!selectedSerial && debugStatus && <aside className="home-command-status" role="status">
        <span>{debugStatus}</span><button type="button" className="entry-dialog-close" aria-label="关闭操作提示" onClick={() => setDebugStatus(null)}><AppIcon name="close" size={14} /></button>
      </aside>}
      {homeHistoryOpen && <EntryDialog className="home-history" labelledBy="home-history-title" onClose={() => setHomeHistoryOpen(false)}>
        <div className="entry-dialog-heading">
          <h2 id="home-history-title">快照历史</h2>
          <button className="entry-dialog-close" type="button" aria-label="关闭快照历史" onClick={() => setHomeHistoryOpen(false)} autoFocus><AppIcon name="close" size={14} /></button>
        </div>
        <p>本地快照 · {savedSnapshots.length} 份</p>
        {snapshotsLoading ? <p role="status">正在读取本地快照…</p> : snapshotStoreError ? <p role="alert">{snapshotStoreError}</p>
          : savedSnapshots.length ? <SnapshotHistory entries={savedSnapshots} onSelect={entry => { setHomeHistoryOpen(false); viewSavedSnapshot(entry); }} /> : <p>还没有本地快照。采集后可以保存，之后无需连接设备即可查看。</p>}
      </EntryDialog>}
      <ConnectionDiagnosticsPanel open={connectionDiagnosticsOpen} onClose={() => setConnectionDiagnosticsOpen(false)}
        serial={toolbarSerial || null} packageName={debugState?.active && debugState.serial === toolbarSerial ? debugState.packageName : undefined}
        captureMode={snapshot?.captureMode ?? "deep"} backend={snapshot?.inspectionSource === "accessibility-helper" ? "accessibility-helper" : "uiautomator"}
        api={connectionDiagnosticApi} />
      {livePreviewOpen && <aside className="live-preview-host">
        <LivePreviewPanel serial={livePreviewSerial!} connected={previewConnected}
          enabled={livePreviewOpen} treeCapturedAt={snapshot?.serial === livePreviewSerial ? treeCapturedAt : null} onClose={() => setLivePreviewSerial(null)} />
      </aside>}
      {preferencesOpen && <PreferencesPanel doubleClickAction={doubleClickAction} onChange={setDoubleClickAction}
        inspectionMode={inspectionMode}
        initialSection={preferencesSection} readingPosition={preferencesReading.current} onReadingPositionChange={position => { preferencesReading.current = position; }}
        colorAliases={colorAliases} onSaveColorAliases={saveColorAliases}
        inspectorGroups={inspectorGroups} onSaveInspectorGroups={saveInspectorGroups}
        appearance={appearance} resolvedAppearance={resolvedAppearance} onAppearanceChange={saveAppearance} appearanceSaveError={appearanceSaveError}
        workspaceLayout={workspaceLayout} onResetWorkspaceLayout={resetWorkspaceLayout} workspaceLayoutError={workspaceLayoutError}
        colorFormat={colorFormat} onColorFormatChange={saveColorFormat} colorFormatSaveError={colorFormatSaveError}
        contextHintAcknowledgedCount={contextHints.acknowledgedCount} onResetContextHints={contextHints.resetHints}
        treeCollapsePreference={treeCollapsePreference} onCollapseChange={setTreeCollapsePreference}
        onApplyCollapse={applyTreeCollapsePreference} canApplyCollapse={canApplyTreeCollapse} onClose={() => { setPreferencesOpen(false); setPreferencesSection(undefined); }} />}
      <NodeImageActionOverlay controller={imageActions} />
      {(viewRefreshingNodeId || viewRefreshStatus) && <aside className="node-image-action-feedback view-refresh-feedback" aria-label="控件刷新结果">
        <strong>刷新控件</strong><p role="status">{viewRefreshingNodeId ? "正在刷新，请等待完成…" : viewRefreshStatus?.message}</p>
        {!viewRefreshingNodeId && <button type="button" onClick={dismissViewRefreshStatus}>关闭结果</button>}
      </aside>}
      {debugTaskEditorVisibility !== "unopened" && debugTaskEditorApi && <DebugTaskEditor snapshot={snapshot} selectedNode={selectedNode}
        open={debugTaskEditorVisibility === "open"} state={debugState} api={debugTaskEditorApi}
        onSelectMatch={revealTaskMatch} onClose={() => setDebugTaskEditorVisibility("closed")} />}
      <TestReportPanel open={testReportOpen} onClose={() => setTestReportOpen(false)}
        debugReportRequest={debugReportRequest}
        loadDebugReport={debugState?.reportPath && window.electronApi.loadDebugReport ? () => window.electronApi.loadDebugReport!() : undefined} live={{
        serial: captureSerial, deviceLabel: toolbarDevice?.model || "当前设备",
        supported: Boolean(window.electronApi.runtime.readOnlyDiagnosis),
        blocked: loading || inspectionLoading || Boolean(debugState?.active) || mcpBusy,
        stage: inspectionStage,
        onCapture: (serial, expectedPackage, requestId) => inspectDevice(serial, null, { expectedPackage, requestId }),
        onCancel: requestId => cancelInspection(requestId),
        onViewNode: (next, nodeId) => {
          showLiveSnapshot(next, nodeId);
          if (next.root) setPropertiesRevealRequest({ root: next.root, nodeId });
          setTestReportOpen(false);
        },
      }} />

      <main className="workspace">
        {!snapshot?.root && <DeviceHomeView
          state={homeState}
          device={toolbarDevice}
          devices={devices}
          loading={loading}
          inspectionLoading={inspectionLoading}
          canSelectDevice={canSelectDevice}
          error={runtimeError || probe?.error || null}
          checkedAt={checkedAt}
          preview={homeSnapshot ? { dataUrl: homeSnapshot.snapshot.screenshotDataUrl!, capturedAt: homeSnapshot.capturedAt } : null}
          onDiagnose={connectionDiagnosticApi ? () => setConnectionDiagnosticsOpen(true) : undefined}
          onStart={() => dispatchMenuAction({ type: "capture" })}
          onRefresh={() => dispatchMenuAction({ type: "refresh" })}
          onSelectDevice={serial => dispatchMenuAction({ type: "device", serial })}
        />}
        {selectedSerial && (
          <section className="panel inspector-panel">
            <div className="inspector-heading">
              <div>
                <p className="section-kicker">DEBUG HIERARCHY</p>
                <h3>界面层级</h3>
              </div>
              <div className="inspector-heading-meta">
                <span className="snapshot-summary">{snapshot ? `${snapshot.nodeCount} nodes · ${formatBytes(snapshot.xmlSize)} · ${inspectionSourceLabel(snapshot)}` : "读取中"}</span>
                {inspectionLoading && snapshot?.root && <>
                  <span role="status" title={inspectionStage}>{inspectionStage} · {inspectionElapsed}s</span>
                  <button className="tree-clear" type="button" onClick={() => cancelInspection()}>取消采集</button>
                </>}
                <button className="close-button" type="button" onClick={() => dispatchMenuAction({ type: "home" })}>返回设备</button>
              </div>
            </div>

            <CaptureFailureHistory records={captureFailures.filter(record => record.serial === selectedSerial)} />
            {inspectionLoading && !snapshot?.root ? (
              <div className="inspector-grid inspector-state-grid">
                <div className="tree-pane inspector-state-pane">
                  <div className="workspace-empty-copy">
                    <AppIcon name="refresh" size={24} className="loading-orbit" />
                    <h4 role="status" aria-live="polite">{inspectionStage}</h4>
                    <p>已用时 {inspectionElapsed} 秒 · 完成后自动展开全部控件</p>
                    <button className="tree-clear" type="button" onClick={() => cancelInspection()}>取消采集</button>
                  </div>
                </div>
                <div className="preview-pane inspector-state-pane">
                  <div className="subpanel-heading">
                    <span>设备画面</span>
                    <span className="tree-hint">采集中</span>
                  </div>
                  <div className="workspace-empty-copy">
                    {preparing3d?.screenshot ? <img className="preparing-3d-preview" src={preparing3d.screenshot} alt="上次采集的 2D 截图" />
                      : <AppIcon name="camera" size={36} className="workspace-empty-icon" />}
                    <h4>{preparing3d ? "正在准备 3D 图层" : "等待采集结果"}</h4>
                    <p>{preparing3d ? preparing3d.screenshot ? "暂时显示上次截图，完整图层就绪后进入 3D。" : "正在读取窗口和图层，完整图层就绪后进入 3D。" : "先确认窗口和控件树，再同步设备画面。"}</p>
                  </div>
                </div>
              </div>
            ) : inspectionError || snapshot?.error ? (
              <div className="inspector-grid inspector-state-grid">
                <div className="tree-pane inspector-state-pane">
                  <CaptureFailureFeedback snapshot={snapshot} error={inspectionError || snapshot?.error || "读取失败"}
                    onRetry={() => { if (!inspectionLoading && selectedSerial && readyDevices.some(device => device.serial === selectedSerial)) void inspectDevice(selectedSerial); }}
                    canRetry={!inspectionLoading && readyDevices.some(device => device.serial === selectedSerial)} />
                </div>
                <div className="preview-pane inspector-state-pane">
                  <div className="subpanel-heading">
                    <span>设备画面</span>
                    <span className="tree-hint">未采集</span>
                  </div>
                  <div className="workspace-empty-copy">
                    <AppIcon name="image" size={36} className="workspace-empty-icon" />
                    <h4>暂无截图结果</h4>
                    <p>本次检查未生成可用截图，右侧会在下一次采集后显示设备画面。</p>
                  </div>
                </div>
              </div>
            ) : snapshot?.root ? (
              <NodeHoverProvider root={workspaceRoot} sessionKey={`${treeSession}:${layerFocus?.kind ?? "all"}:${layerFocus?.node.id ?? ""}`}>
                {snapshot.warning && !warningDismissed && <div className="snapshot-warning">
                  <span className="snapshot-warning-message" role="status">{snapshot.warning}</span>
                  <button className="snapshot-warning-dismiss" type="button" aria-label="关闭采集提示" title="关闭提示" onClick={() => {
                    setWarningDismissed(true);
                    document.querySelector<HTMLInputElement>(".tree-search")?.focus();
                  }}><AppIcon name="close" size={14} /></button>
                </div>}
                <div className="inspector-grid is-resizable">
                  <div className="tree-pane" id="hierarchy-pane" aria-label="层级树">
                    {layerFocus && <div className="tree-focus-bar" role="status">
                      <span title={nodeDisplayLabel(layerFocus.node)}>{layerFocus.kind === "branch" ? "聚焦分支" : "仅看此层"} · {nodeDisplayLabel(layerFocus.node)}</span>
                      <button className="tree-focus-exit tree-clear" type="button" aria-label="退出聚焦" title="退出聚焦，恢复原视图（Esc）" onClick={() => handleLayerAction("exit-focus")}>退出</button>
                    </div>}
                    <UiTree
                      key={treeSession}
                      root={workspaceRoot!}
                      filteredRoot={filteredRoot}
                      selectedId={selectedNode?.id ?? snapshot.root.id}
                      expanded={treeExpandedIds}
                      componentClasses={treeCollapsePreference.classes}
                      expansionDisabled={inspectionLoading || Boolean(viewRefreshingNodeId)}
                      hiddenNodeIds={hiddenNodeIds}
                      inspectionSource={snapshot.inspectionSource}
                      captureMode={snapshot.captureMode}
                      imageCapturePending={inspectionLoading && hasIndependentImageCapture}
                      filterActive={hasTreeFilter}
                      filterKey={JSON.stringify([treeQuery, interactiveOnly, identifiedOnly])}
                      filter={{ query: treeQuery, interactiveOnly, identifiedOnly }}
                      revealRequest={treeRevealRequest}
                      restoreRequest={treeRestoreRequest}
                      focusKey={layerFocus ? `${layerFocus.kind}:${layerFocus.node.attributes?.["view-ref"] ?? layerFocus.node.id}` : null}
                      doubleClickAction={doubleClickAction}
                      onDoubleClick={handleNodeDoubleClick}
                      onContextMenu={node => void openLayerMenu(node, (label, value) => copyValue(label, value, { node, root: snapshot?.root ?? null }))}
                      onExpandedChange={handleExpandedChange}
                      onSelect={setSelectedNode}
                      onClearFilter={clearTreeFilter}
                      history={nodeHistory} historyView={nodeHistoryView}
                      viewingScope={viewingScope} searchNavigation={treeSearchNavigation}
                    />
                    <div className="tree-tools">
                      <div className="tree-search-row">
                        <TreeSearchInput
                          root={workspaceRoot ?? snapshot.root}
                          snapshotKey={treeSession}
                          value={treeQuery}
                          onChange={setTreeQuery}
                          onClear={clearTreeFilter}
                          hasFilter={hasTreeFilter}
                          searchNavigation={treeSearchNavigation}
                        />
                        {hasTreeFilter && <button className="tree-clear tree-clear-inline" type="button" onClick={clearTreeFilter}>清除筛选</button>}
                        <details className="tree-filter-details">
                          <summary>筛选</summary>
                          <div className="tree-filter-row">
                            <label><input type="checkbox" checked={interactiveOnly} onChange={(event) => setInteractiveOnly(event.target.checked)} /> 可操作</label>
                            <label><input type="checkbox" checked={identifiedOnly} onChange={(event) => setIdentifiedOnly(event.target.checked)} /> 有标识</label>
                          </div>
                        </details>
                        <details className="tree-interaction-settings" onKeyDown={event => {
                          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
                        }}>
                          <summary aria-label="树交互设置" title="双击行为与默认折叠">
                            <AppIcon name="settings" size={18} />
                          </summary>
                          <div className="tree-interaction-settings-body">
                            <label>双击行为<select aria-label="双击行为" value={doubleClickAction} onChange={event => setDoubleClickAction(event.target.value as typeof doubleClickAction)}>
                              {doubleClickChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                            </select></label>
                            <p>树与画布使用同一设置。筛选期间保留原折叠状态。</p>
                            <button className="tree-clear" type="button" onClick={event => {
                              const details = event.currentTarget.closest("details"); if (details) details.open = false;
                              setPreferencesOpen(true);
                            }}>默认折叠设置…</button>
                          </div>
                        </details>
                      </div>
                    </div>
                  </div>

                  <TreePaneResizer width={workspaceLayout.treeWidth} onWidthChange={saveTreeWidth} />

                  <div className="preview-pane">
                    <div className="subpanel-heading">
                      <span>设备画面</span>
                      <span className="tree-hint">{selectedSerial}</span>
                    </div>
                    {snapshot.layerCapture === "on-demand" && <div className="demand-layer-status" aria-label="按需图层读取">
                      <span role="status">{inspection.demandImages.message ?? (inspection.demandImages.available
                        ? "2D 预览已就绪；切换 3D 时会自动读取完整图层。"
                        : inspectionLoading ? "先读取截图与控件树…" : "此快照仅保存已读取的图层；重新采集可继续按需读取。")}</span>
                      <button className="close-button" type="button" disabled={!inspection.demandImages.available || inspection.demandImages.loading || !selectedNode || Boolean(viewRefreshingNodeId)}
                        onClick={() => { if (selectedNode) inspection.demandImages.request(selectedNode.id, true); }}>
                        {inspection.demandImages.loading ? "读取中…" : inspection.demandImages.failed ? "重试当前分支" : "读取当前分支"}
                      </button>
                      <button className="close-button" type="button" disabled={!captureSerial || inspectionLoading} onClick={captureComplete}>完整采集</button>
                    </div>}
                    {sceneToolbarHost && createPortal(<details className="snapshot-drawer">
                      <summary aria-label="快照与历史" title={`快照与历史 · ${savedSnapshots.length} 份`}>
                        <AppIcon name="history" size={18} /><span>快照历史</span>
                      </summary>
                      <div className="snapshot-drawer-body">
                        <div className="snapshot-toolbar">
                          <div className="snapshot-toolbar-info">
                            <span>本地快照：{savedSnapshots.length} 份</span>
                            {snapshotsLoading && <span className="tree-hint">正在读取本地记录…</span>}
                            {latestDiff ? (
                              <>
                                <span className="snapshot-diff">较上一份：{diffSummary(latestDiff)}</span>
                                <button className="diff-toggle" type="button" onClick={() => setDiffExpanded((value) => !value)}>
                                  {diffExpanded ? "收起明细" : "查看明细"}
                                </button>
                              </>
                            ) : !snapshotsLoading && <span className="tree-hint">保存后可比较下一次刷新</span>}
                            {snapshotStatus && <span className="snapshot-status">{snapshotStatus}</span>}
                            {diffExportStatus && <span className="snapshot-export-status">{diffExportStatus}</span>}
                            {snapshotStoreError && <span className="snapshot-store-error">{snapshotStoreError}</span>}
                          </div>
                          <div className="snapshot-actions">
                            {window.electronApi.shareMcpSnapshot && <>
                              <button className="close-button" type="button" onClick={() => dispatchMenuAction({ type: "mcp-share" })} disabled={inspectionLoading || mcpBusy || debugState?.active}>共享当前快照给 MCP</button>
                              <button className="close-button" type="button" onClick={() => dispatchMenuAction({ type: "mcp-stop" })} disabled={!mcpSharing}>停止 MCP 共享</button>
                              <button className="close-button" type="button" onClick={() => dispatchMenuAction({ type: "mcp-config" })}>复制 MCP 配置</button>
                            </>}
                            <button className="close-button" type="button" onClick={() => dispatchMenuAction({ type: "save" })} disabled={inspectionLoading || snapshotsLoading}>保存快照</button>
                            <button className="close-button" type="button" onClick={() => void clearSavedSnapshots()} disabled={snapshotsLoading || (savedSnapshots.length === 0 && !snapshotStoreError)}>清空记录</button>
                          </div>
                        </div>
                        {savedSnapshots.length > 0 && (
                          <SnapshotHistory entries={savedSnapshots} onSelect={viewSavedSnapshot} />
                        )}
                        {latestDiff && diffExpanded && (
                          <SnapshotDiffDetails diff={latestDiff} onExport={exportLatestDiff} />
                        )}
                      </div>
                    </details>, sceneToolbarHost)}
                      <ScreenshotPreview sessionKey={treeSession} src={snapshot.screenshotDataUrl ?? ""} root={snapshot.root} capturePending={inspectionLoading} preferFlat={snapshot.layerCapture === "on-demand"}
                        preparing3d={Boolean(preparing3d && inspectionLoading)}
                        preparingScreenshot={preparing3d?.screenshot} enter3dWhenReady={snapshot.layerCapture === "full"}
                        onPrepare3d={inspection.demandImages.available && snapshot.serial === captureSerial ? captureComplete : undefined}
                        toolsSuspended={preferencesOpen || Boolean(imageActions.preview) || connectionDiagnosticsOpen || testReportOpen || debugTaskEditorVisibility === "open"}
                        selectedNode={selectedNode} expandedNodeIds={treeExpandedIds} geometry={snapshot.captureGeometry} layersAvailable={snapshot.captureMode !== "fast"} onSelect={handleScreenshotSelect}
                        layerFocus={layerFocus} hiddenNodeIds={hiddenNodeIds} doubleClickAction={doubleClickAction} onDoubleClick={handleNodeDoubleClick}
                        onLayerAction={handleLayerAction} onOpenLayerMenu={(node, mode?: LayerMenuMode) => void openLayerMenu(node, (label, value) => copyValue(label, value, { node, root: snapshot?.root ?? null }), mode)}
                        savedGroupImages={snapshot.layerGroupImages}
                        cachedGroupImages={groupRequestId ? undefined : availableGroupImages}
                        measurementSnapshot={measurementSnapshot}
                        onNavigateNode={navigateToNode} navigationDisabled={inspectionLoading || Boolean(viewRefreshingNodeId)}
                        contextHints={contextHints}
                        onCaptureGroup={groupRequestId ? requestGroup : undefined} />
                    {layerMenuError && <p className="screenshot-status mismatch" role="alert">{layerMenuError}</p>}
                    {detailNode && (
                      <NodePropertiesPanel
                        root={snapshot.root}
                        node={detailNode}
                        hiddenByUser={hiddenNodeIds.has(detailNode.id)}
                        inspectionSource={snapshot.inspectionSource}
                        captureMode={snapshot.captureMode}
                        imageCapturePending={hasIndependentImageCapture && (inspectionLoading || viewRefreshingNodeId === detailNode.id)}
                        onNavigateNode={navigateToNode}
                        navigationDisabled={inspectionLoading || Boolean(viewRefreshingNodeId)}
                        imageSessionKey={treeSession}
                        imageController={imageActions}
                        groupImage={detailGroupImage}
                        colorAliases={colorAliases}
                        inspectorGroups={inspectorGroups}
                        onSaveInspectorGroups={saveInspectorGroups}
                        historyView={nodeHistoryView}
                        colorFormat={colorFormat} onColorFormatChange={saveColorFormat} colorFormatSaveError={colorFormatSaveError}
                        referenceSnapshot={measurementSnapshot}
                        inspectorLayout={workspaceLayout.inspector} onInspectorLayoutChange={saveInspectorLayout}
                        onOpenGroupPreferences={() => { setPreferencesSection("properties"); setPreferencesOpen(true); }}
                        revealRequest={propertiesRevealRequest}
                        screenshotSize={snapshot.captureGeometry?.screenshotSize ?? null}
                        toolbarHost={sceneToolbarHost}
                        docked
                        onCopy={() => void copyValue("节点 JSON", selectorData?.json ?? nodeJson(detailNode))}
                        onCopyValue={(label, value) => {
                          if (copyScopeRef.current.node === detailNode && copyScopeRef.current.root === snapshot.root)
                            void copyValue(label, value, { node: detailNode, root: snapshot.root });
                        }}
                        copyStatus={copyStatus}
                        onRefresh={canRefreshDetail ? () => void refreshViewNode(detailNode) : undefined}
                        onRefreshBranch={canRefreshDetailBranch ? () => void refreshViewNode(detailNode, "branch") : undefined}
                        onRefreshList={canRefreshDetail && (snapshot.inspectionSource === "debug-view" || snapshot.inspectionSource === "debug-hybrid") && (/(RecyclerView|AbsListView|ListView|GridView|ViewPager)$/.test(detailNode.className ?? "") || detailNode.children.length >= 12) ? () => void refreshViewNode(detailNode, "list") : undefined}
                        onReadStyle={snapshot.inspectionSource === "debug-hybrid" && snapshot.root.attributes?.["sdk-style-version"] === "1" && viewLiveRequestId && detailNode.attributes?.["view-ref"] && !inspectionLoading && !debugState?.active ? () => window.electronApi.readViewStyle(viewLiveRequestId, detailNode.id) : undefined}
                        onReadFont={canReadSelectedFont ? readSelectedFont : undefined}
                        onCancelFont={cancelFont} fontSessionKey={viewLiveRequestId}
                        refreshBusy={viewRefreshingNodeId !== null}
                        refreshStatus={viewRefreshStatus?.nodeId === detailNode.id ? viewRefreshStatus.message : null}
                      >
                        {detailAttributes.length > 0 ? (
                          <section className="node-attributes" aria-label="全部调试属性">
                            <h6>全部调试属性 · {detailAttributes.length}</h6>
                            <dl className="node-attributes-list">
                              {detailAttributes.map(([name, value]) => (
                                <div key={name}>
                                  <dt>{name}</dt>
                                  <dd title={value}><LongTextValue value={value || "∅"} label={name} onCopyValue={value ? copyValue : undefined} /></dd>
                                </div>
                              ))}
                            </dl>
                          </section>
                    ) : (
                          <p className="node-attributes-empty">当前快照没有保存原始 XML 属性；重新刷新 UI 可获取完整属性。</p>
                        )}
                        {selectorData && (
                          <div className="selector-panel">
                            <div className="selector-panel-heading">
                              <span>定位器与操作</span>
                              {copyStatus && <span className="selector-status">{copyStatus}</span>}
                            </div>
                            <div className="selector-row">
                              <code title={selectorData.xpath}>{selectorData.xpath}</code>
                              <button className="selector-copy" type="button" onClick={() => void copyValue("XPath", selectorData.xpath)}>复制 XPath</button>
                            </div>
                            <div className="selector-row">
                              <code title={selectorData.uiSelector}>{selectorData.uiSelector}</code>
                              <button className="selector-copy" type="button" onClick={() => void copyValue("UiSelector", selectorData.uiSelector)}>复制 UiSelector</button>
                            </div>
                            <div className="selector-row">
                              <code title={selectorData.adbTap}>{selectorData.adbTap}</code>
                              <button className="selector-copy" type="button" onClick={() => void copyValue("ADB 命令", selectorData.adbTap)} disabled={!detailNode.bounds}>复制 ADB</button>
                            </div>
                            <div className="selector-actions">
                              <button type="button" onClick={() => void copyValue("节点 JSON", selectorData.json)}>复制节点 JSON</button>
                              <button type="button" onClick={() => dispatchMenuAction({ type: "export-snapshot" })} disabled={inspectionLoading}>导出完整快照</button>
                              <button type="button" onClick={() => dispatchMenuAction({ type: "export-json" })} disabled={inspectionLoading}>导出 JSON</button>
                              <button type="button" onClick={() => dispatchMenuAction({ type: "export-xml" })} disabled={inspectionLoading || !snapshot.rawXml}>导出 XML</button>
                              <button type="button" onClick={() => dispatchMenuAction({ type: "export-png" })} disabled={inspectionLoading || !snapshot.screenshotDataUrl}>导出 PNG</button>
                            </div>
                            {exportStatus && <p className="export-status">{exportStatus}</p>}
                          </div>
                        )}
                      </NodePropertiesPanel>
                    )}
                  </div>
                </div>
              </NodeHoverProvider>
            ) : (
              <div className="inspector-grid inspector-empty-grid">
                <div className="tree-pane empty-tree-pane">
                  <div className="workspace-empty-copy">
                    <AppIcon name="hierarchy" size={36} className="workspace-empty-icon" />
                    <h4>{captureSerial ? "准备采集当前页面" : "请选择已授权设备"}</h4>
                    <p>{captureSerial ? "点击顶部采集按钮，读取 Debug 控件树和设备画面。" : "顶部选择已授权的 Android 设备后，再开始采集。"}</p>
                  </div>
                </div>
                <div className="preview-pane empty-preview-pane">
                  <div className="subpanel-heading">
                    <span>设备截图</span>
                    <span className="tree-hint">未采集</span>
                  </div>
                  <div className="workspace-empty-copy">
                    <AppIcon name="camera" size={36} className="workspace-empty-icon" />
                    <h4>{captureSerial ? "等待截图结果" : "连接设备后开始"}</h4>
                    <p>{captureSerial ? "截图和树状结构会在这里同步显示。" : "请先连接并授权 Android 设备。"}</p>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="app-footer">
        <span>ANDROID UI INSPECTOR / LOCAL-FIRST</span>
        <span>仅支持 Debug App</span>
      </footer>
    </div>
  );
}

export default App;
