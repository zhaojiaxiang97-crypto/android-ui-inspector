const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("propertiesRound4Native", {
  key: key => ipcRenderer.invoke("fixture-properties-key", key),
  checkpoint: name => ipcRenderer.invoke("fixture-properties-checkpoint", name),
});
