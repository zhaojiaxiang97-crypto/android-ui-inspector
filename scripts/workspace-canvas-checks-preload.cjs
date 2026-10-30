const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("fixtureNative", {
  input: events => ipcRenderer.invoke("fixture-native-input", events),
  checkpoint: name => ipcRenderer.invoke("fixture-checkpoint", name),
});
