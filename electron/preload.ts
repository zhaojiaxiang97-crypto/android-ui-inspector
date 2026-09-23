import { contextBridge, ipcRenderer } from "electron";
import type { ExportSnapshotRequest, InspectionProgress, SaveSnapshotRequest } from "../shared/types";

contextBridge.exposeInMainWorld("electronApi", {
  runtime: { sandboxed: process.sandboxed, contextIsolated: process.contextIsolated, fixtureMode: process.argv.includes("--visual-fixture") },
  probeAdb: () => ipcRenderer.invoke("probe-adb"),
  inspectDevice: (serial: string, requestId: string) => ipcRenderer.invoke("inspect-device", serial, requestId),
  cancelInspection: (requestId: string) => ipcRenderer.invoke("cancel-inspection", requestId),
  showLayerMenu: (canHide: boolean, canRestore: boolean) => ipcRenderer.invoke("layer-context-menu", canHide, canRestore),
  onInspectionProgress: (callback: (progress: InspectionProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: InspectionProgress) => callback(progress);
    ipcRenderer.on("inspection-progress", listener);
    return () => ipcRenderer.removeListener("inspection-progress", listener);
  },
  copyText: (value: string) => ipcRenderer.invoke("copy-text", value),
  exportSnapshot: (request: ExportSnapshotRequest) => ipcRenderer.invoke("export-snapshot", request),
  loadSnapshots: () => ipcRenderer.invoke("load-snapshots"),
  saveSnapshot: (request: SaveSnapshotRequest) => ipcRenderer.invoke("save-snapshot", request),
  clearSnapshots: () => ipcRenderer.invoke("clear-snapshots"),
});
