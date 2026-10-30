import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell } from "electron";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { captureListViewItems, captureViewGroupImage, captureViewNodes, captureViewStyle } from "./capture/refresh";
import { captureQmlGroupImage } from "./capture/qt";
import { closeProviderSessions } from "./sdk/provider-session";
import { getDebugTarget } from "./device/target";
import { inspectPreferredDevice } from "./capture/inspection";
import { observeDebugApp } from "./automation/device-actions";
import { parseUiHierarchy } from "./capture/xml-tree";
import { probeAdb } from "./device/probe";
import { LivePreviewController, LivePreviewDisconnectedError } from "./device/live-preview";
import { isLivePreviewSerial, isLivePreviewSessionId, type LivePreviewStopReason } from "../shared/live-preview";
import { diagnoseConnection } from "./automation/connection-diagnostics";
import { automationDiagnosticObservation, connectionDiagnosticRequest, type ConnectionDiagnosticReport } from "../shared/connection-diagnostics";
import { DebugSession } from "./automation/debug-session";
import { debugToolSchemas } from "../shared/debug-protocol";
import { clearLiveEndpoint, openLiveBridge } from "./automation/mcp-live";
import { clearSnapshots, loadSnapshots, saveSnapshot } from "./desktop/snapshot-store";
import { measureLayerImages } from "./desktop/layer-images";
import { isAppMenuState, renderApplicationMenu } from "./desktop/application-menu";
import { exportNodeImage, exportSnapshot } from "./desktop/export";
import { loadSnapshotFile } from "./desktop/snapshot-file";
import type { ImportSnapshotFileResult } from "../shared/snapshot-file";
import { loadTestReport } from "./desktop/test-report";
import type { ImportTestReportResult } from "../shared/test-report";
import { createDebugTaskTemplateStore } from "./desktop/debug-task-templates";
import type { DebugTaskTemplateImportResult, DebugTaskTemplateExportResult } from "../shared/debug-task-templates";
import { exportDebugReportEvidence } from "./desktop/debug-report-export";
import { debugReportExportRequestSchema, type DebugReportExportResult, type DebugReportExportImportResult } from "../shared/debug-report-export";
import { publishMcpSnapshot, readMcpSnapshot, revokeMcpSnapshot } from "./automation/mcp-snapshot";
import { isUiSnapshot } from "../shared/snapshot-validation";
import { isLayerMenuOptions } from "../shared/layer-context-menu";
import { renderLayerContextMenu } from "./desktop/layer-context-menu";
import { inspectionSingleAttempt, inspectionReadOnlyScope } from "../shared/inspection-policy";
import { visualCaptureFixture } from "./desktop/visual-capture-fixture";
import { mcpStopReasons, type McpStopSource } from "../shared/types";
import { changedLayerImages, layerImageBaseline, layerImageUpdates } from "../shared/tree-utils";
import { commitViewRefresh } from "./capture/view-refresh-commit";
import type { AppMenuState, DeviceInfo, LayerImageUpdate, LayerMenuAction, QmlGroupImage, UiNode, UiSnapshot, ViewRefreshResult } from "../shared/types";

const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const visualFixtureMode = process.argv.includes("--visual-fixture");
const visualCaptureLifecycle = process.argv.includes("--visual-capture-lifecycle");
if (visualFixtureMode && app.isPackaged) throw new Error("Visual fixture requires an unpackaged app");
if (visualCaptureLifecycle && (!visualFixtureMode || app.isPackaged)) throw new Error("Capture lifecycle fixture requires an unpackaged visual fixture");
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
const groupCaptures = new Map<number, { controller: AbortController; done: Promise<QmlGroupImage | null> }>();
const viewRefreshes = new Map<number, { controller: AbortController; done: Promise<ViewRefreshResult> }>();
const previews = new Map<number, LivePreviewController>();
const previewStarts = new Map<number, number>();
const previewCleanup = new Set<Promise<void>>();
const previewHolds = new Map<number, number>();
let previewStartRevision = 0;
const connectionDiagnoses = new Map<number, { requestId: string; controller: AbortController; done: Promise<ConnectionDiagnosticReport> }>();
let mcpRevision = 0;
const mcpSnapshotPath = () => join(app.getPath("userData"), "mcp", "current.json");
let debugSession: DebugSession | null = null;
let liveBridge: Awaited<ReturnType<typeof openLiveBridge>> | null = null;
let debugStarting = false;
const reportImports = new Map<number, "selecting" | "loading">();
const reportSources = new Map<number, { sourceId: string; filePath: string; reportSha256: string }>();
const reportSourceEpochs = new Map<number, number>();
const reportExports = new Map<number, { requestId: string; controller: AbortController; done: Promise<DebugReportExportResult> }>();
const debugTaskTemplates = createDebugTaskTemplateStore(join(app.getPath("userData"), "debug-task-templates.json"));
const taskLibraryTransfers = new Map<number, { controller: AbortController; done: Promise<DebugTaskTemplateImportResult | DebugTaskTemplateExportResult> }>();
let lastMenuState: AppMenuState | undefined;
function requireDesktopSender(event: Electron.IpcMainInvokeEvent) {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame)
    throw new Error("无效的桌面请求来源。");
}

function invalidateReportWork(owner: number) {
  reportSourceEpochs.set(owner, (reportSourceEpochs.get(owner) ?? 0) + 1);
  reportSources.delete(owner);
  reportExports.get(owner)?.controller.abort();
  taskLibraryTransfers.get(owner)?.controller.abort();
}

async function transferDebugTaskTemplates(event: Electron.IpcMainInvokeEvent, kind: "import" | "export") {
  requireDesktopSender(event);
  const owner = event.sender.id, epoch = reportSourceEpochs.get(owner) ?? 0;
  const canceled = (): DebugTaskTemplateImportResult | DebugTaskTemplateExportResult => kind === "import"
    ? { canceled: true, filePath: null, templates: [], fragments: [], imported: { templates: 0, fragments: 0 },
      skipped: { templates: [], fragments: [] }, error: null }
    : { canceled: true, filePath: null, templateCount: 0, fragmentCount: 0, error: null };
  const failed = (error: string) => ({ ...canceled(), canceled: false, error });
  if (quitting || event.sender.isDestroyed()) return canceled();
  if (taskLibraryTransfers.has(owner)) return failed("已有模板正在导入或导出，请完成或取消后再试。");
  const controller = new AbortController();
  const destroyed = () => controller.abort();
  let abortSelection = () => {};
  event.sender.once("destroyed", destroyed);
  const done = (async () => {
    try {
      const selection = kind === "import"
        ? dialog.showOpenDialog(mainWindow!, { title: "导入任务模板与复用片段", properties: ["openFile"],
          filters: [{ name: "任务模板 JSON", extensions: ["json"] }] })
        : dialog.showSaveDialog(mainWindow!, { title: "导出任务模板与复用片段", defaultPath: "debug-task-templates.json",
          filters: [{ name: "任务模板 JSON", extensions: ["json"] }] });
      // Navigation or quit must settle the request even if the native picker has not returned.
      const chosen = await Promise.race([selection, new Promise<Electron.OpenDialogReturnValue>(resolve => {
        abortSelection = () => resolve({ canceled: true, filePaths: [] });
        controller.signal.addEventListener("abort", abortSelection, { once: true });
        if (controller.signal.aborted) abortSelection();
      })]);
      const filePath = "filePaths" in chosen ? chosen.filePaths[0] : chosen.filePath;
      if (chosen.canceled || !filePath || controller.signal.aborted || quitting || event.sender.isDestroyed()
        || epoch !== (reportSourceEpochs.get(owner) ?? 0)) return canceled();
      requireDesktopSender(event);
      return kind === "import" ? await debugTaskTemplates.importFile(filePath, controller.signal)
        : await debugTaskTemplates.exportFile(filePath, controller.signal);
    } catch (error) {
      return controller.signal.aborted ? canceled() : failed(error instanceof Error && error.name !== "ZodError"
        ? error.message : "模板文件操作失败，原有内容已保留。");
    }
  })();
  taskLibraryTransfers.set(owner, { controller, done });
  try { return await done; }
  finally {
    event.sender.removeListener("destroyed", destroyed);
    controller.signal.removeEventListener("abort", abortSelection);
    if (taskLibraryTransfers.get(owner)?.controller === controller) taskLibraryTransfers.delete(owner);
  }
}

async function loadDesktopReport(event: Electron.IpcMainInvokeEvent, file: string): Promise<DebugReportExportImportResult> {
  const owner = event.sender.id, epoch = reportSourceEpochs.get(owner) ?? 0;
  const report = await loadTestReport(file);
  const filePath = report.debug ? await realpath(file) : null;
  requireDesktopSender(event);
  if (quitting || event.sender.isDestroyed() || epoch !== (reportSourceEpochs.get(owner) ?? 0)) throw new Error("报告窗口已更新，请重新读取报告。");
  reportExports.get(owner)?.controller.abort();
  reportSources.delete(owner);
  if (!filePath) return { canceled: false, report, error: null };
  const sourceId = randomUUID();
  reportSources.set(owner, { sourceId, filePath, reportSha256: report.index.reportSha256 });
  return { canceled: false, report, error: null, exportSourceId: sourceId };
}

function previewFor(sender: Electron.WebContents) {
  let preview = previews.get(sender.id);
  if (!preview) {
    let fixtureFrame = 0;
    preview = new LivePreviewController({
      isBusy: () => inspections.size > 0 || groupCaptures.size > 0 || viewRefreshes.size > 0
        || connectionDiagnoses.size > 0 || previewHolds.size > 0 || debugStarting || Boolean(debugSession?.hasPendingWork),
      ...(visualFixtureMode ? { capture: async (serial: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        if (serial !== "visual-fixture" || visualFixtureState !== "connected") throw new LivePreviewDisconnectedError("合成设备未连接。");
        const svg = readFileSync(join(app.getAppPath(), "tests", "fixtures", "visual-screen.svg"), "utf8")
          .replace("</svg>", `<text x="40" y="2200" fill="white" font-size="40">Preview ${++fixtureFrame}</text></svg>`);
        return { screenshotDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, size: { width: 1080, height: 2400 } };
      } } : {}),
      onEvent: update => { if (!sender.isDestroyed()) sender.send("live-preview-event", update); },
    });
    previews.set(sender.id, preview);
  }
  return preview;
}

function disposePreview(owner: number, reason: LivePreviewStopReason) {
  previewStarts.delete(owner);
  const preview = previews.get(owner);
  previews.delete(owner);
  if (!preview) return Promise.resolve();
  const done = preview.dispose(reason).finally(() => previewCleanup.delete(done));
  previewCleanup.add(done);
  return done;
}

async function withPreviewHeld<T>(owner: number, action: () => Promise<T>): Promise<T> {
  previewHolds.set(owner, (previewHolds.get(owner) ?? 0) + 1);
  try { await previews.get(owner)?.yieldForCapture(); return await action(); }
  finally {
    const remaining = (previewHolds.get(owner) ?? 1) - 1;
    if (remaining) previewHolds.set(owner, remaining); else previewHolds.delete(owner);
  }
}
function stopMcpSharing(reason = "界面请求停止自动调试") {
  mcpRevision++;
  debugSession?.stop(reason);
  liveBridge?.close(); liveBridge = null;
  clearLiveEndpoint(mcpSnapshotPath());
  revokeMcpSnapshot(mcpSnapshotPath());
}

function updateApplicationMenu(state?: AppMenuState) {
  lastMenuState = state;
  renderApplicationMenu(state, Boolean(debugSession?.state.active), debugStarting, action => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app-menu-action", action);
  });
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
      invalidateReportWork(windowId);
      connectionDiagnoses.get(windowId)?.controller.abort();
      void disposePreview(windowId, "window-reloaded");
      stopMcpSharing("窗口重新加载，停止自动调试");
      groupCaptures.get(windowId)?.controller.abort();
      groupCaptures.delete(windowId);
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
    invalidateReportWork(windowId);
    connectionDiagnoses.get(windowId)?.controller.abort();
    void disposePreview(windowId, "window-closed");
    groupCaptures.get(windowId)?.controller.abort();
    groupCaptures.delete(windowId);
    viewRefreshes.get(windowId)?.controller.abort();
    viewRefreshes.delete(windowId);
    liveSessions.delete(windowId);
    if (mainWindow === window) { stopMcpSharing("窗口关闭，停止自动调试"); mainWindow = null; updateApplicationMenu(); }
  });
}

ipcMain.handle("probe-adb", () => visualFixtureMode ? fixtureProbe() : probeAdb());
ipcMain.handle("diagnose-connection", async (event, input: unknown) => {
  requireDesktopSender(event);
  const request = { ...connectionDiagnosticRequest.parse(input), client: "desktop" as const };
  const owner = event.sender.id;
  const previous = connectionDiagnoses.get(owner);
  previous?.controller.abort();
  const controller = new AbortController();
  const destroyed = () => controller.abort();
  event.sender.once("destroyed", destroyed);
  const done = (async () => {
    await previous?.done.catch(() => undefined);
    return withPreviewHeld(owner, () => diagnoseConnection(request, {
      signal: controller.signal,
      automationConnection: (_signal, observedPackageName) => {
        let shared = false;
        try { shared = Boolean(readMcpSnapshot(mcpSnapshotPath())); } catch { /* No current share. */ }
        return automationDiagnosticObservation({ shared, session: liveBridge ? debugSession?.state ?? null : null,
          serial: request.serial, packageName: observedPackageName ?? request.packageName });
      },
      ...(visualFixtureMode ? {
        probe: fixtureProbe,
        command: async (_path: string, _serial: string, args: string[]) => {
          const command = args.join(" ");
          const output = command.includes("dumpsys window policy") ? "mShowingLockscreen=false"
            : command.includes("dumpsys activity activities") ? "mResumedActivity: ActivityRecord{abcdef u0 com.example.sanitized/.Main t1}"
            : command.includes("run-as") ? "uid=10000(com.example.sanitized)" : command.includes("enabled_accessibility_services") ? "null" : "No SDK Provider in fixture";
          return { code: 0, stdout: Buffer.from(output), stderr: "" };
        },
        focus: async () => ({ id: "fixture", packageName: "com.example.sanitized" }),
      } : {}),
    }));
  })();
  connectionDiagnoses.set(owner, { requestId: request.requestId, controller, done });
  try { return await done; }
  finally {
    event.sender.removeListener("destroyed", destroyed);
    if (connectionDiagnoses.get(owner)?.controller === controller) connectionDiagnoses.delete(owner);
  }
});
ipcMain.handle("cancel-connection-diagnosis", (event, requestId: unknown) => {
  requireDesktopSender(event);
  if (typeof requestId !== "string" || requestId.length > 128) throw new Error("诊断请求标识无效。");
  const current = connectionDiagnoses.get(event.sender.id);
  if (current?.requestId === requestId) current.controller.abort();
});
ipcMain.handle("live-preview-start", async (event, serial: unknown) => {
  requireDesktopSender(event);
  if (!isLivePreviewSerial(serial)) throw new Error("预览设备无效。");
  const revision = ++previewStartRevision;
  previewStarts.set(event.sender.id, revision);
  try {
    const probe = visualFixtureMode ? await fixtureProbe() : await probeAdb();
    if (previewStarts.get(event.sender.id) !== revision || event.sender.isDestroyed()) throw new Error("预览开启已取消。");
    if (probe.error || !probe.devices.some(device => device.serial === serial && device.state === "device"))
      throw new Error("设备未连接或未授权，无法开启预览。");
    return await previewFor(event.sender).start(serial);
  } finally { if (previewStarts.get(event.sender.id) === revision) previewStarts.delete(event.sender.id); }
});
for (const operation of ["pause", "resume"] as const) ipcMain.handle(`live-preview-${operation}`, (event, sessionId: unknown) => {
  requireDesktopSender(event);
  if (!isLivePreviewSessionId(sessionId)) throw new Error("预览会话无效。");
  return previewFor(event.sender)[operation](sessionId);
});
ipcMain.handle("live-preview-stop", (event, sessionId: unknown) => {
  requireDesktopSender(event);
  if (sessionId !== undefined && !isLivePreviewSessionId(sessionId)) throw new Error("预览会话无效。");
  if (sessionId === undefined) previewStarts.delete(event.sender.id);
  return previewFor(event.sender).stop("closed", sessionId);
});
ipcMain.handle("live-preview-state", event => { requireDesktopSender(event); return previewFor(event.sender).getEvent(); });
ipcMain.handle("inspect-device", async (event, serial: unknown, requestId: unknown, priorityViewRef: unknown, singleAttempt: unknown, scope: unknown) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的采集来源。");
  if (typeof serial !== "string" || !serial.trim()) {
    throw new Error("设备序列号不能为空。");
  }
  if (typeof requestId !== "string" || !requestId || requestId.length > 128) throw new Error("采集请求标识无效。");
  if (priorityViewRef !== undefined && priorityViewRef !== null
      && (typeof priorityViewRef !== "string" || priorityViewRef.length > 256 || !/^[\w.$]+@[0-9a-f]{1,8}$/i.test(priorityViewRef))) {
    throw new Error("优先采集控件标识无效。");
  }
  const captureSingleAttempt = inspectionSingleAttempt(singleAttempt);
  const readOnlyScope = inspectionReadOnlyScope(scope, captureSingleAttempt);
  if (readOnlyScope && (inspections.has(event.sender.id) || groupCaptures.has(event.sender.id)
      || viewRefreshes.has(event.sender.id) || debugStarting || debugSession?.state.active)) {
    throw new Error("已有采集或自动调试正在运行，请结束后再做只读诊断。");
  }
  stopMcpSharing("开始手动采集，停止自动调试");
  const sender = event.sender;
  const ownerId = sender.id;
  const previous = inspections.get(ownerId);
  const previousGroup = groupCaptures.get(ownerId);
  const previousView = viewRefreshes.get(ownerId);
  previousGroup?.controller.abort();
  previousView?.controller.abort();
  liveSessions.delete(ownerId);
  previous?.controller.abort();
  const controller = new AbortController();
  const deadline = readOnlyScope ? setTimeout(() => controller.abort(new Error("只读诊断超过30秒，已停止；不会自动重试。")), 30_000) : null;
  let previewImages: Map<string, LayerImageUpdate> | null = null;
  const onDestroyed = () => controller.abort();
  sender.once("destroyed", onDestroyed);
  const done = (async () => {
    // Release the previous debugger/port before starting another capture.
    await previous?.done.catch(() => undefined);
    await previousGroup?.done.catch(() => undefined);
    await previousView?.done.catch(() => undefined);
    await previews.get(ownerId)?.yieldForCapture();
    await debugSession?.settled();
    controller.signal.throwIfAborted();
    const captureOptions = {
      signal: controller.signal,
      singleAttempt: captureSingleAttempt,
      ...(readOnlyScope ? { expectedPackage: readOnlyScope.expectedPackage, allowAppRestart: false } : {}),
      priorityViewRef: typeof priorityViewRef === "string" ? priorityViewRef : undefined,
      onProgress: (stage: string, elapsedMs: number) => {
        if (!sender.isDestroyed() && !controller.signal.aborted) sender.send("inspection-progress", { requestId, stage, elapsedMs });
      },
      onPreview: (phase: "tree" | "layers", snapshot: UiSnapshot) => {
        if (sender.isDestroyed() || controller.signal.aborted || !snapshot.root) return;
        const updates = phase === "layers" && previewImages ? changedLayerImages(snapshot.root, previewImages) : null;
        if (updates) {
          if (updates.length) sender.send("inspection-preview", { requestId, phase: "layers", updates });
          return;
        }
        // The tree changed shape since the baseline was taken (fresh read or SDK adoption), so
        // there is nothing to diff. Re-anchor on the new tree and still forward every current
        // image: otherwise a partial batch would only repaint the tree and the images that
        // arrived with it would never flow into the layer pipeline.
        previewImages = layerImageBaseline(snapshot.root);
        sender.send("inspection-preview", { requestId, phase: "tree", snapshot });
        const images = layerImageUpdates(snapshot.root);
        if (images.length) sender.send("inspection-preview", { requestId, phase: "layers", updates: images });
      },
    };
    const snapshot = visualFixtureMode ? visualCaptureLifecycle ? await visualCaptureFixture(fixtureSnapshot(serial), requestId, {
      solid: nativeImage.createFromBitmap(Buffer.from(Array(32 * 32).fill([255, 128, 48, 255]).flat()), { width: 32, height: 32 }).toDataURL(),
      empty: nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4), { width: 32, height: 32 }).toDataURL(),
    }, captureOptions) : fixtureSnapshot(serial) : await inspectPreferredDevice(serial, captureOptions);
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
  catch (error) { controller.signal.throwIfAborted(); throw error; }
  finally {
    if (deadline) clearTimeout(deadline);
    sender.removeListener("destroyed", onDestroyed);
    if (inspections.get(ownerId)?.controller === controller) inspections.delete(ownerId);
  }
});
ipcMain.handle("capture-group", async (event, requestId: unknown, nodeId: unknown) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的抓图来源。");
  if (typeof requestId !== "string" || requestId.length > 128 || typeof nodeId !== "string" || !/^0(?:\/\d+)*$/.test(nodeId) || nodeId.length > 600) return null;
  const ownerId = event.sender.id;
  const session = liveSessions.get(ownerId);
  const source = session?.snapshot.inspectionSource;
  if (!session || (source !== "debug-qml" && source !== "debug-hybrid") || session.requestId !== requestId
      || inspections.has(ownerId) || viewRefreshes.has(ownerId) || debugSession?.state.busy) return null;
  const previous = groupCaptures.get(ownerId);
  previous?.controller.abort();
  const controller = new AbortController();
  const done = (async () => {
    await previous?.done.catch(() => undefined);
    controller.signal.throwIfAborted();
    return withPreviewHeld(ownerId, () => source === "debug-qml"
      ? captureQmlGroupImage(session.snapshot.serial, session.snapshot, nodeId, controller.signal)
      : captureViewGroupImage(session.snapshot.serial, session.snapshot, nodeId, controller.signal));
  })();
  groupCaptures.set(ownerId, { controller, done });
  try { return await done; }
  catch { return null; }
  finally { if (groupCaptures.get(ownerId)?.controller === controller) groupCaptures.delete(ownerId); }
});
ipcMain.handle("refresh-view-node", async (event, requestId: unknown, nodeId: unknown, scope: unknown = "node") => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的抓图来源。");
  if (typeof requestId !== "string" || requestId.length > 128 || typeof nodeId !== "string" || !/^0(?:\/\d+)*$/.test(nodeId) || nodeId.length > 600)
    throw new Error("控件标识无效。");
  if (scope !== "node" && scope !== "branch" && scope !== "list") throw new Error("刷新范围无效。");
  const ownerId = event.sender.id;
  const session = liveSessions.get(ownerId);
  if (!session || (session.snapshot.inspectionSource !== "debug-view" && session.snapshot.inspectionSource !== "debug-hybrid")
      || session.requestId !== requestId || inspections.has(ownerId) || debugSession?.state.active)
    throw new Error("当前快照已失效，请重新采集页面。");
  const previous = viewRefreshes.get(ownerId);
  previous?.controller.abort();
  groupCaptures.get(ownerId)?.controller.abort();
  const controller = new AbortController();
  const done = (async () => {
    await previous?.done.catch(() => undefined);
    await previews.get(ownerId)?.yieldForCapture();
    controller.signal.throwIfAborted();
    const result = scope === "list"
      ? await captureListViewItems(session.snapshot.serial, session.snapshot, nodeId, controller.signal)
      : await captureViewNodes(session.snapshot.serial, session.snapshot, nodeId, scope === "branch", controller.signal);
    controller.signal.throwIfAborted();
    commitViewRefresh(session, liveSessions.get(ownerId), nodeId, result, controller.signal);
    return result;
  })();
  viewRefreshes.set(ownerId, { controller, done });
  try { return await done; }
  finally { if (viewRefreshes.get(ownerId)?.controller === controller) viewRefreshes.delete(ownerId); }
});
ipcMain.handle("read-view-style", async (event, requestId: unknown, nodeId: unknown) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的样式请求来源。");
  if (typeof requestId !== "string" || requestId.length > 128 || typeof nodeId !== "string" || !/^0(?:\/\d+)*$/.test(nodeId) || nodeId.length > 600)
    throw new Error("控件标识无效。");
  const ownerId = event.sender.id;
  const session = liveSessions.get(ownerId);
  if (!session || session.requestId !== requestId || session.snapshot.inspectionSource !== "debug-hybrid"
      || inspections.has(ownerId) || viewRefreshes.has(ownerId) || debugSession?.state.active)
    throw new Error("当前快照已失效或正在刷新，请稍后重试。");
  const source = session.snapshot;
  const style = await withPreviewHeld(ownerId, () => captureViewStyle(source.serial, source, nodeId));
  if (liveSessions.get(ownerId) !== session || session.snapshot !== source) throw new Error("读取期间快照已更新，请重新读取样式。");
  return style;
});
ipcMain.handle("cancel-inspection", (event, requestId: unknown) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的取消来源。");
  const active = inspections.get(event.sender.id);
  if (typeof requestId === "string" && active?.requestId === requestId) active.controller.abort();
  const live = liveSessions.get(event.sender.id);
  if (typeof requestId === "string" && live?.requestId === requestId) {
    viewRefreshes.get(event.sender.id)?.controller.abort();
    groupCaptures.get(event.sender.id)?.controller.abort();
    liveSessions.delete(event.sender.id);
  }
});
ipcMain.handle("layer-context-menu", (event, canHide: unknown, canRestore: unknown, canExitFocus: unknown, options?: unknown) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的图层菜单来源。");
  if ([canHide, canRestore, canExitFocus].some(value => typeof value !== "boolean")) throw new Error("图层菜单参数无效。");
  if (options !== undefined && !isLayerMenuOptions(options)) throw new Error("图层菜单参数无效。");
  const details = options;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return null;
  return new Promise<LayerMenuAction>((resolve) => {
    Menu.buildFromTemplate(renderLayerContextMenu(canHide === true, canRestore === true, canExitFocus === true, details, resolve)).popup({ window, callback: () => resolve(null) });
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
ipcMain.handle("mcp-stop", (event, source: unknown) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的共享来源。");
  if (source !== undefined && (typeof source !== "string" || !Object.prototype.hasOwnProperty.call(mcpStopReasons, source))) throw new Error("无效的停止来源。");
  stopMcpSharing(mcpStopReasons[(source ?? "explicit") as McpStopSource]);
});
ipcMain.handle("mcp-config", event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的配置来源。");
  const script = app.isPackaged ? join(process.resourcesPath, "mcp", "server.cjs") : join(app.getAppPath(), "dist-electron", "mcp.cjs");
  return clipboard.writeText(JSON.stringify({ mcpServers: { "android-ui-inspector": { command: "node", args: [script], env: { ANDROID_UI_INSPECTOR_MCP_SNAPSHOT: mcpSnapshotPath() } } } }, null, 2));
});

ipcMain.handle("debug-start", async (event, serial: unknown, options: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的调试来源。");
  if (typeof serial !== "string" || !/^[\w.:-]{1,256}$/.test(serial)) throw new Error("设备无效。");
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some(key => key !== "androidLogs")
      || ((options as { androidLogs?: unknown }).androidLogs !== undefined && typeof (options as { androidLogs?: unknown }).androidLogs !== "boolean")))
    throw new Error("调试日志选项无效。");
  const androidLogs = (options as { androidLogs?: boolean } | undefined)?.androidLogs === true;
  if (debugStarting || debugSession?.state.active || inspections.size) throw new Error("请先结束当前采集或调试。");
  debugStarting = true;
  const revision = ++mcpRevision;
  updateApplicationMenu(lastMenuState);
  const fixtureTarget = { packageName: "com.example.sanitized", component: "com.example.sanitized/.Main", activityName: ".Main", windowId: "fixture", activityRecordId: "fixture-activity" };
  try {
    await debugSession?.settled();
    await previews.get(event.sender.id)?.yieldForCapture();
    const target = visualFixtureMode ? fixtureTarget : await getDebugTarget(serial);
    if (revision !== mcpRevision || event.sender.isDestroyed()) return null;
    const answer = await dialog.showMessageBox(mainWindow, {
      type: "warning", title: "开启自动 UI 调试？", message: `允许 AI 观察并操作 ${target.packageName}？`,
      detail: `设备：${serial}\n本次授权最长 30 分钟，只允许当前 Debug App。AI 可反复采集文本、截图、独立图层（含隐藏节点），点击控件、滚动列表、返回上一页；操作可能改变 App 数据，返回可能丢弃编辑或离开 App。请只测试安全的页面，支付、删除、发送、丢弃编辑等操作需另行确认。\n接入云端 AI 时页面数据可能发送到模型服务。步骤记录、前后截图与控件属性保存在本机，并设保存上限。${androidLogs ? "本次另保存目标 App 在步骤时间段内的有限 Android 错误日志。" : ""}可随时点击“立即停止”；已发出的操作无法撤回。不会自动重启 App、执行任意命令或修改源码。`,
      buttons: ["取消", "授权本次调试"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (answer.response !== 1 || revision !== mcpRevision || event.sender.isDestroyed()) return null;
    if (!visualFixtureMode) await getDebugTarget(serial, target.packageName);
    if (revision !== mcpRevision || event.sender.isDestroyed()) return null;
    revokeMcpSnapshot(mcpSnapshotPath());
    const session = new DebugSession({ serial, packageName: target.packageName, snapshotPath: mcpSnapshotPath(),
      directory: join(app.getPath("userData"), "mcp", "runs"), androidLogs,
      observe: async (device, packageName, mode, signal, backend) => {
        await previews.get(event.sender.id)?.yieldForCapture();
        signal?.throwIfAborted();
        if (visualFixtureMode && backend === "accessibility-helper") throw new Error("合成页面没有连接 Helper。");
        const result = visualFixtureMode
          ? { snapshot: { ...fixtureSnapshot(device), captureMode: mode }, target: fixtureTarget }
          : await observeDebugApp(device, packageName, mode, signal, backend);
        if (mode === "deep") await measureLayerImages(result.snapshot.root, signal);
        return result;
      },
      ...(visualFixtureMode ? { input: async () => undefined,
        logExecute: async () => { throw new Error("合成设备没有 Android 日志，未采集手机日志。"); } } : {}),
      onEvent: update => {
        if (!update.state.active) { liveBridge?.close(); liveBridge = null; }
        if (!event.sender.isDestroyed()) event.sender.send("debug-session-event", update);
        updateApplicationMenu(lastMenuState);
      },
    });
    debugSession = session;
    try {
      const bridge = await openLiveBridge(mcpSnapshotPath(), (command, signal) => session.request(command, signal));
      if (revision !== mcpRevision || event.sender.isDestroyed() || !session.state.active) { bridge.close(); session.stop("建立授权期间已取消"); return null; }
      liveBridge = bridge;
      event.sender.send("debug-session-event", { state: session.state });
      return session.state;
    } catch (error) { session.stop("调试连接建立失败"); throw error; }
  } finally { debugStarting = false; updateApplicationMenu(lastMenuState); }
});
ipcMain.handle("debug-state", event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的调试来源。");
  return debugSession?.state ?? null;
});
ipcMain.handle("debug-task-templates-load", event => { requireDesktopSender(event); return debugTaskTemplates.load(); });
ipcMain.handle("debug-task-template-save", (event, input: unknown) => { requireDesktopSender(event); return debugTaskTemplates.save(input); });
ipcMain.handle("debug-task-template-delete", (event, id: unknown) => { requireDesktopSender(event); return debugTaskTemplates.remove(id); });
ipcMain.handle("debug-task-fragments-load", event => { requireDesktopSender(event); return debugTaskTemplates.loadFragments(); });
ipcMain.handle("debug-task-fragment-save", (event, input: unknown) => { requireDesktopSender(event); return debugTaskTemplates.saveFragment(input); });
ipcMain.handle("debug-task-fragment-delete", (event, id: unknown) => { requireDesktopSender(event); return debugTaskTemplates.removeFragment(id); });
ipcMain.handle("debug-task-templates-import", event => transferDebugTaskTemplates(event, "import"));
ipcMain.handle("debug-task-templates-export", event => transferDebugTaskTemplates(event, "export"));
ipcMain.handle("debug-task-define", async (event, input: unknown) => {
  requireDesktopSender(event);
  const request = debugToolSchemas.define_debug_task.parse(input);
  const session = debugSession;
  if (!session || session.state.id !== request.sessionId || !session.state.active)
    throw new Error("会话已结束或不匹配，请在桌面重新授权。");
  if (debugStarting || inspections.size || groupCaptures.size || viewRefreshes.size || connectionDiagnoses.size || session.hasPendingWork)
    throw new Error("请等待当前采集或调试完成。");
  return withPreviewHeld(event.sender.id, () => session.request({ name: "define_debug_task", input: request }));
});
ipcMain.handle("debug-task-check", async (event, input: unknown) => {
  requireDesktopSender(event);
  const request = debugToolSchemas.check_debug_task.parse(input);
  const session = debugSession;
  if (!session || session.state.id !== request.sessionId || !session.state.active)
    throw new Error("会话已结束或不匹配，请在桌面重新授权。");
  if (debugStarting || inspections.size || groupCaptures.size || viewRefreshes.size || connectionDiagnoses.size || session.hasPendingWork)
    throw new Error("请等待当前采集或调试完成。");
  return withPreviewHeld(event.sender.id, () => session.request({ name: "check_debug_task", input: request }));
});
ipcMain.handle("debug-open-evidence", async event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的调试来源。");
  if (!debugSession?.state.evidencePath) throw new Error("还没有失败证据。");
  const error = await shell.openPath(dirname(debugSession.state.evidencePath));
  if (error) throw new Error(error);
});
ipcMain.handle("load-debug-report", async event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的报告来源。");
  const owner = event.sender.id;
  if (reportImports.has(owner)) return { canceled: false, report: null, error: "已有报告导入尚未完成，请完成或取消后再试。" };
  const file = debugSession?.state.reportPath;
  if (!file) return { canceled: false, report: null, error: "还没有调试记录，请先完成一次已授权的调试观察。" };
  reportImports.set(owner, "loading");
  try { return await loadDesktopReport(event, file); }
  catch (error) { return { canceled: false, report: null, error: error instanceof Error && error.name !== "ZodError" ? error.message : "调试记录格式无效，未载入。" }; }
  finally { reportImports.delete(owner); }
});
ipcMain.handle("export-debug-report-evidence", async (event, input: unknown): Promise<DebugReportExportResult> => {
  requireDesktopSender(event);
  const request = debugReportExportRequestSchema.parse(input);
  const owner = event.sender.id, source = reportSources.get(owner);
  const canceled = (): DebugReportExportResult => ({ canceled: true, directory: null, error: null, stepCount: 0, warnings: [] });
  const failed = (error: string): DebugReportExportResult => ({ canceled: false, directory: null, error, stepCount: 0, warnings: [] });
  if (!source || source.sourceId !== request.sourceId || source.reportSha256 !== request.reportSha256)
    return failed("报告来源已失效，请重新载入后导出。");
  if (reportExports.has(owner)) return failed("已有证据正在导出，请完成或取消后再试。");
  const controller = new AbortController();
  const done = (async () => {
    try {
      const chosen = await dialog.showOpenDialog(mainWindow!, { title: "选择调试证据的保存位置", properties: ["openDirectory", "createDirectory"] });
      if (controller.signal.aborted || event.sender.isDestroyed() || chosen.canceled || !chosen.filePaths[0]) return canceled();
      requireDesktopSender(event);
      if (reportSources.get(owner) !== source) return failed("报告已更新，请从当前报告重新导出。");
      return await exportDebugReportEvidence(source, request, chosen.filePaths[0], { appVersion: app.getVersion(), signal: controller.signal });
    } catch (error) {
      return controller.signal.aborted ? canceled() : failed(error instanceof Error && error.name !== "ZodError" ? error.message : "导出证据失败。");
    }
  })();
  reportExports.set(owner, { requestId: request.requestId, controller, done });
  try { return await done; }
  finally { if (reportExports.get(owner)?.controller === controller) reportExports.delete(owner); }
});
ipcMain.handle("cancel-debug-report-export", (event, requestId: unknown) => {
  requireDesktopSender(event);
  if (typeof requestId !== "string" || requestId.length > 128 || !/^[\w-]+$/.test(requestId)) throw new Error("导出请求编号无效。");
  const pending = reportExports.get(event.sender.id);
  if (pending?.requestId === requestId) pending.controller.abort();
});
ipcMain.handle("export-snapshot", (_event, input: unknown) => exportSnapshot(input, mainWindow));
ipcMain.handle("output-node-image", (event, input: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的控件图片来源。");
  return exportNodeImage(input, mainWindow);
});
const snapshotFileImports = new Set<number>();
ipcMain.handle("import-snapshot-file", async (event): Promise<ImportSnapshotFileResult> => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的快照导入来源。");
  const owner = event.sender.id;
  if (snapshotFileImports.has(owner)) return { canceled: false, filePath: null, data: null, error: "已有快照正在打开，请完成或取消文件选择后再试。" };
  snapshotFileImports.add(owner);
  try {
    const chosen = await dialog.showOpenDialog(mainWindow!, { title: "打开离线快照", properties: ["openFile"], filters: [{ name: "完整快照或旧版控件树 JSON", extensions: ["json"] }] });
    if (chosen.canceled || !chosen.filePaths[0]) return { canceled: true, filePath: null, data: null, error: null };
    const filePath = chosen.filePaths[0];
    return { canceled: false, filePath, data: await loadSnapshotFile(filePath), error: null };
  } catch (error) { return { canceled: false, filePath: null, data: null, error: error instanceof Error ? error.message : "快照文件无法打开。" }; }
  finally { snapshotFileImports.delete(owner); }
});
ipcMain.handle("load-snapshots", () => loadSnapshots());
ipcMain.handle("import-test-report", async event => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的报告导入来源。");
  const owner = event.sender.id, epoch = reportSourceEpochs.get(event.sender.id) ?? 0;
  const pendingImport = reportImports.get(owner);
  if (pendingImport) return { canceled: false, report: null, error: pendingImport === "selecting"
    ? "已有报告导入尚未完成：文件选择尚未返回。请完成或取消选择后再试。"
    : "已有报告导入尚未完成：正在读取本地报告。如有系统权限提示，请先完成确认。" };
  reportImports.set(owner, "selecting");
  try {
    const chosen = await dialog.showOpenDialog(mainWindow!, { title: "导入本地测试或调试报告", properties: ["openFile"], filters: [{ name: "报告 index.json 或调试 report.json", extensions: ["json"] }] });
    if (chosen.canceled || !chosen.filePaths[0]) return { canceled: true, report: null, error: null };
    requireDesktopSender(event);
    if (quitting || event.sender.isDestroyed() || epoch !== (reportSourceEpochs.get(owner) ?? 0))
      return { canceled: true, report: null, error: null };
    reportImports.set(owner, "loading");
    return await loadDesktopReport(event, chosen.filePaths[0]);
  }
  catch (error) { return { canceled: false, report: null, error: error instanceof Error && error.name !== "ZodError" ? error.message : "报告格式无效，请选择测试 summary/index.json 或调试记录 report.json。" }; }
  finally { reportImports.delete(owner); }
});
ipcMain.handle("import-comparison-report", async (event): Promise<ImportTestReportResult> => {
  requireDesktopSender(event);
  const owner = event.sender.id, epoch = reportSourceEpochs.get(owner) ?? 0;
  const canceled = (): ImportTestReportResult => ({ canceled: true, report: null, error: null });
  if (quitting || event.sender.isDestroyed()) return canceled();
  if (reportImports.has(owner) || reportExports.has(owner))
    return { canceled: false, report: null, error: "已有报告正在读取或导出，请完成或取消后再对比。" };
  reportImports.set(owner, "selecting");
  try {
    const chosen = await dialog.showOpenDialog(mainWindow!, { title: "选择另一份调试报告进行对比", properties: ["openFile"],
      filters: [{ name: "调试 report.json", extensions: ["json"] }] });
    if (chosen.canceled || !chosen.filePaths[0] || quitting || event.sender.isDestroyed()
      || epoch !== (reportSourceEpochs.get(owner) ?? 0)) return canceled();
    requireDesktopSender(event);
    reportImports.set(owner, "loading");
    const report = await loadTestReport(chosen.filePaths[0]);
    if (quitting || event.sender.isDestroyed() || epoch !== (reportSourceEpochs.get(owner) ?? 0)) return canceled();
    requireDesktopSender(event);
    return { canceled: false, report, error: null };
  } catch (error) {
    return { canceled: false, report: null, error: error instanceof Error && error.name !== "ZodError"
      ? error.message : "对比报告格式无效，请选择调试记录 report.json。" };
  } finally { reportImports.delete(owner); }
});
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
  stopMcpSharing("程序退出，停止自动调试");
  closeProviderSessions();
  const diagnoses = [...connectionDiagnoses.values()];
  for (const diagnosis of diagnoses) diagnosis.controller.abort();
  const exports = [...reportExports.values()];
  for (const pending of exports) pending.controller.abort();
  const transfers = [...taskLibraryTransfers.values()];
  for (const pending of transfers) pending.controller.abort();
  reportSources.clear();
  for (const owner of previews.keys()) void disposePreview(owner, "app-quit");
  const captures = [...inspections.values()];
  for (const capture of captures) capture.controller.abort();
  const groups = [...groupCaptures.values()];
  for (const group of groups) group.controller.abort();
  const debugCleanup = debugSession?.hasPendingWork ? debugSession.settled() : null;
  if (captures.length || groups.length || diagnoses.length || exports.length || transfers.length || previewCleanup.size || debugCleanup) {
    event.preventDefault();
    void Promise.allSettled([...captures.map((capture) => capture.done), ...groups.map((group) => group.done),
      ...diagnoses.map(diagnosis => diagnosis.done), ...exports.map(pending => pending.done), ...transfers.map(pending => pending.done),
      ...previewCleanup, ...(debugCleanup ? [debugCleanup] : [])]).then(() => app.quit());
  }
});
