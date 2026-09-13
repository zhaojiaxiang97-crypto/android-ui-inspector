import { contextBridge, ipcRenderer } from "electron";
import type { ExportSnapshotRequest, SaveSnapshotRequest } from "../shared/types";

contextBridge.exposeInMainWorld("electronApi", {
  runtime: { sandboxed: process.sandboxed, contextIsolated: process.contextIsolated, fixtureMode: process.argv.includes("--visual-fixture") },
  probeAdb: () => ipcRenderer.invoke("probe-adb"),
  inspectDevice: (serial: string) => ipcRenderer.invoke("inspect-device", serial),
  copyText: (value: string) => ipcRenderer.invoke("copy-text", value),
  exportSnapshot: (request: ExportSnapshotRequest) => ipcRenderer.invoke("export-snapshot", request),
  loadSnapshots: () => ipcRenderer.invoke("load-snapshots"),
  saveSnapshot: (request: SaveSnapshotRequest) => ipcRenderer.invoke("save-snapshot", request),
  clearSnapshots: () => ipcRenderer.invoke("clear-snapshots"),
});
