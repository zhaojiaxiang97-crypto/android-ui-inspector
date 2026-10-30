import { preferVerifiedSdkImages } from "../sdk/sdk-capture-route";
import { setTimeout as wait } from "node:timers/promises";
import type { UiNode, UiSnapshot } from "../../shared/types";
import { assessCaptureGeometry } from "../../shared/screen-coordinates";
import { recordCaptureAttempt } from "../../shared/capture-attempts";
import { createCaptureReadiness } from "../../shared/capture-readiness";
import { adoptSdkTree, joinSdkTreeAndDebugImages } from "../sdk/sdk-hybrid";
import { StartupRetryBudgetError, startupRetryBudget } from "./startup-retry-budget";
import { sdkTreePhase } from "../sdk/sdk-tree-read";
import { type InspectionOptions, type InspectionPreview } from "./types";
import { inspectionContext, runDeviceAdb, findAdbPath, commandError, captureSignal } from "../device/runtime";
import { automationAdb, checkedDebugTarget, singleAppPid, foregroundTarget, targetActivitySection, sameActivityInstance, type DebugTarget, readDebugFocus, FocusUnavailableError } from "../device/target";
import { readSdkCapture } from "./sdk-images";
import { countNodes, hasActivityHierarchy, activityTreeReadinessReason, appBounds, debugViewTree } from "./native-tree";
import { applyVerifiedSdkViewTypes, layerCaptureFailureWarning } from "./layer-images";
import { windowAcceleration, isStaleCaptureTreeError } from "../sdk/capture-protocol";
import { openProviderSession } from "../sdk/provider-session";
import { captureScreen } from "../device/screen";
import { qmlDebugTree, qmlUiTree } from "./qt";
import { STARTUP_IMAGE_TIMEOUT_MS, IMAGE_TIMEOUT_MS, PREVIEW_SCREEN_TIMEOUT_MS, captureDebugViewImages, FINAL_SCREEN_TIMEOUT_MS } from "./debug-images";

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

export function inspectDevice(serial: string, options: InspectionOptions = {}): Promise<UiSnapshot> {
  return inspectionContext.run(options, () => readDeviceSnapshot(serial, options));
}

/** Explicit experiment: SDK owns the tree; DDMS/JDWP still owns independent pixels. */
export function inspectHybridDevice(serial: string, packageName: string, options: InspectionOptions = {}): Promise<UiSnapshot> {
  return inspectionContext.run(options, async () => {
    const adbPath = automationAdb(serial);
    const before = await checkedDebugTarget(adbPath, serial, packageName);
    const expectedPid = await singleAppPid(adbPath, serial, packageName);
    options.onProgress?.("读取 SDK 控件树", 0);
    const sdk = await readSdkCapture(adbPath, serial, packageName);
    const snapshot = await inspectDevice(serial, { ...options, expectedPackage: packageName });
    if (snapshot.error) throw new Error(snapshot.error);
    const after = await checkedDebugTarget(adbPath, serial, packageName);
    if (before.component !== after.component || before.windowId !== after.windowId || expectedPid !== await singleAppPid(adbPath, serial, packageName)) {
      throw new Error("SDK 与独立画面采集期间进程或窗口已变化");
    }
    return joinSdkTreeAndDebugImages(snapshot, sdk, packageName, expectedPid);
  });
}

/** A full readiness timeout already polled the app; only transient startup failures may retry. */
export function shouldRetryStartupCapture(error: string | null, remainingMs: number, singleAttempt = false): boolean {
  return !singleAttempt && error !== null && error.startsWith("App 仍在启动")
    && Number.isFinite(remainingMs) && remainingMs > STARTUP_RETRY_DELAY_MS;
}

/** Existing capture remains the fallback; never attach SDK data when identity checks fail. */
export function inspectPreferredDevice(serial: string, options: InspectionOptions = {}): Promise<UiSnapshot> {
  return inspectionContext.run(options, async () => {
    const started = performance.now();
    const retryDeadline = started + STARTUP_RETRY_TIMEOUT_MS;
    const sdkState: { capture: { packageName: string; pid: number; component: string; windowId: string; tree: unknown } | null; error: unknown } = { capture: null, error: null };
    const captureOptions: InspectionOptions = { ...options, pinFirstComponent: null, onViewTreeReady: async (packageName, root, mode, prefetched, checkedIdentity) => {
      if (!/^[\w]+(?:\.[\w]+)+$/.test(packageName)) return;
      try {
        const adbPath = automationAdb(serial);
        let pid: number, component: string, windowId: string, tree: unknown;
        if (prefetched !== undefined) {
          // Merged capture: this tree came with the visible call. Identity stays pinned to the
          // capture-start values; the end-of-capture join still re-checks the whole hierarchy.
          const expectedPid = Number(root.attributes?.["debug-process-id"]);
          if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) throw new Error("SDK 与独立画面主进程不一致");
          let confirmed: { component: string; windowId: string };
          if (checkedIdentity) {
            if (checkedIdentity.serial !== serial || checkedIdentity.packageName !== packageName
                || checkedIdentity.pid !== expectedPid || !checkedIdentity.windowId
                || checkedIdentity.component !== root.attributes?.["debug-component"]) throw new Error("进程或窗口已变化");
            inspectionContext.getStore()?.signal?.throwIfAborted();
            confirmed = checkedIdentity;
            root.attributes = { ...root.attributes, "sdk-tree-identity-reused": "true" };
          } else {
            // Callers without fresh in-call evidence still perform the original check.
            confirmed = await checkedDebugTarget(adbPath, serial, packageName);
            if (confirmed.component !== root.attributes?.["debug-component"]
                || expectedPid !== await singleAppPid(adbPath, serial, packageName)) throw new Error("进程或窗口已变化");
          }
          pid = expectedPid; component = confirmed.component; windowId = confirmed.windowId; tree = prefetched;
        } else {
          const installed = await sdkTreePhase("provider-check", () => runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "package", packageName]));
          if (installed.code !== 0 || !installed.stdout.toString("utf8").includes(`${packageName}/com.androiduiinspector.sdk.HierarchyProvider:`)) return;
          const before = await sdkTreePhase("window-before", () => checkedDebugTarget(adbPath, serial, packageName));
          pid = await sdkTreePhase("pid-before", () => singleAppPid(adbPath, serial, packageName));
          if (root.attributes?.["debug-process-id"] !== String(pid)) throw new Error("SDK 与独立画面主进程不一致");
          tree = await readSdkCapture(adbPath, serial, packageName);
          const after = await sdkTreePhase("window-after", () => checkedDebugTarget(adbPath, serial, packageName));
          if (before.component !== after.component || before.windowId !== after.windowId || pid !== await sdkTreePhase("pid-after", () => singleAppPid(adbPath, serial, packageName))) throw new Error("进程或窗口已变化");
          component = before.component; windowId = before.windowId;
        }
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
            // Only validated capability/identity metadata is needed before bitmap
            // fallback; the final merge still rechecks the whole snapshot.
            root.attributes = { ...root.attributes, "sdk-process-instance": verified.attributes!["sdk-process-instance"],
              "sdk-ui-wake-version": verified.attributes!["sdk-ui-wake-version"] ?? "",
              "sdk-window-hardware-accelerated": verified.children[0].attributes?.["sdk-hardwareAccelerated"] ?? "" };
          }
          sdkState.error = null;
          sdkState.capture = { packageName, pid, component, windowId, tree };
          if (prefetched !== undefined) root.attributes = { ...root.attributes, "sdk-tree-source": "merged" };
        } catch (error) {
          // A changing sibling invalidates SDK properties, not an own bitmap
          // whose View identity, size and screen position are checked again below.
          if (!(error instanceof Error && error.message.startsWith("SDK 与独立画面的"))) throw error;
          sdkState.error = error;
        }
        // Small pages reuse the tree already validated above; do not add a capability
        // query or guess support before the existing property/SDK verification.
        if (preferVerifiedSdkImages({ preference: options.preferVisibleSdk, nodeCount: countNodes(root),
          verified: sdkState.capture !== null && sdkState.error === null,
          visibleStream: root.attributes?.["sdk-visible-stream"], uiWake: root.attributes?.["sdk-ui-wake-version"],
          hardwareAccelerated: windowAcceleration(root) })) {
          captureOptions.preferVisibleSdk = true;
          const activeCapture = inspectionContext.getStore();
          if (activeCapture) activeCapture.preferVisibleSdk = true;
        }
      } catch (error) {
        sdkState.error = error;
        if (error instanceof Error && /SDK 与独立画面的|SDK 控件树(?:连续)?超时/.test(error.message)
            && performance.now() < retryDeadline) throw new Error(`App 正在初始化：${error.message}`);
        if (error instanceof Error && /^SDK 控件树(?:连续)?超时/.test(error.message)) throw error;
      }
    } };
    // The budget exit is reachable only after the first completed attempt.
    let snapshot!: UiSnapshot;
    let attempts: NonNullable<UiSnapshot["captureRequestDiagnostics"]>["attempts"] = [];
    let totalAttempts = 0;
    const finish = (value: UiSnapshot): UiSnapshot => ({ ...value, captureRequestDiagnostics: {
      totalDurationMs: Math.round(performance.now() - started), totalAttempts,
      droppedAttempts: totalAttempts - attempts.length, attempts,
    } });
    do {
      sdkState.capture = null;
      sdkState.error = null;
      captureOptions.preferVisibleSdk = options.preferVisibleSdk;
      const attemptStarted = performance.now();
      options.signal?.throwIfAborted();
      if (totalAttempts > 0 && attemptStarted >= retryDeadline) break;
      const budget = totalAttempts > 0 ? startupRetryBudget(retryDeadline - attemptStarted, options.signal) : null;
      try {
        snapshot = await inspectDevice(serial, budget ? { ...captureOptions, signal: budget.signal } : captureOptions);
        options.signal?.throwIfAborted();
        // A late successful reply cannot become a usable snapshot after its retry budget.
        if (budget?.signal.aborted) snapshot = { ...snapshot, ...errorSnapshot(serial, budget.signal.reason.message) };
      } finally { budget?.dispose(); }
      attempts = recordCaptureAttempt(attempts, snapshot, ++totalAttempts, attemptStarted - started, performance.now() - attemptStarted);
      if (!shouldRetryStartupCapture(snapshot.error, retryDeadline - performance.now(), options.singleAttempt)) break;
      options.signal?.throwIfAborted();
      captureOptions.startupRetry = true;
      options.onProgress?.("等待 App 页面稳定", Math.round(performance.now() - started));
      try { await wait(STARTUP_RETRY_DELAY_MS, undefined, { signal: options.signal }); }
      catch (error) { options.signal?.throwIfAborted(); throw error; }
    } while (true);
    if (snapshot.error || snapshot.inspectionSource !== "debug-view" || !sdkState.capture && !sdkState.error) return finish(snapshot);
    try {
      if (sdkState.error) throw sdkState.error;
      const capture = sdkState.capture!;
      const adbPath = automationAdb(serial);
      const after = await checkedDebugTarget(adbPath, serial, capture.packageName);
      if (snapshot.root?.package !== capture.packageName || snapshot.root.attributes?.["debug-process-id"] !== String(capture.pid)
          || capture.component !== after.component || capture.windowId !== after.windowId || capture.pid !== await singleAppPid(adbPath, serial, capture.packageName)) {
        throw new Error("进程或窗口已变化");
      }
      return finish(joinSdkTreeAndDebugImages(snapshot, capture.tree, capture.packageName, capture.pid));
    } catch (error) {
      return finish({ ...snapshot, warning: [snapshot.warning, `SDK 树未采用（${error instanceof Error ? error.message : "未知错误"}）；已保留原独立画面。`].filter(Boolean).join(" ") });
    }
  });
}

async function readDeviceSnapshot(serial: string, options: InspectionOptions): Promise<UiSnapshot> {
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
    options.signal?.throwIfAborted();
    const now = performance.now();
    if (currentStage) timings[currentStage] = (timings[currentStage] ?? 0) + Math.round(now - stageStart);
    currentStage = name;
    stageStart = now;
    options.onProgress?.(name, Math.round(now - started));
  };
  if (!serial.trim()) return errorSnapshot(serial, "设备序列号不能为空。");

  const adbPath = findAdbPath();
  if (!adbPath) return errorSnapshot(serial, "未找到 adb。请安装 Android SDK Platform-Tools 后重试。");

  try {
    stage("检查前台 Debug App");
    const activities = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"]);
    if (activities.code !== 0) throw new Error(commandError("无法读取前台 App", activities));
    let target = foregroundTarget(activities.stdout.toString("utf8"));
    const readinessDeadline = started + APP_READY_TIMEOUT_MS;
    let startupWaited = options.startupRetry === true;
    if (!target) {
      startupWaited = true;
      const foregroundDeadline = Math.min(readinessDeadline, performance.now() + 2_000);
      stage("等待前台 App 就绪");
      while (!target && performance.now() < foregroundDeadline) {
        await wait(Math.min(500, Math.max(1, readinessDeadline - performance.now())), undefined, { signal: options.signal });
        if (performance.now() >= readinessDeadline) break;
        const current = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"], Math.max(1, Math.ceil(readinessDeadline - performance.now())));
        if (current.code !== 0) throw new Error(commandError("无法读取前台 App", current));
        target = foregroundTarget(current.stdout.toString("utf8"));
      }
      if (!target) throw new Error("未发现前台 App，请等待页面启动后重试。");
    }
    if (options.expectedPackage && target.packageName !== options.expectedPackage) throw new Error("前台 App 已变化，已拒绝采集未授权的 App。");
    if (options.pinFirstComponent === null) options.pinFirstComponent = target.component;
    else if (options.pinFirstComponent && options.pinFirstComponent !== target.component) throw new Error("重新采集时前台 App 已变化，已停止采集。");

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
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        return inspectionContext.run({ ...options, signal }, () => checkedDebugTarget(adbPath, serial, target.packageName));
      };
      stage("等待 App 窗口就绪");
      try {
        while (performance.now() < deadline) {
          options.signal?.throwIfAborted();
          if (polls++ > 0) {
            startupWaited = true;
            await readiness.observe("poll-wait", () => measure("就绪等待：轮询间隔", () => wait(Math.min(500, Math.max(1, deadline - performance.now())), undefined, { signal: options.signal })), () => ({ result: "waited" }));
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
            const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
            const candidate = await readiness.observe("focus-candidate", () => measure("就绪等待：窗口观察", () => inspectionContext.run({ ...options, signal },
              () => readDebugFocus(adbPath, serial))), value => ({ result: value.packageName === target.packageName ? "match" : "changed", windowId: value.id }),
              error => error instanceof FocusUnavailableError ? { result: "unavailable", focusReason: error.focusReason } : "error");
            if (candidate.packageName !== target.packageName) throw new Error("焦点窗口不属于授权 App；请关闭系统弹窗后重试。");
            if (deadline - performance.now() < APP_READY_MIN_READ_MS) { readiness.budgetStop(); break; }
            beforeFocus = await readiness.observe("focus-confirm-before", () => measure("就绪等待：窗口确认", confirmFocus),
              value => ({ result: sameActivityInstance(target, value) ? "match" : "changed", component: value.component, windowId: value.windowId }),
              error => error instanceof FocusUnavailableError ? { result: "unavailable", focusReason: error.focusReason } : "error");
          }
          catch (error) {
            options.signal?.throwIfAborted();
            focusRejection = error instanceof Error ? error.message : "焦点窗口查询失败";
            continue;
          }
          focusRejection = null;
          if (!sameActivityInstance(target, beforeFocus)) throw new Error("等待控件树时前台 App 已变化，已停止采集。");
          readiness.focused(beforeFocus);
          if (deadline - performance.now() < APP_READY_MIN_READ_MS) { readiness.budgetStop(); break; }
          pendingRead = "tree";
          stage("读取控件树");
          options.signal?.throwIfAborted();
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
              options.signal?.throwIfAborted();
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
        options.signal?.throwIfAborted();
        if (!(error instanceof Error && error.message.startsWith("命令执行超时"))) throw error;
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
    options.signal?.throwIfAborted();
    // Prepare only after the same focused instance has supplied a valid tree.
    void openProviderSession(adbPath, serial, target.packageName);
    const isQml = section.includes("org.qtproject.qt.android.");
    let root: UiNode;
    let inspectionSource: UiSnapshot["inspectionSource"];
    let warning: string | null = null;
    let rawHierarchy: string;
    let qmlIdentity: { processId: number; windowId: string } | null = null;
    let prestartedScreen: Promise<Awaited<ReturnType<typeof captureScreen>> | null> | null = null;

    if (isQml) {
      const qml = await qmlDebugTree(adbPath, serial, target);
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
      const imageSignal = captureSignal(options.signal, startupWaited ? STARTUP_IMAGE_TIMEOUT_MS : IMAGE_TIMEOUT_MS);
      try {
        let previewScreen: Awaited<ReturnType<typeof captureScreen>> | null = null;
        let previewScreenTask: Promise<void> | null = null;
        const beginTreeScreen = () => previewScreenTask ??= (async () => {
          try {
            const signal = captureSignal(inspectionContext.getStore()?.signal, PREVIEW_SCREEN_TIMEOUT_MS);
            const screen = await inspectionContext.run({ ...options, signal }, () => captureScreen(adbPath, serial));
            if (screen.screenshotDataUrl && screen.captureGeometry && assessCaptureGeometry(screen.captureGeometry).status === "checked") previewScreen = screen;
          } catch { options.signal?.throwIfAborted(); }
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
            options.signal?.throwIfAborted();
            options.onPreview?.(phase, {
              serial, root, nodeCount: countNodes(root), xmlSize: Buffer.byteLength(rawHierarchy, "utf8"), rawXml: null,
              screenshotDataUrl: previewScreen?.screenshotDataUrl ?? null, captureGeometry: previewScreen?.captureGeometry,
              error: null, warning: null, inspectionSource: "debug-view",
              captureDurationMs: Math.round(performance.now() - started),
            });
          } catch {
            options.signal?.throwIfAborted();
          }
        }, { beginTreeScreen }) : undefined;
        const images = await inspectionContext.run({ ...options, signal: imageSignal }, () => captureDebugViewImages(adbPath, serial, target.packageName, root, stage, preview, timings));
        const imageCount = images.imageCount;
        prestartedScreen = images.finalScreen;
        if (imageCount === 0) warning = "未读取到独立 View 画面，缺失画面的控件仅显示边框。";
      } catch (error) {
        options.signal?.throwIfAborted();
        if (imageSignal.aborted) throw new Error(startupWaited
          ? "App 冷启动后 55 秒仍未完成独立画面采集，请等待页面稳定后重试。"
          : "独立画面采集超过 90 秒，请等待页面稳定后重试。");
        // A request-bound SDK guard has already proved this batch stale. Do not draw
        // it again through compatibility capture or the startup retry loop.
        if (error instanceof Error && /^SDK 已发布控件树在绘制(?:前|期间)变化/.test(error.message)) throw error;
        if (error instanceof Error && (isStaleCaptureTreeError(error) || /Debug V2|App 正在初始化/.test(error.message)
            || startupWaited && /SDK 控件树(?:连续)?超时|Debug View 连接超时/.test(error.message))) {
          throw new Error(`App 仍在启动，独立画面尚未就绪，请等待页面稳定后重试。${error.message}`);
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
        const signal = captureSignal(options.signal, FINAL_SCREEN_TIMEOUT_MS);
        screenshot = await inspectionContext.run({ ...options, signal }, () => captureScreen(adbPath, serial));
      } catch { options.signal?.throwIfAborted(); }
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
    return {
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
    };
  } catch (error) {
    if (options.signal?.aborted) {
      if (!(options.signal.reason instanceof StartupRetryBudgetError)) options.signal.throwIfAborted();
      error = options.signal.reason;
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
    return { ...failed, captureRequestDiagnostics: {
      totalDurationMs: failed.captureDurationMs, totalAttempts: 1, droppedAttempts: 0,
      attempts: recordCaptureAttempt([], { ...failed, root: diagnosticRoot ?? null }, 1, 0, failed.captureDurationMs),
    } };
  }
}
