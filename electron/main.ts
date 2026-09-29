import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import type { MenuItemConstructorOptions, SaveDialogOptions } from "electron";
import { writeFile } from "node:fs/promises";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { captureQmlGroupImage, captureViewNodes, getDebugTarget, inspectPreferredDevice, observeDebugApp, parseUiHierarchy, probeAdb } from "./adb";
import { DebugSession } from "./debug-session";
import { clearLiveEndpoint, openLiveBridge } from "./mcp-live";
import { clearSnapshots, loadSnapshots, saveSnapshot } from "./snapshot-store";
import { measureLayerImages } from "./layer-images";
import { publishMcpSnapshot, revokeMcpSnapshot } from "./mcp-snapshot";
import { isUiSnapshot } from "../shared/snapshot-validation";
import type { AppMenuAction, AppMenuState, DeviceInfo, ExportFormat, ExportSnapshotRequest, ExportSnapshotResult, LayerMenuAction, QmlGroupImage, UiNode, UiSnapshot, ViewRefreshResult } from "../shared/types";

const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const visualFixtureMode = process.argv.includes("--visual-fixture");
type VisualFixtureState = "connected" | "loading" | "unauthorized" | "empty" | "adb-missing";

function requestedFixtureState(): VisualFixtureState {
  const value = process.argv.find((argument) => argument.startsWith("--visual-fixture-state="))?.slice("--visual-fixture-state=".length);
  if (value === "loading" || value === "unauthorized" || value === "empty" || value === "adb-missing") return value;
  return "connected";
}

const visualFixtureState = requestedFixtureState();
let mainWindow: BrowserWindow | null = null;
let quitting = false;
const inspections = new Map<number, { requestId: string; controller: AbortController; done: Promise<UiSnapshot> }>();
const liveSessions = new Map<number, { requestId: string; snapshot: UiSnapshot }>();
const qmlGroups = new Map<number, { controller: AbortController; done: Promise<QmlGroupImage | null> }>();
const viewRefreshes = new Map<number, { controller: AbortController; done: Promise<ViewRefreshResult> }>();
let mcpRevision = 0;
const mcpSnapshotPath = () => join(app.getPath("userData"), "mcp", "current.json");
let debugSession: DebugSession | null = null;
let liveBridge: Awaited<ReturnType<typeof openLiveBridge>> | null = null;
let debugStarting = false;
let lastMenuState: AppMenuState | undefined;
function stopMcpSharing() {
  mcpRevision++;
  debugSession?.stop();
  liveBridge?.close(); liveBridge = null;
  clearLiveEndpoint(mcpSnapshotPath());
  revokeMcpSnapshot(mcpSnapshotPath());
}

function updateApplicationMenu(state?: AppMenuState) {
  lastMenuState = state;
  if (process.platform !== "darwin") return;
  const send = (action: AppMenuAction) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app-menu-action", action);
  };
  const command = (label: string, type: Exclude<AppMenuAction["type"], "device">, enabled: boolean, accelerator?: string): MenuItemConstructorOptions => (
    { id: type, label, enabled, accelerator, click: () => send({ type }) }
  );
  const ready = Boolean(state && !state.loading);
  const captureReady = ready && !state?.capturing && Boolean(state?.devices.some(device => device.serial === state.selectedSerial && device.state === "device"));
  const treeReady = Boolean(state?.hasSnapshot && !state.capturing);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Android UI Inspector", submenu: [{ role: "about" }, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
    { label: "文件", submenu: [
      command(state?.capturing ? "正在采集…" : "采集当前画面", "capture", captureReady, "CmdOrCtrl+R"),
      command("取消采集", "cancel", Boolean(state?.capturing), "CmdOrCtrl+."),
      { type: "separator" },
      command("保存快照", "save", treeReady, "CmdOrCtrl+S"),
      { label: "MCP", submenu: [
        command("开启自动调试…", "debug-start", captureReady && !debugSession?.state.active && !debugStarting),
        command(state?.mcpSharing ? "重新共享当前快照给 MCP" : "共享当前快照（只读）", "mcp-share", treeReady && !debugSession?.state.active && !debugStarting),
        command("停止 MCP / 自动调试", "mcp-stop", Boolean(state?.mcpSharing || debugSession?.state.active || debugStarting)),
        command("复制 MCP 配置", "mcp-config", true),
      ] },
      command("返回设备列表", "home", Boolean(state?.inspecting), "CmdOrCtrl+Shift+H"),
      { type: "separator" }, { role: "close" },
    ] },
    { label: "设备", submenu: [
      command(state?.loading ? "正在刷新…" : "刷新设备", "refresh", ready, "CmdOrCtrl+Shift+R"),
      { type: "separator" },
      ...(state?.devices.length ? state.devices.map((device): MenuItemConstructorOptions => ({
        label: `${device.model || device.serial} · ${device.serial} · ${device.state === "device" ? "已连接" : device.state === "unauthorized" ? "待授权" : "离线"}`,
        type: "radio", checked: device.serial === state.selectedSerial,
        enabled: ready && device.state === "device",
        click: () => send({ type: "device", serial: device.serial }),
      })) : [{ label: "未发现设备", enabled: false }]),
    ] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "视图", submenu: [
      command("搜索控件", "search", treeReady, "CmdOrCtrl+K"),
      command("展开全部层级", "expand-all", treeReady && !state?.filtered),
      command("收起全部层级", "collapse-all", treeReady && !state?.filtered),
      { type: "separator" }, { role: "togglefullscreen" },
    ] },
    { role: "windowMenu", label: "窗口" },
  ]));
}

function isAppMenuState(input: unknown): input is AppMenuState {
  if (!input || typeof input !== "object") return false;
  const value = input as AppMenuState;
  const shortString = (text: unknown) => typeof text === "string" && text.length <= 256;
  return shortString(value.selectedSerial)
    && [value.loading, value.capturing, value.inspecting, value.hasSnapshot, value.filtered].every(flag => typeof flag === "boolean")
    && (value.mcpSharing === undefined || typeof value.mcpSharing === "boolean")
    && Array.isArray(value.devices) && value.devices.length <= 128
    && value.devices.every(device => device && shortString(device.serial) && shortString(device.state) && (device.model === null || shortString(device.model)));
}

ipcMain.handle("update-app-menu", (event, input: unknown) => {
  if (process.platform !== "darwin" || event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) return;
  if (!isAppMenuState(input)) throw new Error("菜单状态无效。");
  updateApplicationMenu(input);
});

function requestedWindowSize() {
  const value = process.argv.find((argument) => argument.startsWith("--window-size="))?.slice("--window-size=".length);
  const match = value?.match(/^(\d+)x(\d+)$/i);
  if (!match) return { width: 1280, height: 880 };
  const width = Math.max(960, Math.min(3200, Number(match[1])));
  const height = Math.max(700, Math.min(2200, Number(match[2])));
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : { width: 1280, height: 880 };
}

function countNodes(node: UiNode | null) {
  if (!node) return 0;
  const pending = [node];
  let count = 0;
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    count += 1;
    pending.push(...pending[cursor].children);
  }
  return count;
}

async function fixtureProbe() {
  if (visualFixtureState === "loading") {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  }

  if (visualFixtureState === "adb-missing") {
    return {
      adbPath: null,
      adbVersion: null,
      devices: [],
      error: "未找到 ADB。请安装 Android SDK Platform-Tools。",
    };
  }

  const device: DeviceInfo = {
    serial: "visual-fixture",
    state: visualFixtureState === "unauthorized" ? "unauthorized" : "device",
    model: "Fixture Pixel",
    androidVersion: "15",
    product: "android-ui-inspector-fixture",
    transportId: null,
  };
  return {
    adbPath: "visual-fixture",
    adbVersion: "Android Debug Bridge visual fixture",
    devices: visualFixtureState === "empty" ? [] : [device],
    error: null,
  };
}

function fixtureSnapshot(serial: string): UiSnapshot {
  const fixtureDirectory = join(app.getAppPath(), "tests", "fixtures");
  const rawXml = readFileSync(join(fixtureDirectory, "uiautomator-portrait.xml"), "utf8");
  const screenshotSvg = readFileSync(join(fixtureDirectory, "visual-screen.svg"), "utf8");
  const parsed = parseUiHierarchy(rawXml);
  const screenshotSize = { width: 1080, height: 2400 };
  const frame = { ...screenshotSize, rotation: 0 as const };
  return {
    serial,
    root: parsed.root,
    nodeCount: countNodes(parsed.root),
    xmlSize: Buffer.byteLength(rawXml, "utf8"),
    rawXml,
    screenshotDataUrl: `data:image/svg+xml;base64,${Buffer.from(screenshotSvg, "utf8").toString("base64")}`,
    error: null,
    warning: null,
    inspectionSource: "uiautomator",
    hierarchyDumpMode: "full",
    captureGeometry: {
      hierarchyRotation: parsed.rotation,
      beforeScreenshot: frame,
      afterScreenshot: frame,
      screenshotSize,
    },
  };
}

function createWindow() {
  const windowSize = requestedWindowSize();
  const window = new BrowserWindow({
    ...windowSize,
    minWidth: 960,
    minHeight: 700,
    title: "Android UI Inspector",
    backgroundColor: "#111419",
    show: false,
    webPreferences: {
      // Resolve at runtime: Bun may inline the source directory for __dirname.
      preload: join(app.getAppPath(), "dist-electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: visualFixtureMode ? ["--visual-fixture"] : [],
    },
  });
  mainWindow = window;
  const windowId = window.webContents.id;
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
  window.webContents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) {
      stopMcpSharing();
      qmlGroups.get(windowId)?.controller.abort();
      qmlGroups.delete(windowId);
      viewRefreshes.get(windowId)?.controller.abort();
      viewRefreshes.delete(windowId);
      liveSessions.delete(windowId);
    }
  });

  const loading = !app.isPackaged && rendererUrl
    ? window.loadURL(rendererUrl)
    : window.loadFile(join(app.getAppPath(), "dist", "index.html"));
  void loading.catch((error: unknown) => reportFailure(`页面加载失败：${error instanceof Error ? error.message : String(error)}`));

  window.on("closed", () => {
    qmlGroups.get(windowId)?.controller.abort();
    qmlGroups.delete(windowId);
    viewRefreshes.get(windowId)?.controller.abort();
    viewRefreshes.delete(windowId);
    liveSessions.delete(windowId);
    if (mainWindow === window) { stopMcpSharing(); mainWindow = null; updateApplicationMenu(); }
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

ipcMain.handle("probe-adb", () => visualFixtureMode ? fixtureProbe() : probeAdb());
ipcMain.handle("inspect-device", async (event, serial: unknown, requestId: unknown) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的采集来源。");
  if (typeof serial !== "string" || !serial.trim()) {
    throw new Error("设备序列号不能为空。");
  }
  if (typeof requestId !== "string" || !requestId || requestId.length > 128) throw new Error("采集请求标识无效。");
  stopMcpSharing();
  const sender = event.sender;
  const ownerId = sender.id;
  const previous = inspections.get(ownerId);
  const previousGroup = qmlGroups.get(ownerId);
  const previousView = viewRefreshes.get(ownerId);
  previousGroup?.controller.abort();
  previousView?.controller.abort();
  liveSessions.delete(ownerId);
  previous?.controller.abort();
  const controller = new AbortController();
  const onDestroyed = () => controller.abort();
  sender.once("destroyed", onDestroyed);
  const done = (async () => {
    // Release the previous debugger/port before starting another capture.
    await previous?.done.catch(() => undefined);
    await previousGroup?.done.catch(() => undefined);
    await previousView?.done.catch(() => undefined);
    await debugSession?.settled();
    controller.signal.throwIfAborted();
    const snapshot = visualFixtureMode ? fixtureSnapshot(serial) : await inspectPreferredDevice(serial, {
      signal: controller.signal,
      onProgress: (stage, elapsedMs) => {
        if (!sender.isDestroyed()) sender.send("inspection-progress", { requestId, stage, elapsedMs });
      },
      onPreview: (phase, snapshot) => {
        if (!sender.isDestroyed() && !controller.signal.aborted) sender.send("inspection-preview", { requestId, phase, snapshot });
      },
    });
    await measureLayerImages(snapshot.root, controller.signal);
    controller.signal.throwIfAborted();
    if ((snapshot.inspectionSource === "debug-qml" && snapshot.root?.attributes?.["qml-process-id"] && snapshot.root.attributes["qml-window-id"])
      || ((snapshot.inspectionSource === "debug-view" || snapshot.inspectionSource === "debug-hybrid") && snapshot.root?.attributes?.["debug-process-id"] && snapshot.root.attributes["debug-window-name"])) {
      liveSessions.set(ownerId, { requestId, snapshot });
    }
    return snapshot;
  })();
  inspections.set(ownerId, { requestId, controller, done });
  try { return await done; }
  finally {
    sender.removeListener("destroyed", onDestroyed);
    if (inspections.get(ownerId)?.controller === controller) inspections.delete(ownerId);
  }
});
ipcMain.handle("capture-qml-group", async (event, requestId: unknown, nodeId: unknown) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的抓图来源。");
  if (typeof requestId !== "string" || requestId.length > 128 || typeof nodeId !== "string" || !/^0(?:\/\d+)*$/.test(nodeId) || nodeId.length > 600) return null;
  const ownerId = event.sender.id;
  const session = liveSessions.get(ownerId);
  if (!session || session.snapshot.inspectionSource !== "debug-qml" || session.requestId !== requestId || inspections.has(ownerId) || debugSession?.state.busy) return null;
  const previous = qmlGroups.get(ownerId);
  previous?.controller.abort();
  const controller = new AbortController();
  const done = (async () => {
    await previous?.done.catch(() => undefined);
    controller.signal.throwIfAborted();
    return captureQmlGroupImage(session.snapshot.serial, session.snapshot, nodeId, controller.signal);
  })();
  qmlGroups.set(ownerId, { controller, done });
  try { return await done; }
  catch { return null; }
  finally { if (qmlGroups.get(ownerId)?.controller === controller) qmlGroups.delete(ownerId); }
});
ipcMain.handle("refresh-view-node", async (event, requestId: unknown, nodeId: unknown, scope: unknown = "node") => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的抓图来源。");
  if (typeof requestId !== "string" || requestId.length > 128 || typeof nodeId !== "string" || !/^0(?:\/\d+)*$/.test(nodeId) || nodeId.length > 600)
    throw new Error("控件标识无效。");
  if (scope !== "node" && scope !== "branch") throw new Error("刷新范围无效。");
  const ownerId = event.sender.id;
  const session = liveSessions.get(ownerId);
  if (!session || (session.snapshot.inspectionSource !== "debug-view" && session.snapshot.inspectionSource !== "debug-hybrid")
      || session.requestId !== requestId || inspections.has(ownerId) || debugSession?.state.active)
    throw new Error("当前快照已失效，请重新采集页面。");
  if (session.snapshot.inspectionSource === "debug-hybrid" && scope === "branch") throw new Error("混合快照暂不支持分支刷新，请选择单个控件。");
  const previous = viewRefreshes.get(ownerId);
  previous?.controller.abort();
  const controller = new AbortController();
  const done = (async () => {
    await previous?.done.catch(() => undefined);
    controller.signal.throwIfAborted();
    return captureViewNodes(session.snapshot.serial, session.snapshot, nodeId, scope === "branch", controller.signal);
  })();
  viewRefreshes.set(ownerId, { controller, done });
  try { return await done; }
  finally { if (viewRefreshes.get(ownerId)?.controller === controller) viewRefreshes.delete(ownerId); }
});
ipcMain.handle("cancel-inspection", (event, requestId: unknown) => {
  const active = inspections.get(event.sender.id);
  if (typeof requestId === "string" && active?.requestId === requestId) active.controller.abort();
});
ipcMain.handle("layer-context-menu", (event, canHide: unknown, canRestore: unknown, canExitFocus: unknown) => {
  if ([canHide, canRestore, canExitFocus].some(value => typeof value !== "boolean")) throw new Error("图层菜单参数无效。");
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return null;
  return new Promise<LayerMenuAction>((resolve) => {
    Menu.buildFromTemplate([
      { id: "focus", label: "聚焦此控件", enabled: canHide === true, click: () => resolve("focus") },
      { id: "exit-focus", label: "退出聚焦", enabled: canExitFocus === true, click: () => resolve("exit-focus") },
      { type: "separator" },
      { id: "hide", label: "隐藏此图层", enabled: canHide === true, click: () => resolve("hide") },
      { type: "separator" },
      { id: "restore", label: "恢复所有隐藏图层", enabled: canRestore === true, click: () => resolve("restore") },
    ]).popup({ window, callback: () => resolve(null) });
  });
});
ipcMain.handle("copy-text", (_event, value: unknown) => {
  if (typeof value !== "string") throw new Error("复制内容无效。");
  clipboard.writeText(value);
});
ipcMain.handle("mcp-share", async (event, snapshot: unknown, selectedNodeId: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的共享来源。");
  if (!isUiSnapshot(snapshot) || !snapshot.root || snapshot.error) throw new Error("没有可共享的快照。");
  if (debugSession?.state.active || debugStarting) throw new Error("请先停止自动调试，再共享静态快照。");
  const revision = mcpRevision;
  const answer = await dialog.showMessageBox(mainWindow, {
    type: "warning", title: "共享当前快照给 MCP？", message: "允许你配置的 MCP 客户端读取这一份页面数据？",
    detail: "包含所有已采集控件的文本、属性、截图和独立图层（含在画布中隐藏的控件），不包含其他历史快照。图片仅在客户端请求时返回。接入云端 AI 时，这些内容可能发送到模型服务。不会操作手机。切换快照、重新采集或关闭程序会停止共享。",
    buttons: ["取消", "共享这一份"], defaultId: 0, cancelId: 0, noLink: true,
  });
  if (answer.response !== 1 || revision !== mcpRevision || event.sender.isDestroyed()) return { shared: false, snapshotId: null, error: null };
  try {
    const entry = publishMcpSnapshot(mcpSnapshotPath(), snapshot, selectedNodeId);
    return { shared: true, snapshotId: entry.id, error: null };
  } catch (error) { return { shared: false, snapshotId: null, error: error instanceof Error ? error.message : "共享失败。" }; }
});
ipcMain.handle("mcp-stop", event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的共享来源。");
  stopMcpSharing();
});
ipcMain.handle("mcp-config", event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的配置来源。");
  const script = app.isPackaged ? join(process.resourcesPath, "mcp", "server.cjs") : join(app.getAppPath(), "dist-electron", "mcp.cjs");
  return clipboard.writeText(JSON.stringify({ mcpServers: { "android-ui-inspector": { command: "node", args: [script], env: { ANDROID_UI_INSPECTOR_MCP_SNAPSHOT: mcpSnapshotPath() } } } }, null, 2));
});

ipcMain.handle("debug-start", async (event, serial: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的调试来源。");
  if (typeof serial !== "string" || !/^[\w.:-]{1,256}$/.test(serial)) throw new Error("设备无效。");
  if (debugStarting || debugSession?.state.active || inspections.size) throw new Error("请先结束当前采集或调试。");
  debugStarting = true;
  const revision = ++mcpRevision;
  updateApplicationMenu(lastMenuState);
  const fixtureTarget = { packageName: "com.example.sanitized", component: "com.example.sanitized/.Main", activityName: ".Main", windowId: "fixture" };
  try {
    await debugSession?.settled();
    const target = visualFixtureMode ? fixtureTarget : await getDebugTarget(serial);
    if (revision !== mcpRevision || event.sender.isDestroyed()) return null;
    const answer = await dialog.showMessageBox(mainWindow, {
      type: "warning", title: "开启自动 UI 调试？", message: `允许 AI 观察并操作 ${target.packageName}？`,
      detail: `设备：${serial}\n本次授权最长 30 分钟，只允许当前 Debug App。AI 可反复采集文本、截图、独立图层（含隐藏节点），点击控件、滚动列表、返回上一页；操作可能改变 App 数据，返回可能丢弃编辑或离开 App。请只测试安全的页面，支付、删除、发送、丢弃编辑等操作需另行确认。\n接入云端 AI 时页面数据可能发送到模型服务。失败前后快照和操作记录保存在本机。可随时点击“立即停止”；已发出的操作无法撤回。不会自动重启 App、执行任意命令或修改源码。`,
      buttons: ["取消", "授权本次调试"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (answer.response !== 1 || revision !== mcpRevision || event.sender.isDestroyed()) return null;
    if (!visualFixtureMode) await getDebugTarget(serial, target.packageName);
    if (revision !== mcpRevision || event.sender.isDestroyed()) return null;
    revokeMcpSnapshot(mcpSnapshotPath());
    const session = new DebugSession({ serial, packageName: target.packageName, snapshotPath: mcpSnapshotPath(),
      directory: join(app.getPath("userData"), "mcp", "runs"),
      observe: async (device, packageName, mode, signal) => {
        const result = visualFixtureMode
          ? { snapshot: { ...fixtureSnapshot(device), captureMode: mode }, target: fixtureTarget }
          : await observeDebugApp(device, packageName, mode, signal);
        if (mode === "deep") await measureLayerImages(result.snapshot.root, signal);
        return result;
      },
      ...(visualFixtureMode ? { input: async () => undefined } : {}),
      onEvent: update => {
        if (!update.state.active) { liveBridge?.close(); liveBridge = null; }
        if (!event.sender.isDestroyed()) event.sender.send("debug-session-event", update);
        updateApplicationMenu(lastMenuState);
      },
    });
    debugSession = session;
    try {
      const bridge = await openLiveBridge(mcpSnapshotPath(), (command, signal) => session.request(command, signal));
      if (revision !== mcpRevision || event.sender.isDestroyed() || !session.state.active) { bridge.close(); session.stop(); return null; }
      liveBridge = bridge;
      event.sender.send("debug-session-event", { state: session.state });
      return session.state;
    } catch (error) { session.stop(); throw error; }
  } finally { debugStarting = false; updateApplicationMenu(lastMenuState); }
});
ipcMain.handle("debug-state", event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的调试来源。");
  return debugSession?.state ?? null;
});
ipcMain.handle("debug-open-evidence", async event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的调试来源。");
  if (!debugSession?.state.evidencePath) throw new Error("还没有失败证据。");
  const error = await shell.openPath(dirname(debugSession.state.evidencePath));
  if (error) throw new Error(error);
});
ipcMain.handle("export-snapshot", (_event, input: unknown) => exportSnapshot(input));
ipcMain.handle("load-snapshots", () => loadSnapshots());
ipcMain.handle("save-snapshot", (_event, input: unknown) => saveSnapshot(input));
ipcMain.handle("clear-snapshots", () => clearSnapshots());

app.whenReady().then(() => {
  stopMcpSharing(); // No implicit sharing after an app restart.
  // Keep the native title bar/window controls for reliable desktop behavior,
  // but remove the unused default application menu on Windows/Linux so it
  // does not create a second visual toolbar above the reference shell.
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  else updateApplicationMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  stopMcpSharing();
  const captures = [...inspections.values()];
  for (const capture of captures) capture.controller.abort();
  const groups = [...qmlGroups.values()];
  for (const group of groups) group.controller.abort();
  if (captures.length || groups.length) {
    event.preventDefault();
    void Promise.allSettled([...captures.map((capture) => capture.done), ...groups.map((group) => group.done)]).then(() => app.quit());
  } else if (debugSession?.state.busy) {
    event.preventDefault();
    void debugSession.settled().then(() => app.quit());
  }
});
