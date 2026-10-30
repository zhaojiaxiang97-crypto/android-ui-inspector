// Test-only preload, outside the application archive. No product IPC or filesystem access.
const { contextBridge, ipcRenderer } = require("electron");
const call = (method, ...args) => ipcRenderer.invoke("local-handoff-fixture", method, args);
const api = {
  runtime: { sandboxed: process.sandboxed, contextIsolated: process.contextIsolated,
    fixtureMode: true, nativeMenu: false, readOnlyDiagnosis: true },
  onInspectionProgress: () => () => {}, onInspectionPreview: () => () => {},
};
for (const method of ["probeAdb", "updateAppMenu", "inspectDevice", "loadSnapshots", "copyText", "cancelInspection",
  "captureGroup", "refreshViewNode", "readViewStyle", "showLayerMenu", "saveSnapshot", "clearSnapshots", "exportSnapshot", "startDebugSession"])
  api[method] = (...args) => call(method, ...args);
contextBridge.exposeInMainWorld("electronApi", api);
contextBridge.exposeInMainWorld("diagnosisFixtureAudit", () => call("audit"));
contextBridge.exposeInMainWorld("diagnosisFixtureControl", (method, ...args) => {
  const result = ipcRenderer.sendSync("local-handoff-control", method, args);
  if (result?.error) throw new Error(result.error);
  return result?.value;
});
