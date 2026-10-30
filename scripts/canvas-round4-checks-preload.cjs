const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("canvasRound4Native", {
  input: events => ipcRenderer.invoke("canvas-round4-input", events),
  checkpoint: name => ipcRenderer.invoke("canvas-round4-checkpoint", name),
});
