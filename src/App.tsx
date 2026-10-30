import { useInspectionWorkspace, expandedTreeNodeIds } from "./features/inspection/useInspectionWorkspace";
import { useColorAliases } from "./features/inspection/useColorAliases";
import { useInspectorGroups } from "./features/inspection/useInspectorGroups";
import { useContextHints } from "./features/inspection/useContextHints";
import { NodeHoverProvider } from "./features/inspection/NodeHoverContext";
import { useDebugSession } from "./features/automation/useDebugSession";
import { DebugSessionProgress } from "./features/automation/DebugSessionProgress";
import { DebugTaskEditor, type DebugTaskEditorApi } from "./features/automation/DebugTaskEditor";
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
import "./styles/artemis-tools.css";
import type { AdbProbeResult, AppMenuAction, AppMenuState, ExportFormat, UiSnapshot } from "../shared/types";
import { serializeSnapshotFile } from "../shared/snapshot-file";
import { commandEnabled, commandForShortcut, commandShortcut, doubleClickChoices, workbenchCommands } from "../shared/workbench-commands";
import { homeStateIsConnected, homeStateIsError, resolveHomeState } from "../shared/device-state";
import { filterTree, nodeDisplayLabel } from "../shared/tree-utils";
import { AppHeader } from "./components/AppHeader";
import { UiTree } from "./components/UiTree";
import { ScreenshotPreview } from "./components/ScreenshotPreview";
import { NodePropertiesPanel, type NodePropertiesRevealRequest } from "./components/NodePropertiesPanel";
import { LongTextValue } from "./components/LongTextValue";
import { DeviceHomeView } from "./components/DeviceHomeView";
import { PreferencesPanel } from "./components/PreferencesPanel";
import { TreePaneResizer } from "./components/TreePaneResizer";
import { CaptureFailureFeedback, CaptureFailureHistory } from "./components/CaptureFailureFeedback";
import { type SavedSnapshot, type SnapshotDiff, addSnapshotDiffs, diffSummary } from "./features/history/model";
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
  const inspection = useInspectionWorkspace();
  const { colorAliases, saveColorAliases } = useColorAliases();
  const { inspectorGroups, saveInspectorGroups } = useInspectorGroups();
  const {
    selectedSerial, preferredSerial, setPreferredSerial, snapshot, treeCapturedAt, selectedNode, setSelectedNode,
    inspectionLoading, inspectionStage, inspectionElapsed, inspectionError, captureFailures,
    warningDismissed, setWarningDismissed, treeQuery, setTreeQuery, interactiveOnly, setInteractiveOnly,
    identifiedOnly, setIdentifiedOnly, treeSession, treeExpandedIds, setTreeExpandedIds, treeRevealRequest,
    viewLiveRequestId, viewRefreshingNodeId, viewRefreshStatus, groupRequestId, requestGroup, refreshViewNode, snapshotForStorage, availableGroupImages,
    cancelInspection, clearInspection, showSnapshot, clearTreeFilter, handleExpandedChange,
    handleScreenshotSelect, navigateToNode, layerFocus, hiddenNodeIds, layerMenuError, treeRestoreRequest,
    doubleClickAction, setDoubleClickAction, handleNodeDoubleClick, handleLayerAction, openLayerMenu,
    treeCollapsePreference, setTreeCollapsePreference, applyTreeCollapsePreference, canApplyTreeCollapse,
  } = inspection;
  const contextHints = useContextHints(treeSession, inspectionLoading || Boolean(viewRefreshingNodeId));
  const [probe, setProbe] = useState<AdbProbeResult | null>(null);
  const probeRequest = useRef(0);
  const probePending = useRef(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  // The first render happens before the probe effect runs. Start in loading so
  // the home state never flashes an error while the bridge is being queried.
  const [loading, setLoading] = useState(true);
  const [nativeMenu, setNativeMenu] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const copyRequest = useRef(0);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [sceneToolbarHost, setSceneToolbarHost] = useState<HTMLDivElement | null>(null);
  const [savedSnapshots, setSavedSnapshots] = useState<SavedSnapshot[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(true);
  const [snapshotStoreError, setSnapshotStoreError] = useState<string | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState<string | null>(null);
  const [diffExportStatus, setDiffExportStatus] = useState<string | null>(null);
  const [latestDiff, setLatestDiff] = useState<SnapshotDiff | null>(null);
  const [diffExpanded, setDiffExpanded] = useState(false);
  const [testReportOpen, setTestReportOpen] = useState(false);
  const [debugReportRequest, setDebugReportRequest] = useState(0);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [connectionDiagnosticsOpen, setConnectionDiagnosticsOpen] = useState(false);
  const [debugTaskEditorOpen, setDebugTaskEditorOpen] = useState(false);
  const [livePreviewSerial, setLivePreviewSerial] = useState<string | null>(null);
  const connectionDiagnosticApi = useMemo(() => window.electronApi.diagnoseConnection && window.electronApi.cancelConnectionDiagnosis
    ? { diagnoseConnection: window.electronApi.diagnoseConnection, cancelConnectionDiagnosis: window.electronApi.cancelConnectionDiagnosis } : undefined, []);
  const debugTaskEditorApi = useMemo<DebugTaskEditorApi | undefined>(() => {
    const api = window.electronApi;
    return api.loadDebugTaskTemplates && api.saveDebugTaskTemplate && api.deleteDebugTaskTemplate && api.defineDebugTask && api.checkDebugTask
      ? { loadDebugTaskTemplates: api.loadDebugTaskTemplates, saveDebugTaskTemplate: api.saveDebugTaskTemplate,
        deleteDebugTaskTemplate: api.deleteDebugTaskTemplate, defineDebugTask: api.defineDebugTask, checkDebugTask: api.checkDebugTask } : undefined;
  }, []);
  const [propertiesRevealRequest, setPropertiesRevealRequest] = useState<NodePropertiesRevealRequest | null>(null);
  const [openingSnapshot, setOpeningSnapshot] = useState(false);
  const [snapshotFileStatus, setSnapshotFileStatus] = useState<{ message: string; error?: boolean } | null>(null);
  const snapshotFileRequest = useRef(0);
  const snapshotFilePending = useRef(false);
  const fullExportPending = useRef(false);
  const snapshotFileMounted = useRef(true);
  useEffect(() => {
    snapshotFileMounted.current = true;
    return () => { snapshotFileMounted.current = false; snapshotFileRequest.current++; };
  }, []);
  const invalidateSnapshotFile = useCallback(() => {
    snapshotFileRequest.current++;
    setSnapshotFileStatus(null);
  }, []);
  const showLiveSnapshot = useCallback((next: UiSnapshot, selectedNodeId?: string | null) => {
    invalidateSnapshotFile();
    showSnapshot(next, selectedNodeId, new Date().toISOString());
    setLatestDiff(null);
    setSnapshotStatus(null);
    setCopyStatus(null);
    setExportStatus(null);
  }, [showSnapshot, invalidateSnapshotFile]);
  const { mcpSharing, mcpBusy, debugState, debugStatus, setDebugStatus,
    stopMcpSharing, shareMcpSnapshot, copyMcpConfig, androidLogsEnabled, setAndroidLogsEnabled, startDebugSession: startDebug } = useDebugSession({
      snapshot, selectedNode, inspectionLoading, showSnapshot: showLiveSnapshot,
    });

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

  const inspectDevice = useCallback((serial: string, priorityViewRef?: string | null, diagnostic?: { expectedPackage: string; requestId: string }) => {
    invalidateSnapshotFile();
    setCopyStatus(null);
    setExportStatus(null);
    setSnapshotStatus(null);
    setLatestDiff(null);
    setDiffExpanded(false);
    return inspection.inspectDevice(serial, priorityViewRef, diagnostic);
  }, [inspection.inspectDevice, invalidateSnapshotFile]);

  const closeInspector = useCallback(() => {
    setLivePreviewSerial(null);
    invalidateSnapshotFile();
    clearInspection();
    void stopMcpSharing("home");
    setCopyStatus(null);
    setExportStatus(null);
    setSnapshotStatus(null);
    setLatestDiff(null);
    setDiffExpanded(false);
  }, [clearInspection, stopMcpSharing, invalidateSnapshotFile]);

  useEffect(() => {
    void refreshDevices();
    return () => { probeRequest.current++; probePending.current = false; };
  }, [refreshDevices]);

  useEffect(() => {
    let active = true;
    async function restoreSnapshots() {
      setSnapshotsLoading(true);
      try {
        const result = await window.electronApi.loadSnapshots();
        if (!active) return;
        setSnapshotStoreError(result.error);
        setSavedSnapshots(result.error ? [] : addSnapshotDiffs(result.snapshots));
      } catch {
        if (active) {
          setSnapshotStoreError("读取本地快照失败");
          setSavedSnapshots([]);
        }
      } finally {
        if (active) setSnapshotsLoading(false);
      }
    }

    void restoreSnapshots();
    return () => {
      active = false;
    };
  }, []);

  const devices = probe?.devices ?? [];
  const readyDevices = useMemo(
    () => devices.filter((device) => device.state === "device"),
    [devices],
  );
  const detailNode = selectedNode ?? snapshot?.root ?? null;
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

  const exportCurrentSnapshot = useCallback(async (format: ExportFormat) => {
    if (!snapshot || format === "snapshot" && (fullExportPending.current || snapshotFilePending.current)) return;
    const request = format === "snapshot" ? ++snapshotFileRequest.current : null;
    if (request !== null) fullExportPending.current = true;
    const status = (message: string | null, error = false) => {
      setExportStatus(message);
      if (request !== null && request === snapshotFileRequest.current) setSnapshotFileStatus(message ? { message, error } : null);
    };
    status("正在准备导出…");
    try {
      const data = format === "snapshot"
        ? serializeSnapshotFile(snapshotForStorage() ?? snapshot)
        : format === "json" ? JSON.stringify({ serial: snapshot.serial, nodeCount: snapshot.nodeCount, xmlSize: snapshot.xmlSize, root: snapshot.root }, null, 2)
          : format === "xml" ? snapshot.rawXml ?? "" : snapshot.screenshotDataUrl ?? "";
      if (!data) { status(`当前没有可导出的 ${format.toUpperCase()} 内容`, true); return; }
      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      const result = await window.electronApi.exportSnapshot({
        format,
        data,
        defaultFileName: `android-ui-inspector-${format === "snapshot" ? "snapshot-" : ""}${stamp}.${format === "snapshot" ? "json" : format}`,
      });
      if (result.canceled) {
        status(null);
      } else if (result.error) {
        status(result.error, true);
      } else {
        status(`已保存：${result.filePath}`);
      }
    } catch (error) {
      status(error instanceof Error ? error.message : "导出失败，请重试", true);
    } finally { if (request !== null) fullExportPending.current = false; }
  }, [snapshot, snapshotForStorage]);

  const exportLatestDiff = useCallback(async () => {
    if (!latestDiff || !snapshot) return;

    setDiffExportStatus("正在准备差异导出…");
    try {
      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      const result = await window.electronApi.exportSnapshot({
        format: "json",
        data: JSON.stringify({
          exportedAt: new Date().toISOString(),
          serial: snapshot.serial,
          currentNodeCount: snapshot.nodeCount,
          diff: latestDiff,
        }, null, 2),
        defaultFileName: `android-ui-inspector-diff-${stamp}.json`,
      });
      if (result.canceled) {
        setDiffExportStatus(null);
      } else if (result.error) {
        setDiffExportStatus(result.error);
      } else {
        setDiffExportStatus(`差异已保存：${result.filePath}`);
      }
    } catch {
      setDiffExportStatus("差异导出失败，请重试");
    }
  }, [latestDiff, snapshot]);

  const saveCurrentSnapshot = useCallback(async () => {
    if (!snapshot?.root) {
      setSnapshotStatus("当前没有可保存的 UI 快照");
      return;
    }

    setSnapshotStatus("正在保存本地快照…");
    try {
      const result = await window.electronApi.saveSnapshot({
        capturedAt: new Date().toISOString(),
        snapshot: snapshotForStorage() ?? snapshot,
      });
      if (result.error) {
        setSnapshotStoreError(result.error);
        setSnapshotStatus(result.error);
        return;
      }

      const records = addSnapshotDiffs(result.snapshots);
      const newest = records[records.length - 1];
      setSavedSnapshots(records);
      setSnapshotStoreError(null);
      setLatestDiff(newest?.diff ?? null);
      setDiffExpanded(false);
      setSnapshotStatus(newest ? `已保存本地快照 ${newest.id.slice(0, 8)}` : "已保存本地快照");
    } catch {
      setSnapshotStoreError("保存本地快照失败");
      setSnapshotStatus("保存本地快照失败");
    }
  }, [snapshot, snapshotForStorage]);

  const clearSavedSnapshots = useCallback(async () => {
    setSnapshotStatus("正在清空本地快照…");
    try {
      const result = await window.electronApi.clearSnapshots();
      if (result.error) {
        setSnapshotStoreError(result.error);
        setSnapshotStatus(result.error);
        return;
      }
      setSavedSnapshots([]);
      setSnapshotStoreError(null);
      setLatestDiff(null);
      setDiffExpanded(false);
      setSnapshotStatus("已清空本地快照");
    } catch {
      setSnapshotStoreError("清空本地快照失败");
      setSnapshotStatus("清空本地快照失败");
    }
  }, []);

  const viewSavedSnapshot = useCallback((entry: SavedSnapshot) => {
    setLivePreviewSerial(null);
    invalidateSnapshotFile();
    void stopMcpSharing("history");
    showSnapshot(entry.snapshot);
    setCopyStatus(null);
    setExportStatus(null);
    setDiffExportStatus(null);
    setLatestDiff(entry.diff);
    setDiffExpanded(false);
    setSnapshotStatus(`正在查看历史快照 ${entry.id.slice(0, 8)}`);
  }, [stopMcpSharing, showSnapshot, invalidateSnapshotFile]);

  const openSnapshotFile = useCallback(async () => {
    if (snapshotFilePending.current || !window.electronApi.importSnapshotFile) return;
    snapshotFilePending.current = true;
    const request = ++snapshotFileRequest.current;
    setOpeningSnapshot(true);
    setSnapshotFileStatus({ message: "正在打开快照…请完成文件选择；如有系统权限提示，请先确认。" });
    try {
      const result = await window.electronApi.importSnapshotFile();
      if (request !== snapshotFileRequest.current) return;
      if (result.canceled) { setSnapshotFileStatus(null); return; }
      if (result.error || !result.data) throw new Error(result.error || "快照文件没有可查看的内容。");
      setLivePreviewSerial(null);
      await stopMcpSharing("history");
      if (request !== snapshotFileRequest.current) return;
      showSnapshot(result.data.snapshot);
      setLatestDiff(null); setDiffExpanded(false); setCopyStatus(null); setExportStatus(null); setDiffExportStatus(null);
      const name = result.filePath?.split(/[\\/]/).pop() || "快照文件";
      const message = result.data.legacy ? `已打开旧版控件树 · ${name}；文件未保存整屏截图。` : `正在查看离线快照 · ${name}`;
      setSnapshotStatus(message);
      setSnapshotFileStatus({ message });
    } catch (error) {
      if (request === snapshotFileRequest.current) setSnapshotFileStatus({ message: error instanceof Error ? error.message : "快照文件无法打开。", error: true });
    } finally {
      snapshotFilePending.current = false;
      if (snapshotFileMounted.current) setOpeningSnapshot(false);
    }
  }, [showSnapshot, stopMcpSharing]);

  const selectDevice = useCallback((serial: string) => {
    setLivePreviewSerial(null);
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
  }, [closeInspector, inspectDevice, selectedSerial, stopMcpSharing]);

  const preferredDevice = preferredSerial ? devices.find((device) => device.serial === preferredSerial) ?? null : null;
  const selectedDevice = selectedSerial ? devices.find((device) => device.serial === selectedSerial) ?? null : null;
  const defaultDevice = readyDevices[0] ?? devices[0] ?? null;
  const toolbarDevice = selectedDevice ?? preferredDevice ?? defaultDevice;
  const toolbarSerial = toolbarDevice?.serial ?? selectedSerial ?? preferredSerial ?? "";
  const livePreviewOpen = Boolean(livePreviewSerial && livePreviewSerial === toolbarSerial);
  const previewConnected = Boolean(toolbarDevice?.state === "device" && probe?.adbPath && !probe.error && !runtimeError);
  useEffect(() => {
    if (livePreviewSerial && livePreviewSerial !== toolbarSerial) setLivePreviewSerial(null);
  }, [livePreviewSerial, toolbarSerial]);
  const homeState = resolveHomeState({ loading, runtimeError, probe, selectedDevice: toolbarDevice });
  const statusTone = homeStateIsError(homeState) ? "danger" : homeStateIsConnected(homeState) ? "success" : "neutral";
  const captureSerial = homeStateIsConnected(homeState) && toolbarDevice?.state === "device" ? toolbarDevice.serial : null;
  const canSelectDevice = !loading && !inspectionLoading && Boolean(probe?.adbPath && !probe.error && !runtimeError);
  const captureSelected = useCallback(() => {
    if (!captureSerial) return;
    const priorityViewRef = snapshot?.serial === captureSerial ? selectedNode?.attributes?.["view-ref"] ?? null : null;
    void inspectDevice(captureSerial, priorityViewRef);
  }, [captureSerial, inspectDevice, selectedNode, snapshot?.serial]);
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

  useEffect(() => {
    if (!window.electronApi.runtime.nativeMenu || !window.electronApi.updateAppMenu) return;
    let active = true;
    void window.electronApi.updateAppMenu(appMenuState)
      .then(() => { if (active) setNativeMenu(true); }, () => { if (active) setNativeMenu(false); });
    return () => { active = false; };
  }, [appMenuState]);

  const dispatchMenuAction = useCallback((action: AppMenuAction) => {
    if (action.type !== "device" && action.type !== "double-click" && !commandEnabled(action.type, appMenuState, Boolean(debugState?.active), mcpBusy)) return;
    switch (action.type) {
      case "capture": if (!loading && !inspectionLoading) captureSelected(); break;
      case "cancel": cancelInspection(); break;
      case "refresh": if (!loading) void refreshDevices(); break;
      case "home": closeInspector(); break;
      case "device": if (canSelectDevice && readyDevices.some(device => device.serial === action.serial)) selectDevice(action.serial); break;
      case "search": document.querySelector<HTMLInputElement>(".inspection-active .tree-search")?.focus(); break;
      case "save": if (!inspectionLoading) void saveCurrentSnapshot(); break;
      case "open-snapshot": void openSnapshotFile(); break;
      case "export-snapshot": void exportCurrentSnapshot("snapshot"); break;
      case "export-json": void exportCurrentSnapshot("json"); break;
      case "export-xml": void exportCurrentSnapshot("xml"); break;
      case "export-png": void exportCurrentSnapshot("png"); break;
      case "preferences": setPreferencesOpen(true); break;
      case "history": {
        const history = document.querySelector<HTMLDetailsElement>(".snapshot-drawer:not(.debug-drawer)");
        if (history) { history.open = true; history.querySelector("summary")?.focus(); }
        break;
      }
      case "mcp-share": if (!inspectionLoading) void shareMcpSnapshot(); break;
      case "mcp-stop": void stopMcpSharing(); break;
      case "mcp-config": void copyMcpConfig(); break;
      case "debug-start": void startDebugSession(); break;
      case "test-report": setTestReportOpen(true); break;
      case "expand-all": if (workspaceRoot && !hasTreeFilter) handleExpandedChange(current => new Set([...current, ...expandedTreeNodeIds(workspaceRoot)])); break;
      case "collapse-all": if (!hasTreeFilter) setTreeExpandedIds(new Set()); break;
      case "double-click": setDoubleClickAction(action.action); break;
      case "focus-branch": handleLayerAction("focus-branch"); break;
      case "focus-layer": handleLayerAction("focus"); break;
      case "exit-focus": handleLayerAction("exit-focus"); break;
      case "expand-selected": handleLayerAction("expand"); break;
      case "collapse-selected": handleLayerAction("collapse"); break;
      case "hide-selected": handleLayerAction("hide"); break;
      case "restore-layers": handleLayerAction("restore"); break;
    }
  }, [appMenuState, debugState?.active, mcpBusy, loading, inspectionLoading, captureSelected, cancelInspection, refreshDevices, closeInspector, canSelectDevice, readyDevices, selectDevice, saveCurrentSnapshot, openSnapshotFile, exportCurrentSnapshot, workspaceRoot, hasTreeFilter, shareMcpSnapshot, stopMcpSharing, copyMcpConfig, startDebugSession, handleExpandedChange, handleLayerAction, setDoubleClickAction]);

  useEffect(() => window.electronApi.onAppMenuAction?.(dispatchMenuAction), [dispatchMenuAction]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const type = commandForShortcut(event);
      if (!type || nativeMenu) return;
      event.preventDefault();
      if (!event.repeat && !document.querySelector("dialog[open]")) dispatchMenuAction({ type });
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [dispatchMenuAction, nativeMenu]);

  // Stop remains outside collapsed tool menus while automation is authorized.
  const debugStopControl = (debugState?.active || mcpSharing) && <button className="close-button debug-stop" type="button" onClick={() => void stopMcpSharing()}>立即停止</button>;
  const observationControls = <>
    <button type="button" className="close-button" data-command="debug-task-template" disabled={!debugTaskEditorApi}
      onClick={() => setDebugTaskEditorOpen(true)}>任务模板</button>
    <button type="button" className="close-button" data-command="connection-diagnosis" disabled={!connectionDiagnosticApi}
      onClick={() => setConnectionDiagnosticsOpen(true)}>连接诊断</button>
    <button type="button" className="close-button" data-command="live-preview" aria-pressed={livePreviewOpen}
      disabled={!captureSerial || !window.electronApi.startLivePreview} onClick={() => setLivePreviewSerial(value => value ? null : toolbarSerial)}>2D 实时预览</button>
  </>;
  const debugControls = window.electronApi.startDebugSession && <>
    <details className="snapshot-drawer debug-drawer" name="home-tools">
      <summary aria-label="自动调试" title={debugState?.active ? debugState.busy ? "AI 调试中…" : "AI 已授权" : mcpSharing ? "MCP 已共享" : "自动调试"}>
        {mcpSharing ? "MCP" : "AI"}<span className="visually-hidden">{debugState?.active ? "自动调试已授权" : mcpSharing ? "MCP 已共享" : "自动调试"}</span>
      </summary>
      <div className="snapshot-drawer-body">
        <strong>{debugState?.active ? debugState.packageName : "自动 UI 调试"}</strong>
        <p>{debugState?.active ? `设备 ${debugState.serial} · ${new Date(debugState.expiresAt).toLocaleTimeString()} 到期` : "只授权指定 Debug App；支持观察、点击、滚动、返回和结果验证。"}</p>
        <DebugSessionProgress state={debugState} onStop={() => void stopMcpSharing()}
          androidLogsEnabled={androidLogsEnabled} onAndroidLogsChange={setAndroidLogsEnabled} disabled={inspectionLoading || mcpBusy} />
        <div className="snapshot-actions">
          <button className="close-button" type="button" disabled={!captureSerial || inspectionLoading || mcpBusy || debugState?.active} onClick={() => void startDebugSession()}>{mcpBusy ? "正在连接…" : "开启自动调试…"}</button>
          <button className="close-button" type="button" onClick={() => void copyMcpConfig()}>复制 MCP 配置</button>
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

  return (
    <div className={`app-shell ${selectedSerial ? "inspection-active" : ""} ${nativeMenu ? "native-menu" : ""}`}>
      <AppHeader
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
        onBack={closeInspector}
        onSelectDevice={selectDevice}
        onRefresh={() => void refreshDevices()}
        onCapture={captureSelected}
        onCancel={() => cancelInspection()}
        sceneToolbarRef={setSceneToolbarHost}
        inspectionStage={inspectionStage}
        inspectionElapsed={inspectionElapsed}
      />

      {snapshotFileStatus && <aside className="snapshot-file-status" role={snapshotFileStatus.error ? "alert" : "status"}>
        <span>{snapshotFileStatus.message}</span>
        {!openingSnapshot && <button type="button" className="close-button" aria-label="关闭快照提示" onClick={() => setSnapshotFileStatus(null)}>×</button>}
      </aside>}

      {selectedSerial && sceneToolbarHost ? createPortal(<>{debugStopControl}<details className="workbench-utilities" onKeyDown={event => {
        if (event.key !== "Escape") return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }}>
        <summary aria-label="更多工具" title="偏好设置、快照导出与测试报告">⋯</summary>
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
      </details></>, sceneToolbarHost) : <aside className="debug-home-controls">
        <button type="button" className="close-button" data-command="open-snapshot" title={commandShortcut("open-snapshot")}
          disabled={!window.electronApi.importSnapshotFile || !commandEnabled("open-snapshot", appMenuState, Boolean(debugState?.active), mcpBusy)}
          onClick={() => dispatchMenuAction({ type: "open-snapshot" })}>{workbenchCommands["open-snapshot"].label}</button>
        <details className="snapshot-drawer home-history" name="home-tools">
          <summary aria-label={workbenchCommands.history.label}>{workbenchCommands.history.label}</summary>
          <div className="snapshot-drawer-body">
            <strong>本地快照 · {savedSnapshots.length} 份</strong>
            {snapshotsLoading ? <p role="status">正在读取本地快照…</p> : snapshotStoreError ? <p role="alert">{snapshotStoreError}</p>
              : savedSnapshots.length ? <SnapshotHistory entries={savedSnapshots} onSelect={viewSavedSnapshot} /> : <p>还没有本地快照。采集后可以保存，之后无需连接设备即可查看。</p>}
          </div>
        </details>
        <button type="button" className="close-button" onClick={() => setTestReportOpen(true)}>{workbenchCommands["test-report"].label}</button>
        <button type="button" className="close-button preferences-open" title={commandShortcut("preferences")} onClick={() => setPreferencesOpen(true)}>{workbenchCommands.preferences.label}</button>
        {debugStopControl}{debugControls}
        {observationControls}
      </aside>}
      <ConnectionDiagnosticsPanel open={connectionDiagnosticsOpen} onClose={() => setConnectionDiagnosticsOpen(false)}
        serial={toolbarSerial || null} packageName={debugState?.active && debugState.serial === toolbarSerial ? debugState.packageName : undefined}
        captureMode={snapshot?.captureMode ?? "deep"} backend={snapshot?.inspectionSource === "accessibility-helper" ? "accessibility-helper" : "uiautomator"}
        api={connectionDiagnosticApi} />
      {livePreviewOpen && <aside className="live-preview-host">
        <LivePreviewPanel serial={livePreviewSerial!} connected={previewConnected}
          enabled={livePreviewOpen} treeCapturedAt={snapshot?.serial === livePreviewSerial ? treeCapturedAt : null} onClose={() => setLivePreviewSerial(null)} />
      </aside>}
      {preferencesOpen && <PreferencesPanel doubleClickAction={doubleClickAction} onChange={setDoubleClickAction}
        colorAliases={colorAliases} onSaveColorAliases={saveColorAliases}
        inspectorGroups={inspectorGroups} onSaveInspectorGroups={saveInspectorGroups}
        contextHintAcknowledgedCount={contextHints.acknowledgedCount} onResetContextHints={contextHints.resetHints}
        treeCollapsePreference={treeCollapsePreference} onCollapseChange={setTreeCollapsePreference}
        onApplyCollapse={applyTreeCollapsePreference} canApplyCollapse={canApplyTreeCollapse} onClose={() => setPreferencesOpen(false)} />}
      {debugTaskEditorOpen && debugTaskEditorApi && <DebugTaskEditor snapshot={snapshot} selectedNode={selectedNode}
        state={debugState} api={debugTaskEditorApi} onClose={() => setDebugTaskEditorOpen(false)} />}
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
        <DeviceHomeView
          state={homeState}
          device={toolbarDevice}
          devices={devices}
          loading={loading}
          inspectionLoading={inspectionLoading}
          canSelectDevice={canSelectDevice}
          error={runtimeError || probe?.error || null}
          checkedAt={checkedAt}
          onStart={captureSelected}
          onRefresh={() => void refreshDevices()}
          onSelectDevice={selectDevice}
        />
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
                <button className="close-button" type="button" onClick={closeInspector}>返回设备</button>
              </div>
            </div>

            <CaptureFailureHistory records={captureFailures.filter(record => record.serial === selectedSerial)} />
            {inspectionLoading && !snapshot?.root ? (
              <div className="inspector-grid inspector-state-grid">
                <div className="tree-pane inspector-state-pane">
                  <div className="workspace-empty-copy">
                    <span className="loading-orbit" />
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
                    <span className="workspace-empty-icon" aria-hidden="true">◎</span>
                    <h4>等待采集结果</h4>
                    <p>先确认窗口和控件树，再同步设备画面。</p>
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
                    <span className="workspace-empty-icon" aria-hidden="true">×</span>
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
                  }}>×</button>
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
                    />
                    <div className="tree-tools">
                      <div className="tree-search-row">
                        <input
                          className="tree-search"
                          type="search"
                          value={treeQuery}
                          onChange={(event) => setTreeQuery(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape" && hasTreeFilter) {
                              event.preventDefault(); event.stopPropagation(); clearTreeFilter();
                            } else if (event.key === "ArrowDown" && !event.altKey && !event.ctrlKey && !event.metaKey) {
                              event.preventDefault();
                              event.currentTarget.closest(".tree-pane")?.querySelector<HTMLElement>('[role="tree"]')?.focus({ preventScroll: true });
                            }
                          }}
                          placeholder="搜索控件…"
                          title="搜索文本、描述、资源 ID 或控件类型"
                          aria-label="搜索 UI 节点"
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
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h2m4 0h10M8 3v6m6 0v6M6 15v6" /></svg>
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

                  <TreePaneResizer />

                  <div className="preview-pane">
                    <div className="subpanel-heading">
                      <span>设备画面</span>
                      <span className="tree-hint">{selectedSerial}</span>
                    </div>
                    {sceneToolbarHost && createPortal(<details className="snapshot-drawer">
                      <summary aria-label="快照与历史" title={`快照与历史 · ${savedSnapshots.length} 份`}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7M12 7v5l3 2" /></svg>
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
                              <button className="close-button" type="button" onClick={() => void shareMcpSnapshot()} disabled={inspectionLoading || mcpBusy || debugState?.active}>共享当前快照给 MCP</button>
                              <button className="close-button" type="button" onClick={() => void stopMcpSharing()} disabled={!mcpSharing}>停止 MCP 共享</button>
                              <button className="close-button" type="button" onClick={() => void copyMcpConfig()}>复制 MCP 配置</button>
                            </>}
                            <button className="close-button" type="button" onClick={() => void saveCurrentSnapshot()} disabled={inspectionLoading || snapshotsLoading}>保存快照</button>
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
                    {snapshot.screenshotDataUrl ? (
                      <ScreenshotPreview key={treeSession} sessionKey={treeSession} src={snapshot.screenshotDataUrl} root={snapshot.root}
                        selectedNode={selectedNode} expandedNodeIds={treeExpandedIds} geometry={snapshot.captureGeometry} layersAvailable={snapshot.captureMode !== "fast"} toolbarHost={sceneToolbarHost} onSelect={handleScreenshotSelect}
                        layerFocus={layerFocus} hiddenNodeIds={hiddenNodeIds} doubleClickAction={doubleClickAction} onDoubleClick={handleNodeDoubleClick}
                        onLayerAction={handleLayerAction} onOpenLayerMenu={node => void openLayerMenu(node, (label, value) => copyValue(label, value, { node, root: snapshot?.root ?? null }))}
                        savedGroupImages={snapshot.layerGroupImages}
                        onNavigateNode={navigateToNode} navigationDisabled={inspectionLoading || Boolean(viewRefreshingNodeId)}
                        contextHints={contextHints}
                        onCaptureGroup={groupRequestId ? requestGroup : undefined} />
                    ) : <div className="screenshot-frame"><div className="no-screenshot">截图不可用</div></div>}
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
                        groupImage={availableGroupImages.find(group => group.nodeId === detailNode.id)?.image ?? null}
                        colorAliases={colorAliases}
                        inspectorGroups={inspectorGroups}
                        onOpenGroupPreferences={() => setPreferencesOpen(true)}
                        revealRequest={propertiesRevealRequest}
                        screenshotSize={snapshot.captureGeometry?.screenshotSize ?? null}
                        toolbarHost={sceneToolbarHost}
                        docked
                        onCopy={() => void copyValue("节点 JSON", selectorData?.json ?? nodeJson(detailNode))}
                        onCopyValue={(label, value) => void copyValue(label, value)}
                        copyStatus={copyStatus}
                        onRefresh={viewLiveRequestId && detailNode.attributes?.["view-ref"] && !inspectionLoading && !debugState?.active ? () => void refreshViewNode(detailNode) : undefined}
                        onRefreshBranch={(snapshot.inspectionSource === "debug-view" || snapshot.inspectionSource === "debug-hybrid") && viewLiveRequestId && detailNode.children.length > 0 && detailNode.attributes?.["view-ref"] && !inspectionLoading && !debugState?.active ? () => void refreshViewNode(detailNode, "branch") : undefined}
                        onRefreshList={(snapshot.inspectionSource === "debug-view" || snapshot.inspectionSource === "debug-hybrid") && viewLiveRequestId && detailNode.attributes?.["view-ref"] && !inspectionLoading && !debugState?.active && (/(RecyclerView|AbsListView|ListView|GridView|ViewPager)$/.test(detailNode.className ?? "") || detailNode.children.length >= 12) ? () => void refreshViewNode(detailNode, "list") : undefined}
                        onReadStyle={snapshot.inspectionSource === "debug-hybrid" && snapshot.root.attributes?.["sdk-style-version"] === "1" && viewLiveRequestId && detailNode.attributes?.["view-ref"] && !inspectionLoading && !debugState?.active ? () => window.electronApi.readViewStyle(viewLiveRequestId, detailNode.id) : undefined}
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
                              <button type="button" onClick={() => void exportCurrentSnapshot("snapshot")} disabled={inspectionLoading}>导出完整快照</button>
                              <button type="button" onClick={() => void exportCurrentSnapshot("json")} disabled={inspectionLoading}>导出 JSON</button>
                              <button type="button" onClick={() => void exportCurrentSnapshot("xml")} disabled={inspectionLoading || !snapshot.rawXml}>导出 XML</button>
                              <button type="button" onClick={() => void exportCurrentSnapshot("png")} disabled={inspectionLoading || !snapshot.screenshotDataUrl}>导出 PNG</button>
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
                    <span className="workspace-empty-icon" aria-hidden="true">⌁</span>
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
                    <span className="workspace-empty-icon" aria-hidden="true">◎</span>
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
