const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("startupProbe", { sandboxed: process.sandboxed, contextIsolated: process.contextIsolated });
