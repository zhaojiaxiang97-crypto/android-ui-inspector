import { contextBridge, ipcRenderer } from "electron";
import type { AppMenuAction, AppMenuState, DebugSessionEvent, ExportSnapshotRequest, InspectionPreview, InspectionProgress, McpStopSource, NodeImageOutputRequest, SaveSnapshotRequest, UiSnapshot } from "../shared/types";
import type { ReadOnlyCaptureScope } from "../shared/inspection-policy";

contextBridge.exposeInMainWorld("electronApi", {
  runtime: { sandboxed: process.sandboxed, contextIsolated: process.contextIsolated, fixtureMode: process.argv.includes("--visual-fixture"), nativeMenu: process.platform === "darwin", readOnlyDiagnosis: true },
  updateAppMenu: (state: AppMenuState) => ipcRenderer.invoke("update-app-menu", state),
  onAppMenuAction: (callback: (action: AppMenuAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: AppMenuAction) => callback(action);
    ipcRenderer.on("app-menu-action", listener);
    return () => ipcRenderer.removeListener("app-menu-action", listener);
  },
  probeAdb: () => ipcRenderer.invoke("probe-adb"),
  inspectDevice: (serial: string, requestId: string, priorityViewRef?: string | null, singleAttempt?: boolean, scope?: ReadOnlyCaptureScope) => scope === undefined
    ? ipcRenderer.invoke("inspect-device", serial, requestId, priorityViewRef, singleAttempt)
    : ipcRenderer.invoke("inspect-device", serial, requestId, priorityViewRef, singleAttempt, scope),
  captureGroup: (requestId: string, nodeId: string) => ipcRenderer.invoke("capture-group", requestId, nodeId),
  refreshViewNode: (requestId: string, nodeId: string, scope: "node" | "branch" | "list" = "node") => ipcRenderer.invoke("refresh-view-node", requestId, nodeId, scope),
  readViewStyle: (requestId: string, nodeId: string) => ipcRenderer.invoke("read-view-style", requestId, nodeId),
  cancelInspection: (requestId: string) => ipcRenderer.invoke("cancel-inspection", requestId),
  showLayerMenu: (canHide: boolean, canRestore: boolean, canExitFocus: boolean, options?: import("../shared/types").LayerMenuOptions) => ipcRenderer.invoke("layer-context-menu", canHide, canRestore, canExitFocus, options),
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
  startDebugSession: (serial: string) => ipcRenderer.invoke("debug-start", serial),
  getDebugSession: () => ipcRenderer.invoke("debug-state"),
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
  loadDebugReport: () => ipcRenderer.invoke("load-debug-report"),
  saveSnapshot: (request: SaveSnapshotRequest) => ipcRenderer.invoke("save-snapshot", request),
  clearSnapshots: () => ipcRenderer.invoke("clear-snapshots"),
});
