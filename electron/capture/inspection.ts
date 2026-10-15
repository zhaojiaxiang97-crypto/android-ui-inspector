import { setTimeout as wait } from "node:timers/promises";
import type { UiNode, UiSnapshot } from "../../shared/types";
import { assessCaptureGeometry } from "../../shared/screen-coordinates";
import { recordCaptureAttempt } from "../../shared/capture-attempts";
import { createCaptureReadiness } from "../../shared/capture-readiness";
import { adoptSdkTree, joinSdkTreeAndDebugImages } from "../sdk/sdk-hybrid";
import { StartupRetryBudgetError, startupRetryBudget } from "./startup-retry-budget";
import { type InspectionOptions, type InspectionPreview } from "./types";
import { runDeviceAdb, findAdbPath, commandError, captureSignal } from "../device/runtime";
import { automationAdb, checkedDebugTarget, singleAppPid, foregroundTarget, targetActivitySection, sameActivityInstance, type DebugTarget, readDebugFocus, FocusUnavailableError } from "../device/target";
import { readSdkCapture } from "./sdk-images";
import { countNodes, hasActivityHierarchy, activityTreeReadinessReason, appBounds, debugViewTree } from "./native-tree";
import { applyVerifiedSdkViewTypes, layerCaptureFailureWarning } from "./layer-images";
import { windowAcceleration } from "../sdk/capture-protocol";
import type { ProviderClient } from "../sdk/provider-session";
import { captureScreen } from "../device/screen";
import { qmlDebugTree, qmlUiTree } from "./qt";
import { STARTUP_IMAGE_TIMEOUT_MS, IMAGE_TIMEOUT_MS, PREVIEW_SCREEN_TIMEOUT_MS, captureDebugViewImages, FINAL_SCREEN_TIMEOUT_MS } from "./debug-images";

import { withCommandSignal } from "../device/command-context";
import { createCaptureRunContext, createCaptureAttemptContext, withCaptureSignal, type CaptureRunContext } from "./run-context";
import { CaptureError, classifyCaptureFailure, shouldRetryCapture, startupImageFailure, type CaptureFailure } from "./capture-errors";
import { verifySdkTreeIdentity, type VerifiedSdkTree } from "./sdk-tree-verification";

const APP_READY_TIMEOUT_MS = 18_000;
const APP_READY_MIN_READ_MS = 1_500;
const STARTUP_RETRY_TIMEOUT_MS = 45_000;
const STARTUP_RETRY_DELAY_MS = 2_000;

function errorSnapshot(serial: string, error: string): UiSnapshot {
  return {
    serial,
    root: null,
    nodeCount: 0,
    xmlSize: 0,
    rawXml: null,
    screenshotDataUrl: null,
    error,
    warning: null,
  };
}

export type InspectionPorts = {
  runDeviceAdb: typeof runDeviceAdb;
  findAdbPath: typeof findAdbPath;
  commandError: typeof commandError;
  captureScreen: typeof captureScreen;
  captureDebugViewImages: typeof captureDebugViewImages;
  qmlDebugTree: typeof qmlDebugTree;
  checkedDebugTarget: typeof checkedDebugTarget;
  singleAppPid: typeof singleAppPid;
  readDebugFocus: typeof readDebugFocus;
  automationAdb: typeof automationAdb;
  readSdkCapture: typeof readSdkCapture;
};
const productionPorts: InspectionPorts = { runDeviceAdb, findAdbPath, commandError, captureScreen, captureDebugViewImages,
  qmlDebugTree, checkedDebugTarget, singleAppPid, readDebugFocus, automationAdb, readSdkCapture };

type CaptureAttemptOutcome = { snapshot: UiSnapshot; failure: CaptureFailure | null };
type SdkTreeState = { capture: VerifiedSdkTree | null; error: CaptureFailure | null };

/** Real orchestration with replaceable device and image boundaries for offline acceptance. */
export function createInspectionRunner(overrides: Partial<InspectionPorts> = {}) {
  const ports = { ...productionPorts, ...overrides };
  return {
    async inspectDevice(provider: ProviderClient, serial: string, options: InspectionOptions = {}): Promise<UiSnapshot> {
      const context = createCaptureRunContext(options);
      return (await withCommandSignal(context.signal, () => readDeviceSnapshot(provider, serial, context, ports))).snapshot;
    },
    inspectHybridDevice(provider: ProviderClient, serial: string, packageName: string, options: InspectionOptions = {}): Promise<UiSnapshot> {
      const context = createCaptureRunContext({ ...options, expectedPackage: packageName });
      return withCommandSignal(context.signal, async () => {
        context.signal?.throwIfAborted();
        context.plan.requireSdk();
        const adbPath = ports.automationAdb(serial);
        const before = await ports.checkedDebugTarget(adbPath, serial, packageName);
        const expectedPid = await ports.singleAppPid(adbPath, serial, packageName);
        context.options.onProgress?.("读取 SDK 控件树", 0);
        const sdk = await ports.readSdkCapture(provider, adbPath, serial, packageName, context);
        const { snapshot } = await readDeviceSnapshot(provider, serial, context, ports);
        if (snapshot.error) throw new Error(snapshot.error);
        const after = await ports.checkedDebugTarget(adbPath, serial, packageName);
        if (before.component !== after.component || before.windowId !== after.windowId || expectedPid !== await ports.singleAppPid(adbPath, serial, packageName)) {
          throw new Error("SDK 与独立画面采集期间进程或窗口已变化");
        }
        return joinSdkTreeAndDebugImages(snapshot, sdk, packageName, expectedPid);
      });
    },
    inspectPreferredDevice(provider: ProviderClient, serial: string, options: InspectionOptions = {}): Promise<UiSnapshot> {
      const context = createCaptureRunContext({ ...options, pinFirstComponent: null });
      return withCommandSignal(context.signal, () => readPreferredSnapshot(provider, serial, context, ports));
    },
  };
}
const inspectionRunner = createInspectionRunner();
export const inspectDevice = inspectionRunner.inspectDevice;
export const inspectHybridDevice = inspectionRunner.inspectHybridDevice;
export const inspectPreferredDevice = inspectionRunner.inspectPreferredDevice;

/** Compatibility API; internal retry decisions use the retained typed attempt outcome. */
export function shouldRetryStartupCapture(error: string | null, remainingMs: number, singleAttempt = false): boolean {
  return shouldRetryCapture(error === null ? null : classifyCaptureFailure(new Error(error)), remainingMs, singleAttempt);
}

function sdkTreeReady(provider: ProviderClient, serial: string, context: CaptureRunContext, state: SdkTreeState,
  retryDeadline: number, ports: InspectionPorts): NonNullable<InspectionOptions["onViewTreeReady"]> {
  return async (packageName, root, mode, prefetched, checkedIdentity) => {
    if (!context.plan.allowsSdk) return;
    if (!/^[\w]+(?:\.[\w]+)+$/.test(packageName)) return;
    try {
      const adbPath = ports.automationAdb(serial);
      const capture = await verifySdkTreeIdentity({ serial, packageName, root, prefetched, checkedIdentity, signal: context.signal, inspectionMode: context.plan.inspectionMode }, {
        installed: async () => {
          const installed = await ports.runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "package", packageName]);
          return installed.code === 0 && installed.stdout.toString("utf8").includes(`${packageName}/com.androiduiinspector.sdk.HierarchyProvider:`);
        },
        target: () => ports.checkedDebugTarget(adbPath, serial, packageName),
        pid: () => ports.singleAppPid(adbPath, serial, packageName),
        read: () => ports.readSdkCapture(provider, adbPath, serial, packageName, context),
      });
      if (!capture) return;
      const { tree, pid } = capture;
      if (tree && typeof tree === "object" && "visibleStreamVersion" in tree && (tree.visibleStreamVersion === 1 || tree.visibleStreamVersion === 2)) {
        root.attributes = { ...root.attributes, "sdk-visible-stream": String(tree.visibleStreamVersion) };
      }
      try {
        if (mode === "adopt") {
          adoptSdkTree(root, tree, packageName, pid, prefetched !== undefined ? "merged-capture" : "checked-dump");
          root.attributes = { ...root.attributes, "sdk-tree-source": prefetched !== undefined ? "merged" : "checked-dump" };
        } else {
          const verified = joinSdkTreeAndDebugImages({ serial, root, nodeCount: countNodes(root), inspectionSource: "debug-view", error: null } as UiSnapshot, tree, packageName, pid).root!;
          applyVerifiedSdkViewTypes(root, verified);
          root.attributes = { ...root.attributes, "sdk-process-instance": verified.attributes!["sdk-process-instance"],
            "sdk-ui-wake-version": verified.attributes!["sdk-ui-wake-version"] ?? "",
            "sdk-window-hardware-accelerated": verified.children[0].attributes?.["sdk-hardwareAccelerated"] ?? "" };
        }
        state.error = null; state.capture = capture;
        if (prefetched !== undefined) root.attributes = { ...root.attributes, "sdk-tree-source": "merged" };
      } catch (error) {
        const failure = classifyCaptureFailure(error);
        if (failure.reason !== "sdk-tree-mismatch") throw error;
        state.error = failure;
      }
      context.plan.acceptVerifiedSdk({ nodeCount: countNodes(root), verified: state.capture !== null && state.error === null,
        visibleStream: root.attributes?.["sdk-visible-stream"], uiWake: root.attributes?.["sdk-ui-wake-version"], hardwareAccelerated: windowAcceleration(root) });
    } catch (error) {
      context.signal?.throwIfAborted();
      const failure = classifyCaptureFailure(error); state.error = failure;
      if ((failure.reason === "sdk-tree-mismatch" || failure.reason === "sdk-tree-timeout" || failure.reason === "sdk-tree-interrupted") && performance.now() < retryDeadline)
        throw new CaptureError("initializing", `App 正在初始化：${failure.message}`, error);
      if (failure.reason === "sdk-tree-timeout" || failure.reason === "sdk-tree-interrupted") throw error;
    }
  };
}

async function readPreferredSnapshot(provider: ProviderClient, serial: string, context: CaptureRunContext, ports: InspectionPorts): Promise<UiSnapshot> {
  const options = context.options, started = performance.now(), retryDeadline = started + STARTUP_RETRY_TIMEOUT_MS;
  let sdkState: SdkTreeState = { capture: null, error: null };
  let snapshot!: UiSnapshot;
  let attempts: NonNullable<UiSnapshot["captureRequestDiagnostics"]>["attempts"] = [];
  let totalAttempts = 0, startupRetry = context.plan.startupRetry;
  const finish = (value: UiSnapshot): UiSnapshot => ({ ...value, captureRequestDiagnostics: {
    totalDurationMs: Math.round(performance.now() - started), totalAttempts,
    droppedAttempts: totalAttempts - attempts.length, attempts,
  } });
  do {
    sdkState = { capture: null, error: null };
    const attemptStarted = performance.now();
    context.signal?.throwIfAborted();
    if (totalAttempts > 0 && attemptStarted >= retryDeadline) break;
    const budget = totalAttempts > 0 ? startupRetryBudget(retryDeadline - attemptStarted, context.signal) : null;
    const attempt = createCaptureAttemptContext(context, { signal: budget?.signal ?? context.signal, startupRetry });
    const attemptState = sdkState;
    const attemptContext: CaptureRunContext = { ...attempt,
      treeVerifier: attempt.plan.allowsSdk ? (stageContext, ...args) => sdkTreeReady(provider, serial, stageContext, attemptState, retryDeadline, ports)(...args) : undefined };
    let failure: CaptureFailure | null;
    try {
      const result = await withCommandSignal(attemptContext.signal, () => readDeviceSnapshot(provider, serial, attemptContext, ports));
      snapshot = result.snapshot; failure = result.failure;
      context.signal?.throwIfAborted();
      if (budget?.signal.aborted) {
        failure = classifyCaptureFailure(budget.signal.reason);
        snapshot = { ...snapshot, ...errorSnapshot(serial, failure.message) };
      }
    } finally { budget?.dispose(); }
    attempts = recordCaptureAttempt(attempts, snapshot, ++totalAttempts, attemptStarted - started, performance.now() - attemptStarted);
    if (!shouldRetryCapture(failure, retryDeadline - performance.now(), options.singleAttempt)) break;
    context.signal?.throwIfAborted(); startupRetry = true;
    options.onProgress?.("等待 App 页面稳定", Math.round(performance.now() - started));
    try { await wait(STARTUP_RETRY_DELAY_MS, undefined, { signal: context.signal }); }
    catch (error) { context.signal?.throwIfAborted(); throw error; }
  } while (true);
  if (snapshot.error || snapshot.inspectionSource !== "debug-view" || !sdkState.capture && !sdkState.error) return finish(snapshot);
  try {
    if (sdkState.error) throw sdkState.error.error;
    const capture = sdkState.capture!;
    const adbPath = ports.automationAdb(serial);
    const after = await ports.checkedDebugTarget(adbPath, serial, capture.packageName);
    if (snapshot.root?.package !== capture.packageName || snapshot.root.attributes?.["debug-process-id"] !== String(capture.pid)
      || capture.component !== after.component || capture.windowId !== after.windowId || capture.pid !== await ports.singleAppPid(adbPath, serial, capture.packageName)) {
      throw new Error("进程或窗口已变化");
    }
    context.signal?.throwIfAborted();
    return finish(joinSdkTreeAndDebugImages(snapshot, capture.tree, capture.packageName, capture.pid));
  } catch (error) {
    context.signal?.throwIfAborted();
    return finish({ ...snapshot, warning: [snapshot.warning, `SDK 树未采用（${error instanceof Error ? error.message : "未知错误"}）；已保留原独立画面。`].filter(Boolean).join(" ") });
  }
}

async function readDeviceSnapshot(provider: ProviderClient, serial: string, context: CaptureRunContext, ports: InspectionPorts): Promise<CaptureAttemptOutcome> {
  const options = context.options;
  const { runDeviceAdb, findAdbPath, commandError, captureScreen, captureDebugViewImages, qmlDebugTree, checkedDebugTarget, singleAppPid, readDebugFocus } = ports;
  const failedOutcome = (message: string): CaptureAttemptOutcome => ({ snapshot: errorSnapshot(serial, message), failure: classifyCaptureFailure(new Error(message)) });
  const started = performance.now();
  const readiness = createCaptureReadiness(APP_READY_TIMEOUT_MS, () => performance.now() - started);
  let stageStart = started;
  let currentStage = "";
  const timings: Record<string, number> = {};
  let diagnosticRoot: UiNode | undefined;
  const measure = async <T>(name: string, task: () => Promise<T>): Promise<T> => {
    const before = performance.now();
    try { return await task(); }
    finally { timings[name] = (timings[name] ?? 0) + Math.round(performance.now() - before); }
  };
  const stage = (name: string) => {
    context.signal?.throwIfAborted();
    const now = performance.now();
    if (currentStage) timings[currentStage] = (timings[currentStage] ?? 0) + Math.round(now - stageStart);
    currentStage = name;
    stageStart = now;
    options.onProgress?.(name, Math.round(now - started));
  };
  if (!serial.trim()) return failedOutcome("设备序列号不能为空。");

  const adbPath = findAdbPath();
  if (!adbPath) return failedOutcome("未找到 adb。请安装 Android SDK Platform-Tools 后重试。");

  try {
    stage("检查前台 Debug App");
    const activities = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"]);
    if (activities.code !== 0) throw new Error(commandError("无法读取前台 App", activities));
    let target = foregroundTarget(activities.stdout.toString("utf8"));
    const readinessDeadline = started + APP_READY_TIMEOUT_MS;
    let startupWaited = context.plan.startupRetry === true;
    if (!target) {
      startupWaited = true;
      const foregroundDeadline = Math.min(readinessDeadline, performance.now() + 2_000);
      stage("等待前台 App 就绪");
      while (!target && performance.now() < foregroundDeadline) {
        await wait(Math.min(500, Math.max(1, readinessDeadline - performance.now())), undefined, { signal: context.signal });
        if (performance.now() >= readinessDeadline) break;
        const current = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"], Math.max(1, Math.ceil(readinessDeadline - performance.now())));
        if (current.code !== 0) throw new Error(commandError("无法读取前台 App", current));
        target = foregroundTarget(current.stdout.toString("utf8"));
      }
      if (!target) throw new Error("未发现前台 App，请等待页面启动后重试。");
    }
    if (options.expectedPackage && target.packageName !== options.expectedPackage) throw new Error("前台 App 已变化，已拒绝采集未授权的 App。");
    if (context.request.pinFirstComponent === null) context.request.pinFirstComponent = target.component;
    else if (context.request.pinFirstComponent && context.request.pinFirstComponent !== target.component) throw new Error("重新采集时前台 App 已变化，已停止采集。");

    readiness.phase("debug-check");
    const debugCheck = await runDeviceAdb(adbPath, serial, ["shell", "run-as", target.packageName, "id"]);
    if (debugCheck.code !== 0) throw new Error(`仅支持 Debug App：${target.packageName} 不可调试。`);
    const activitySection = (output: Buffer) => {
      const text = output.toString("utf8");
      return /(?:^|\n)[ \t]*ACTIVITY[ \t]+/.test(text) ? targetActivitySection(text, target) : "";
    };
    let section = "";
    {
      // System focus is cheap to query; never ask the App UI thread for a tree (or
      // open its SDK Provider) before its authorized foreground window is ready.
      const deadline = readinessDeadline;
      let focusReady = false;
      let focusRejection: string | null = null;
      let treeRejection: string | null = null;
      let pendingRead: "foreground" | "tree" = "foreground";
      let polls = 0;
      let treeReads = 0;
      const confirmFocus = () => {
        const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
        const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
        return withCommandSignal(signal, () => checkedDebugTarget(adbPath, serial, target.packageName));
      };
      stage("等待 App 窗口就绪");
      try {
        while (performance.now() < deadline) {
          context.signal?.throwIfAborted();
          if (polls++ > 0) {
            startupWaited = true;
            await readiness.observe("poll-wait", () => measure("就绪等待：轮询间隔", () => wait(Math.min(500, Math.max(1, deadline - performance.now())), undefined, { signal: context.signal })), () => ({ result: "waited" }));
          }
          // Never issue a dumpsys read with a token timeout: the child is killed mid-dump, and an
          // app whose dump is already slow can fall into an EPIPE loop instead of finishing. Stop
          // retrying while reads still have a realistic budget.
          if (deadline - performance.now() < APP_READY_MIN_READ_MS) { readiness.budgetStop(); break; }
          pendingRead = "foreground";
          readiness.phase("foreground");
          const foreground = await readiness.observe("foreground", () => measure("就绪等待：前台读取", () => runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"], Math.max(APP_READY_MIN_READ_MS, Math.ceil(deadline - performance.now())))), result => {
            const observed = foregroundTarget(result.stdout.toString("utf8"));
            return { result: result.code !== 0 ? "error" : sameActivityInstance(target, observed) ? "match" : "changed", component: observed?.component };
          });
          if (foreground.code !== 0) throw new Error(commandError("等待控件树时无法确认前台 App", foreground));
          if (!sameActivityInstance(target, foregroundTarget(foreground.stdout.toString("utf8")))) throw new Error("等待控件树时前台 App 已变化，已停止采集。");
          if (deadline - performance.now() < APP_READY_MIN_READ_MS) { readiness.budgetStop(); break; }
          let beforeFocus: DebugTarget;
          readiness.phase("focus-before");
          try {
            // A missing system focus needs no repeated run-as or second foreground query.
            // This cheap observation never authorizes a tree: a candidate still receives
            // the full fresh permission/Activity/window check below and after the dump.
            const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
            const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
            const candidate = await readiness.observe("focus-candidate", () => measure("就绪等待：窗口观察", () => withCommandSignal(signal,
              () => readDebugFocus(adbPath, serial))), value => ({ result: value.packageName === target.packageName ? "match" : "changed", windowId: value.id }),
              error => error instanceof FocusUnavailableError ? { result: "unavailable", focusReason: error.focusReason } : "error");
            if (candidate.packageName !== target.packageName) throw new Error("焦点窗口不属于授权 App；请关闭系统弹窗后重试。");
            if (deadline - performance.now() < APP_READY_MIN_READ_MS) { readiness.budgetStop(); break; }
            beforeFocus = await readiness.observe("focus-confirm-before", () => measure("就绪等待：窗口确认", confirmFocus),
              value => ({ result: sameActivityInstance(target, value) ? "match" : "changed", component: value.component, windowId: value.windowId }),
              error => error instanceof FocusUnavailableError ? { result: "unavailable", focusReason: error.focusReason } : "error");
          }
          catch (error) {
            context.signal?.throwIfAborted();
            focusRejection = error instanceof Error ? error.message : "焦点窗口查询失败";
            continue;
          }
          focusRejection = null;
          if (!sameActivityInstance(target, beforeFocus)) throw new Error("等待控件树时前台 App 已变化，已停止采集。");
          readiness.focused(beforeFocus);
          if (deadline - performance.now() < APP_READY_MIN_READ_MS) { readiness.budgetStop(); break; }
          pendingRead = "tree";
          stage("读取控件树");
          context.signal?.throwIfAborted();
          const refreshed = await readiness.read(() => measure(treeReads++ === 0 ? "首次 App 层级读取" : "就绪等待：层级读取", () => runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", target.packageName], Math.max(APP_READY_MIN_READ_MS, Math.ceil(deadline - performance.now())))));
          if (refreshed.code !== 0) throw new Error(commandError("等待控件树时无法读取 App 层级", refreshed));
          section = activitySection(refreshed.stdout);
          if (hasActivityHierarchy(section, target)) {
            treeRejection = null;
            readiness.phase("focus-after");
            try {
              const afterFocus = await readiness.observe("focus-confirm-after", () => measure("就绪等待：窗口确认", confirmFocus),
                value => ({ result: sameActivityInstance(target, value) && value.windowId === beforeFocus.windowId ? "match" : "changed", component: value.component, windowId: value.windowId }),
                error => error instanceof FocusUnavailableError ? { result: "unavailable", focusReason: error.focusReason } : "error");
              focusReady = sameActivityInstance(target, afterFocus) && afterFocus.windowId === beforeFocus.windowId;
              if (focusReady) readiness.focused(afterFocus);
              if (!focusReady) focusRejection = "读取控件树前后焦点窗口或 Activity 已变化";
            }
            catch (error) {
              context.signal?.throwIfAborted();
              focusRejection = error instanceof Error ? error.message : "焦点窗口查询失败";
            }
            // This successful dump is bracketed by the same authorized focused window.
            // Reuse it only in this attempt; a second full dump adds UI work without
            // proving atomic pixels (the draw/SDK identity guards still run below).
            if (focusReady) break;
          } else treeRejection = activityTreeReadinessReason(section);
          stage(treeRejection ? "等待 App 控件树就绪" : "等待 App 窗口就绪");
        }
      } catch (error) {
        context.signal?.throwIfAborted();
        if (classifyCaptureFailure(error).reason !== "command-timeout") throw error;
        if (pendingRead === "tree") treeRejection = "当前 Activity 控件树读取超过剩余就绪预算";
        else focusRejection = "前台 Activity 查询超过剩余就绪预算";
      }
      if (!focusReady || !hasActivityHierarchy(section, target)) throw new Error("前台 App 在 18 秒内未准备好控件树和焦点窗口，请等待页面就绪后重试。"
        + (focusRejection ? `窗口确认：${focusRejection}` : treeRejection ? `控件树：${treeRejection}。` : treeReads === 0 ? "尚未开始读取控件树。" : "尚未完成读取后的窗口确认。")
        + (deadline - performance.now() > 0 && deadline - performance.now() < APP_READY_MIN_READ_MS
          ? "剩余就绪预算不足 1.5 秒，已提前停止，避免中途打断系统查询。" : ""));
      readiness.ready();
      stage("读取控件树");
    }
    context.signal?.throwIfAborted();
    // Prepare only after the same focused instance has supplied a valid tree.
    if (context.plan.allowsSdk) void provider.open(adbPath, serial, target.packageName);
    const isQml = section.includes("org.qtproject.qt.android.");
    let root: UiNode;
    let inspectionSource: UiSnapshot["inspectionSource"];
    let warning: string | null = null;
    let rawHierarchy: string;
    let qmlIdentity: { processId: number; windowId: string } | null = null;
    let prestartedScreen: Promise<Awaited<ReturnType<typeof captureScreen>> | null> | null = null;

    if (isQml) {
      const qml = await qmlDebugTree(adbPath, serial, target, undefined, context);
      root = qmlUiTree(qml.root, target.packageName, appBounds(section), qml.images);
      const confirmed = await checkedDebugTarget(adbPath, serial, target.packageName);
      if (confirmed.component !== target.component || qml.processId !== await singleAppPid(adbPath, serial, target.packageName)) throw new Error("Qt App 进程或窗口已变化，请重新采集。");
      qmlIdentity = { processId: qml.processId, windowId: confirmed.windowId };
      root.attributes!["qml-process-id"] = String(qml.processId);
      root.attributes!["qml-window-id"] = confirmed.windowId;
      inspectionSource = "debug-qml";
      rawHierarchy = JSON.stringify(qml.root);
      if (qml.restarted) warning = "已重启目标 App 并建立 QML Debug 连接。";
      if (qml.captureWarning) warning = [warning, qml.captureWarning].filter(Boolean).join(" ");
    } else {
      root = debugViewTree(section, target);
      diagnosticRoot = root;
      root.attributes = { ...root.attributes, "debug-component": target.component };
      inspectionSource = "debug-view";
      rawHierarchy = section;
      stage("读取完整控件属性");
      const imageSignal = captureSignal(context.signal, startupWaited ? STARTUP_IMAGE_TIMEOUT_MS : IMAGE_TIMEOUT_MS);
      try {
        let previewScreen: Awaited<ReturnType<typeof captureScreen>> | null = null;
        let previewScreenTask: Promise<void> | null = null;
        const beginTreeScreen = () => previewScreenTask ??= (async () => {
          try {
            const signal = captureSignal(imageSignal, PREVIEW_SCREEN_TIMEOUT_MS);
            const screen = await withCommandSignal(signal, () => captureScreen(adbPath, serial));
            if (screen.screenshotDataUrl && screen.captureGeometry && assessCaptureGeometry(screen.captureGeometry).status === "checked") previewScreen = screen;
          } catch { context.signal?.throwIfAborted(); }
        })();
        const preview: InspectionPreview | undefined = options.onPreview ? Object.assign(async (phase: "tree" | "layers") => {
          try {
            if (phase === "tree") {
              stage("读取首屏预览");
              await beginTreeScreen();
            }
            const previewCheckStarted = performance.now();
            const foreground = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"]);
            if (phase === "tree") timings["树预览前台校验"] = Math.round(performance.now() - previewCheckStarted);
            if (foreground.code !== 0 || !sameActivityInstance(target, foregroundTarget(foreground.stdout.toString("utf8")))) return;
            context.signal?.throwIfAborted();
            options.onPreview?.(phase, {
              serial, root, nodeCount: countNodes(root), xmlSize: Buffer.byteLength(rawHierarchy, "utf8"), rawXml: null,
              screenshotDataUrl: previewScreen?.screenshotDataUrl ?? null, captureGeometry: previewScreen?.captureGeometry,
              error: null, warning: null, inspectionSource: "debug-view",
              captureDurationMs: Math.round(performance.now() - started),
            });
          } catch {
            context.signal?.throwIfAborted();
          }
        }, { beginTreeScreen }) : undefined;
        const images = await withCommandSignal(imageSignal, () => captureDebugViewImages(provider, adbPath, serial, target.packageName, root, stage, preview, timings, withCaptureSignal(context, imageSignal)));
        const imageCount = images.imageCount;
        prestartedScreen = images.finalScreen;
        if (imageCount === 0) warning = "未读取到独立 View 画面，缺失画面的控件仅显示边框。";
      } catch (error) {
        context.signal?.throwIfAborted();
        if (imageSignal.aborted) throw new Error(startupWaited
          ? "App 冷启动后 55 秒仍未完成独立画面采集，请等待页面稳定后重试。"
          : "独立画面采集超过 90 秒，请等待页面稳定后重试。");
        // A request-bound SDK guard has already proved this batch stale. Do not draw
        // it again through compatibility capture or the startup retry loop.
        const failure = classifyCaptureFailure(error);
        if (failure.reason === "published-tree-changed") throw error;
        if (startupImageFailure(failure, startupWaited)) {
          throw new CaptureError("startup-transient", `App 仍在启动，独立画面尚未就绪，请等待页面稳定后重试。${failure.message}`, error);
        }
        const pending = [...root.children];
        while (pending.length) {
          const node = pending.pop()!;
          node.layerImageStatus ??= node.visibleToUser ? "failed" : "hidden";
          if (node.layerImageStatus === "failed") node.attributes = { ...node.attributes,
            "image-capture-error": node.attributes?.["image-capture-error"] ?? `独立画面采集中断：${error instanceof Error ? error.message : "采集失败"}` };
          pending.push(...node.children);
        }
        warning = `独立 View 画面抓取失败，缺失画面的控件仅显示边框。${error instanceof Error ? error.message : ""}`;
      }
      const pending = [...root.children];
      let ambiguous = 0, outsideWindow = 0;
      while (pending.length) {
        const node = pending.pop()!;
        node.layerImageStatus ??= node.visibleToUser ? "unavailable" : "hidden";
        if (node.layerImageStatus === "ambiguous") {
          ambiguous++;
          const b = node.bounds, window = root.bounds;
          if (b && window && (b.right <= window.left || b.bottom <= window.top || b.left >= window.right || b.top >= window.bottom)) outsideWindow++;
        }
        pending.push(...node.children);
      }
      if (ambiguous) warning = [warning, `${ambiguous} 个控件的位图无法唯一匹配${outsideWindow ? `（其中 ${outsideWindow} 个在当前窗口范围外）` : ""}，已保留边框，未混用其他控件画面。`].filter(Boolean).join(" ");
      warning = [warning, layerCaptureFailureWarning(root) ?? root.attributes?.["texture-capture-warning"]].filter(Boolean).join(" ") || null;
    }

    stage("读取屏幕并校验前台窗口");
    let screenshot: Awaited<ReturnType<typeof captureScreen>> | null = null;
    if (prestartedScreen) screenshot = await prestartedScreen;
    if (!screenshot) {
      try {
        const signal = captureSignal(context.signal, FINAL_SCREEN_TIMEOUT_MS);
        screenshot = await withCommandSignal(signal, () => captureScreen(adbPath, serial));
      } catch { context.signal?.throwIfAborted(); }
    }
    const after = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"]);
    if (after.code !== 0 || !sameActivityInstance(target, foregroundTarget(after.stdout.toString("utf8")))) {
      throw new Error("采集期间前台窗口发生变化或无法校验，请保持页面稳定后重新采集。");
    }
    if (qmlIdentity) {
      const confirmed = await checkedDebugTarget(adbPath, serial, target.packageName);
      if (confirmed.windowId !== qmlIdentity.windowId || qmlIdentity.processId !== await singleAppPid(adbPath, serial, target.packageName)) {
        throw new Error("Qt App 进程或窗口已变化，请重新采集。");
      }
    }
    if (!screenshot?.screenshotDataUrl) {
      warning = [warning, screenshot
        ? commandError("控件树已读取，但截图失败或不是有效 PNG", screenshot.result)
        : "控件树已读取，但截图超时或读取失败。"].filter(Boolean).join(" ");
    } else if (screenshot.captureGeometry) {
      const integrity = assessCaptureGeometry(screenshot.captureGeometry);
      if (integrity.status === "mismatch") warning = [warning, integrity.message].filter(Boolean).join(" ");
    }

    if (!root.children.length) throw new Error("采集到空控件树，请保持页面稳定后重新采集。");
    stage("完成");
    return { failure: null, snapshot: {
      serial,
      root,
      nodeCount: countNodes(root),
      xmlSize: Buffer.byteLength(rawHierarchy, "utf8"),
      rawXml: null,
      screenshotDataUrl: screenshot?.screenshotDataUrl ?? null,
      error: null,
      warning,
      inspectionSource,
      captureTimings: timings,
      captureDurationMs: Math.round(performance.now() - started),
      captureReadiness: readiness.snapshot(),
      ...(screenshot?.captureGeometry ? { captureGeometry: screenshot.captureGeometry } : {}),
    } };
  } catch (error) {
    if (context.signal?.aborted) {
      if (!(context.signal.reason instanceof StartupRetryBudgetError)) context.signal.throwIfAborted();
      error = context.signal.reason;
    }
    if (currentStage) timings[currentStage] = (timings[currentStage] ?? 0) + Math.round(performance.now() - stageStart);
    const fallback = Object.entries(diagnosticRoot?.attributes ?? {})
      .filter(([key]) => /^sdk-(first|visible|ref)-fallback$/.test(key))
      .map(([key, value]) => `${key}: ${value}`).join("；");
    const failed = { ...errorSnapshot(serial, error instanceof Error ? error.message : "读取 Debug 控件树失败。"),
      ...(fallback ? { warning: `SDK 回退原因：${fallback}` } : {}),
      captureReadiness: readiness.snapshot(error instanceof Error ? error.message : "读取 Debug 控件树失败。"),
      captureTimings: timings, captureDurationMs: Math.round(performance.now() - started) };
    // Keep only bounded diagnostic scalars from the rejected tree; never return that tree
    // as a usable snapshot. The request wrapper will renumber this local attempt.
    return { failure: classifyCaptureFailure(error), snapshot: { ...failed, captureRequestDiagnostics: {
      totalDurationMs: failed.captureDurationMs, totalAttempts: 1, droppedAttempts: 0,
      attempts: recordCaptureAttempt([], { ...failed, root: diagnosticRoot ?? null }, 1, 0, failed.captureDurationMs),
    } } };
  }
}
