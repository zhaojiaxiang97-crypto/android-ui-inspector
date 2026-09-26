import { contextBridge, ipcRenderer } from "electron";
import type { AppMenuAction, AppMenuState, DebugSessionEvent, ExportSnapshotRequest, InspectionProgress, SaveSnapshotRequest, UiSnapshot } from "../shared/types";

contextBridge.exposeInMainWorld("electronApi", {
  runtime: { sandboxed: process.sandboxed, contextIsolated: process.contextIsolated, fixtureMode: process.argv.includes("--visual-fixture"), nativeMenu: process.platform === "darwin" },
  updateAppMenu: (state: AppMenuState) => ipcRenderer.invoke("update-app-menu", state),
  onAppMenuAction: (callback: (action: AppMenuAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: AppMenuAction) => callback(action);
    ipcRenderer.on("app-menu-action", listener);
    return () => ipcRenderer.removeListener("app-menu-action", listener);
  },
  probeAdb: () => ipcRenderer.invoke("probe-adb"),
  inspectDevice: (serial: string, requestId: string) => ipcRenderer.invoke("inspect-device", serial, requestId),
  cancelInspection: (requestId: string) => ipcRenderer.invoke("cancel-inspection", requestId),
  showLayerMenu: (canHide: boolean, canRestore: boolean, canExitFocus: boolean) => ipcRenderer.invoke("layer-context-menu", canHide, canRestore, canExitFocus),
  onInspectionProgress: (callback: (progress: InspectionProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: InspectionProgress) => callback(progress);
    ipcRenderer.on("inspection-progress", listener);
    return () => ipcRenderer.removeListener("inspection-progress", listener);
  },
  copyText: (value: string) => ipcRenderer.invoke("copy-text", value),
  shareMcpSnapshot: (snapshot: UiSnapshot, selectedNodeId: string | null) => ipcRenderer.invoke("mcp-share", snapshot, selectedNodeId),
  stopMcpSharing: () => ipcRenderer.invoke("mcp-stop"),
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
  loadSnapshots: () => ipcRenderer.invoke("load-snapshots"),
  saveSnapshot: (request: SaveSnapshotRequest) => ipcRenderer.invoke("save-snapshot", request),
  clearSnapshots: () => ipcRenderer.invoke("clear-snapshots"),
});
