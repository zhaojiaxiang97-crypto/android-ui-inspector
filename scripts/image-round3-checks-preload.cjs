const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("fixtureNative", {
  input: events => ipcRenderer.invoke("fixture-image-input", events),
  checkpoint: name => ipcRenderer.invoke("fixture-image-checkpoint", name),
});
