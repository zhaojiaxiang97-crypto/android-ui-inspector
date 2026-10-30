const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("inspectorGroupsRound5Native", {
  key: key => ipcRenderer.invoke("fixture-inspector-group-key", key),
  checkpoint: name => ipcRenderer.invoke("fixture-inspector-group-checkpoint", name),
});
