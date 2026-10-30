const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("preferencesTest", {
  key: key => ipcRenderer.invoke("preferences-test-key", key),
  checkpoint: name => ipcRenderer.invoke("preferences-test-checkpoint", name),
});
