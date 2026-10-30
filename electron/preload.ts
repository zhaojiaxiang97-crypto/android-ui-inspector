import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/desktop-api";
import type { AppMenuAction, AppMenuState, DebugSessionEvent, DebugSessionStartOptions, ExportSnapshotRequest, InspectionPreview, InspectionProgress, LayerMenuOptions, McpStopSource, NodeImageOutputRequest, SaveSnapshotRequest, UiSnapshot, WindowMode } from "../shared/types";
import type { ReadOnlyCaptureScope } from "../shared/inspection-policy";
import type { ConnectionDiagnosticRequest } from "../shared/connection-diagnostics";
import type { LivePreviewEvent } from "../shared/live-preview";
import type { DebugTaskTemplateSaveInput, DebugTaskFragmentSaveInput } from "../shared/debug-task-templates";
import type { DebugTaskDefinition } from "../shared/debug-task";
import type { DebugReportExportRequest } from "../shared/debug-report-export";
import { isLayerMenuAction, isLayerMenuOptions, layerMenuActionEnabled } from "../shared/layer-context-menu";

const desktopApi = {
  runtime: { sandboxed: process.sandboxed, contextIsolated: process.contextIsolated, fixtureMode: process.argv.includes("--visual-fixture"), nativeMenu: process.platform === "darwin", readOnlyDiagnosis: true },
  updateAppMenu: (state: AppMenuState) => ipcRenderer.invoke("update-app-menu", state),
  setWindowMode: (mode: WindowMode) => ipcRenderer.invoke("set-window-mode", mode),
  onAppMenuAction: (callback: (action: AppMenuAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: AppMenuAction) => callback(action);
    ipcRenderer.on("app-menu-action", listener);
    return () => ipcRenderer.removeListener("app-menu-action", listener);
  },
  probeAdb: () => ipcRenderer.invoke("probe-adb"),
  diagnoseConnection: (request: ConnectionDiagnosticRequest) => ipcRenderer.invoke("diagnose-connection", request),
  cancelConnectionDiagnosis: (requestId: string) => ipcRenderer.invoke("cancel-connection-diagnosis", requestId),
  startLivePreview: (serial: string) => ipcRenderer.invoke("live-preview-start", serial),
  pauseLivePreview: (sessionId: string) => ipcRenderer.invoke("live-preview-pause", sessionId),
  resumeLivePreview: (sessionId: string) => ipcRenderer.invoke("live-preview-resume", sessionId),
  stopLivePreview: (sessionId?: string) => ipcRenderer.invoke("live-preview-stop", sessionId),
  getLivePreview: () => ipcRenderer.invoke("live-preview-state"),
  onLivePreview: (callback: (event: LivePreviewEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: LivePreviewEvent) => callback(event);
    ipcRenderer.on("live-preview-event", listener);
    return () => ipcRenderer.removeListener("live-preview-event", listener);
  },
  inspectDevice: (serial: string, requestId: string, priorityViewRef?: string | null, singleAttempt?: boolean, scope?: ReadOnlyCaptureScope) => scope === undefined
    ? ipcRenderer.invoke("inspect-device", serial, requestId, priorityViewRef, singleAttempt)
    : ipcRenderer.invoke("inspect-device", serial, requestId, priorityViewRef, singleAttempt, scope),
  captureGroup: (requestId: string, nodeId: string) => ipcRenderer.invoke("capture-group", requestId, nodeId),
  refreshViewNode: (requestId: string, nodeId: string, scope: "node" | "branch" | "list" = "node") => ipcRenderer.invoke("refresh-view-node", requestId, nodeId, scope),
  readViewStyle: (requestId: string, nodeId: string) => ipcRenderer.invoke("read-view-style", requestId, nodeId),
  cancelInspection: (requestId: string) => ipcRenderer.invoke("cancel-inspection", requestId),
  showLayerMenu: async (canHide: boolean, canRestore: boolean, canExitFocus: boolean, options?: LayerMenuOptions) => {
    if ([canHide, canRestore, canExitFocus].some(value => typeof value !== "boolean")
      || (options !== undefined && !isLayerMenuOptions(options))) throw new Error("图层菜单参数无效。");
    const action: unknown = await ipcRenderer.invoke("layer-context-menu", canHide, canRestore, canExitFocus, options);
    if (!isLayerMenuAction(action) || !layerMenuActionEnabled(action, options))
      throw new Error("图层菜单动作无效。");
    return action;
  },
  onInspectionProgress: (callback: (progress: InspectionProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: InspectionProgress) => callback(progress);
    ipcRenderer.on("inspection-progress", listener);
    return () => ipcRenderer.removeListener("inspection-progress", listener);
  },
  onInspectionPreview: (callback: (preview: InspectionPreview) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, preview: InspectionPreview) => callback(preview);
    ipcRenderer.on("inspection-preview", listener);
    return () => ipcRenderer.removeListener("inspection-preview", listener);
  },
  copyText: (value: string) => ipcRenderer.invoke("copy-text", value),
  shareMcpSnapshot: (snapshot: UiSnapshot, selectedNodeId: string | null) => ipcRenderer.invoke("mcp-share", snapshot, selectedNodeId),
  stopMcpSharing: (source?: McpStopSource) => ipcRenderer.invoke("mcp-stop", source),
  copyMcpConfig: () => ipcRenderer.invoke("mcp-config"),
  startDebugSession: (serial: string, options?: DebugSessionStartOptions) => options === undefined
    ? ipcRenderer.invoke("debug-start", serial)
    : ipcRenderer.invoke("debug-start", serial, options),
  getDebugSession: () => ipcRenderer.invoke("debug-state"),
  loadDebugTaskTemplates: () => ipcRenderer.invoke("debug-task-templates-load"),
  saveDebugTaskTemplate: (input: DebugTaskTemplateSaveInput) => ipcRenderer.invoke("debug-task-template-save", input),
  deleteDebugTaskTemplate: (id: string) => ipcRenderer.invoke("debug-task-template-delete", id),
  loadDebugTaskFragments: () => ipcRenderer.invoke("debug-task-fragments-load"),
  saveDebugTaskFragment: (input: DebugTaskFragmentSaveInput) => ipcRenderer.invoke("debug-task-fragment-save", input),
  deleteDebugTaskFragment: (id: string) => ipcRenderer.invoke("debug-task-fragment-delete", id),
  importDebugTaskTemplates: () => ipcRenderer.invoke("debug-task-templates-import"),
  exportDebugTaskTemplates: () => ipcRenderer.invoke("debug-task-templates-export"),
  defineDebugTask: (input: { sessionId: string; definition: DebugTaskDefinition }) => ipcRenderer.invoke("debug-task-define", input),
  checkDebugTask: (input: { sessionId: string; taskId: string; checkpointId?: string }) => ipcRenderer.invoke("debug-task-check", input),
  openDebugEvidence: () => ipcRenderer.invoke("debug-open-evidence"),
  onDebugSession: (callback: (event: DebugSessionEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: DebugSessionEvent) => callback(event);
    ipcRenderer.on("debug-session-event", listener);
    return () => ipcRenderer.removeListener("debug-session-event", listener);
  },
  exportSnapshot: (request: ExportSnapshotRequest) => ipcRenderer.invoke("export-snapshot", request),
  outputNodeImage: (request: NodeImageOutputRequest) => ipcRenderer.invoke("output-node-image", request),
  importSnapshotFile: () => ipcRenderer.invoke("import-snapshot-file"),
  loadSnapshots: () => ipcRenderer.invoke("load-snapshots"),
  importTestReport: () => ipcRenderer.invoke("import-test-report"),
  importComparisonReport: () => ipcRenderer.invoke("import-comparison-report"),
  loadDebugReport: () => ipcRenderer.invoke("load-debug-report"),
  exportDebugReportEvidence: (request: DebugReportExportRequest) => ipcRenderer.invoke("export-debug-report-evidence", request),
  cancelDebugReportExport: (requestId: string) => ipcRenderer.invoke("cancel-debug-report-export", requestId),
  saveSnapshot: (request: SaveSnapshotRequest) => ipcRenderer.invoke("save-snapshot", request),
  clearSnapshots: () => ipcRenderer.invoke("clear-snapshots"),
} satisfies DesktopApi;

contextBridge.exposeInMainWorld("electronApi", desktopApi);
