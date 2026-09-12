import { app, BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import type { SaveDialogOptions } from "electron";
import { writeFile } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { inspectDevice, probeAdb } from "./adb";
import { clearSnapshots, loadSnapshots, saveSnapshot } from "./snapshot-store";
import type { ExportFormat, ExportSnapshotRequest, ExportSnapshotResult } from "../shared/types";

const rendererUrl = process.env.ELECTRON_RENDERER_URL;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

// Software rendering is sufficient for this inspector. Runtime file ACLs are
// prepared by the development and packaging hooks; do not bypass the sandbox.
app.disableHardwareAcceleration();

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 960,
    minHeight: 700,
    title: "Android UI Inspector",
    backgroundColor: "#0e1212",
    show: false,
    webPreferences: {
      // Resolve at runtime: Bun may inline the source directory for __dirname.
      preload: join(app.getAppPath(), "dist-electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  let failureReported = false;
  const reportFailure = (reason: string) => {
    if (failureReported || quitting || window.isDestroyed()) return;
    failureReported = true;
    const logDirectory = join(app.getPath("userData"), "logs");
    const logPath = join(logDirectory, "startup.log");
    try {
      mkdirSync(logDirectory, { recursive: true });
      appendFileSync(logPath, `${new Date().toISOString()} ${reason}\n`, "utf8");
    } catch (error) {
      console.error("Unable to write startup log", error);
    }
    console.error(reason);
    dialog.showErrorBox("Android UI Inspector 启动失败", `界面未能正常加载，请重新安装最新版。开发环境可运行 bun run prepare:windows 后重试。\n\n${reason}\n\n日志：${logPath}`);
    window.close();
  };
  window.once("ready-to-show", () => {
    if (!failureReported && !quitting && !window.isDestroyed()) window.show();
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") reportFailure(`渲染进程退出：${details.reason} (${details.exitCode})`);
  });
  window.webContents.on("preload-error", (_event, _path, error) => reportFailure(`界面桥接加载失败：${error.message}`));

  const loading = !app.isPackaged && rendererUrl
    ? window.loadURL(rendererUrl)
    : window.loadFile(join(app.getAppPath(), "dist", "index.html"));
  void loading.catch((error: unknown) => reportFailure(`页面加载失败：${error instanceof Error ? error.message : String(error)}`));

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
}

function isExportFormat(value: unknown): value is ExportFormat {
  return value === "json" || value === "xml" || value === "png";
}

function isExportSnapshotRequest(value: unknown): value is ExportSnapshotRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<ExportSnapshotRequest>;
  return isExportFormat(request.format) && typeof request.data === "string" && typeof request.defaultFileName === "string";
}

function safeDefaultFileName(name: string, format: ExportFormat) {
  const sanitized = basename(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim();
  return sanitized || `android-ui-inspector.${format}`;
}

async function exportSnapshot(input: unknown): Promise<ExportSnapshotResult> {
  if (!isExportSnapshotRequest(input)) {
    return { canceled: false, filePath: null, error: "导出参数无效。" };
  }
  if (input.data.length > 100 * 1024 * 1024) {
    return { canceled: false, filePath: null, error: "导出内容过大，已拒绝写入。" };
  }

  const extension = input.format;
  const saveOptions: SaveDialogOptions = {
    title: "导出快照",
    defaultPath: join(app.getPath("documents"), safeDefaultFileName(input.defaultFileName, input.format)),
    filters: [
      { name: "JSON 文件", extensions: ["json"] },
      { name: "XML 文件", extensions: ["xml"] },
      { name: "PNG 图片", extensions: ["png"] },
    ],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  };
  const saveResult = mainWindow
    ? await dialog.showSaveDialog(mainWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions);

  if (saveResult.canceled || !saveResult.filePath) {
    return { canceled: true, filePath: null, error: null };
  }

  try {
    const payload = input.format === "png"
      ? (() => {
          const prefix = "data:image/png;base64,";
          if (!input.data.startsWith(prefix)) throw new Error("PNG 快照格式无效。");
          return Buffer.from(input.data.slice(prefix.length), "base64");
        })()
      : Buffer.from(input.data, "utf8");

    if (payload.length === 0) throw new Error(`无法导出空的 ${extension.toUpperCase()} 内容。`);
    await writeFile(saveResult.filePath, payload);
    return { canceled: false, filePath: saveResult.filePath, error: null };
  } catch (error) {
    return {
      canceled: false,
      filePath: null,
      error: error instanceof Error ? error.message : "导出文件失败。",
    };
  }
}

ipcMain.handle("probe-adb", () => probeAdb());
ipcMain.handle("inspect-device", (_event, serial: unknown) => {
  if (typeof serial !== "string" || !serial.trim()) {
    throw new Error("设备序列号不能为空。");
  }
  return inspectDevice(serial);
});
ipcMain.handle("copy-text", (_event, value: unknown) => {
  if (typeof value !== "string") throw new Error("复制内容无效。");
  clipboard.writeText(value);
});
ipcMain.handle("export-snapshot", (_event, input: unknown) => exportSnapshot(input));
ipcMain.handle("load-snapshots", () => loadSnapshots());
ipcMain.handle("save-snapshot", (_event, input: unknown) => saveSnapshot(input));
ipcMain.handle("clear-snapshots", () => clearSnapshots());

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => { quitting = true; });
