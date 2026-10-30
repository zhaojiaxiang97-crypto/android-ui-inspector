import type { ProviderClient } from "../sdk/provider-session";
import { inspectSystemInputInjection, runDebugInputCommand } from "../device/debug-input";
import { buildInputInjectionCommand, inputInjectionRoute } from "../device/input-injection-diagnostics";
import { randomUUID } from "node:crypto";
import type { DebugInputAction, DebugInputEvidence, DisplayFrame, FastCaptureBackend, UiSnapshot } from "../../shared/types";
import { assessCaptureGeometry } from "../../shared/screen-coordinates";
import { type DebugTarget, automationAdb, checkedDebugTarget, sameActivityInstance } from "../device/target";
import { withCommandSignal, withoutCommandSignal } from "../device/command-context";
import { runCommand, commandError, runDeviceAdb, captureSignal } from "../device/runtime";
import { inspectPreferredDevice } from "../capture/inspection";
import { parseUiHierarchy } from "../capture/xml-tree";
import { captureScreen, readDisplayFrame } from "../device/screen";
import { countNodes } from "../capture/native-tree";
import { readAccessibilityHelper } from "../capture/accessibility-helper";
import type { AccessibilityHelperSession } from "../capture/helper-session";
import type { InspectionMode } from "../../shared/inspection-mode";
import { DebugObservationError } from "./debug-observation-error";
import { measureDebugPhase } from "./debug-timing";


export type DebugObserver = (serial: string, packageName: string, mode: "fast" | "deep", signal?: AbortSignal,
  backend?: FastCaptureBackend, screenshotTiming?: "parallel" | "after-hierarchy") => Promise<{ snapshot: UiSnapshot; target: DebugTarget }>;

export function observeDebugApp(provider: ProviderClient, serial: string, packageName: string, mode: "fast" | "deep", signal?: AbortSignal,
  backend: FastCaptureBackend = "uiautomator", inspectionMode: InspectionMode = "standard",
  screenshotTiming: "parallel" | "after-hierarchy" = "parallel", helperSession?: AccessibilityHelperSession): ReturnType<DebugObserver> {
  if (backend !== "uiautomator" && (backend !== "accessibility-helper" || mode !== "fast")) throw new Error("Helper只支持fast采集。");
  const deadline = backend === "accessibility-helper" ? captureSignal(signal, 30_000) : signal;
  return withCommandSignal(deadline, () => measureDebugPhase("observation", async () => {
    const started = performance.now();
    const adbPath = automationAdb(serial);
    const before = await measureDebugPhase("target_before", () => checkedDebugTarget(adbPath, serial, packageName));
    let snapshot: UiSnapshot;
    if (mode === "deep") {
      snapshot = await measureDebugPhase("deep_capture", () => inspectPreferredDevice(provider, serial, { signal, expectedPackage: packageName, allowAppRestart: false, inspectionMode }));
      if (snapshot.error) throw new Error(snapshot.error);
    } else if (backend === "accessibility-helper") {
      const frame = await measureDebugPhase("geometry", () => readDisplayFrame(adbPath, serial));
      if (!frame) throw new Error("无法确认Helper采集的主显示器。");
      if (helperSession) {
        const observed = await measureDebugPhase("hierarchy", () => helperSession.read(adbPath, packageName, frame, deadline!));
        const currentFrame = await measureDebugPhase("geometry", () => readDisplayFrame(adbPath, serial));
        if (!currentFrame || currentFrame.rotation !== frame.rotation || currentFrame.width !== frame.width || currentFrame.height !== frame.height)
          throw new Error("Helper采集前后屏幕方向或尺寸发生变化。");
        snapshot = { serial, root: observed.root, nodeCount: observed.nodeCount, xmlSize: Buffer.byteLength(observed.xml), rawXml: observed.xml,
          screenshotDataUrl: observed.screenshotDataUrl, captureGeometry: observed.captureGeometry, helperObservation: observed.helperObservation,
          error: null, inspectionSource: "accessibility-helper",
          warning: "Helper无障碍语义树：树后采集无损截图，窗口与可见区域已核对；视频等动态内容不保证严格同帧。" };
      } else {
        // Legacy direct readers remain read-only; only a grant-owned v1 client supplies action evidence.
        const tree = await measureDebugPhase("hierarchy", () => readAccessibilityHelper(adbPath, serial, packageName, frame, deadline!));
        const screen = await measureDebugPhase("screenshot", () => captureScreen(adbPath, serial));
        await measureDebugPhase("geometry", () => {
          if (!screen.screenshotDataUrl || !screen.captureGeometry || screen.captureGeometry.afterScreenshot?.rotation !== frame.rotation
          || screen.captureGeometry.afterScreenshot.width !== frame.width || screen.captureGeometry.afterScreenshot.height !== frame.height)
            throw new Error("Helper截图失败或屏幕方向、尺寸发生变化。");
        });
        snapshot = { serial, root: tree.root, nodeCount: tree.nodeCount, xmlSize: Buffer.byteLength(tree.xml), rawXml: tree.xml,
          screenshotDataUrl: screen.screenshotDataUrl, error: null, inspectionSource: "accessibility-helper",
          captureGeometry: { ...screen.captureGeometry!, hierarchyRotation: frame.rotation },
          warning: "Helper无障碍语义树：提示与文本分别保留，系统装饰节点可能与UIAutomator不同；没有独立图层，仅支持只读观察。" };
      }
    } else {
      // Both reads belong to this observation and are bracketed by the target checks.
      // Join both on failure/cancellation; a screenshot is never reused from an older read.
      const tree = measureDebugPhase("hierarchy", () => readDebugHierarchy(adbPath, serial, packageName));
      // Visual recovery must not use a screenshot taken before a new overlay entered the tree.
      // Ordinary observations retain parallel reads; only confirmed actions pay this ordering cost.
      const screenPromise = screenshotTiming === "after-hierarchy"
        ? tree.then(() => { signal?.throwIfAborted(); return measureDebugPhase("screenshot", () => captureScreen(adbPath, serial)); })
        : measureDebugPhase("screenshot", () => captureScreen(adbPath, serial));
      const [treeRead, screenRead] = await Promise.allSettled([tree, screenPromise]);
      signal?.throwIfAborted();
      if (screenRead.status === "rejected") throw screenRead.reason;
      const screen = screenRead.value;
      await measureDebugPhase("geometry", () => {
        if (!screen.screenshotDataUrl || !screen.captureGeometry) throw new Error("截图失败，无法核对点击位置。");
        if (assessCaptureGeometry(screen.captureGeometry).status !== "checked") throw new Error("无法确认屏幕方向和尺寸，已暂停自动操作。");
      });
      if (treeRead.status === "rejected") throw treeRead.reason;
      const { xml, parsed } = treeRead.value;
      snapshot = {
        serial, root: parsed.root, nodeCount: countNodes(parsed.root), xmlSize: Buffer.byteLength(xml), rawXml: xml,
        screenshotDataUrl: screen.screenshotDataUrl, error: null,
        warning: "自动调试：轻量模式读取无障碍语义节点，不是完整绘制层级；独立图层请使用深度采集。",
        inspectionSource: "uiautomator", hierarchyDumpMode: "full",
        captureGeometry: { ...screen.captureGeometry!, hierarchyRotation: parsed.rotation },
      };
    }
    const after = await measureDebugPhase("target_after", () => checkedDebugTarget(adbPath, serial, packageName));
    await measureDebugPhase("geometry", () => {
      if (assessCaptureGeometry(snapshot.captureGeometry).status !== "checked") throw new Error("无法确认屏幕方向和尺寸，已暂停自动操作。");
      if (!sameActivityInstance(before, after) || before.windowId !== after.windowId)
        throw new DebugObservationError("window_changed", "采集期间窗口发生变化，请重新观察。");
    });
    deadline?.throwIfAborted();
    return { snapshot: { ...snapshot, captureMode: mode, captureDurationMs: Math.round(performance.now() - started) }, target: after };
  }, { backend: mode === "deep" ? "deep" : backend })).catch(async error => {
    if (backend === "accessibility-helper" && helperSession) await helperSession.release();
    throw error;
  });
}

async function readDebugHierarchy(adbPath: string, serial: string, packageName: string) {
  // One unique temporary file per request; never consume a previous dump after failure.
  const remote = `/data/local/tmp/android-ui-inspector-${randomUUID()}.xml`;
  try {
    const dump = await runCommand(adbPath, ["-s", serial, "shell", "uiautomator", "dump", remote], 15_000);
    if (dump.code !== 0) throw new Error(commandError("轻量控件读取失败", dump));
    const read = await runDeviceAdb(adbPath, serial, ["exec-out", "cat", remote]);
    const xml = read.stdout.toString("utf8");
    if (read.stdout.length > 8 * 1024 * 1024) throw new Error("控件树超过 8 MiB，已拒绝读取。");
    if (read.code !== 0) {
      const missingDump = read.stderr.includes(remote) && /No such file or directory/i.test(read.stderr);
      if (missingDump) throw new DebugObservationError("hierarchy_unavailable", "未获得有效的新控件树；不会用旧快照判断成功。");
      throw new Error(commandError("控件树读取失败", read));
    }
    if (!xml.includes("<hierarchy")) throw new DebugObservationError("hierarchy_unavailable", "未获得有效的新控件树；不会用旧快照判断成功。");
    const parsed = await measureDebugPhase("parse", () => parseUiHierarchy(xml));
    if (parsed.root.package !== packageName) throw new Error("读取到其他窗口的控件树，已拒绝继续。");
    return { xml, parsed };
  } finally {
    await measureDebugPhase("cleanup", () => withoutCommandSignal(() => runCommand(adbPath, ["-s", serial, "shell", "rm", "-f", remote], 3_000))).catch(() => undefined);
  }
}

export type { DebugInputAction } from "../../shared/types";

export function debugInputArgs(action: DebugInputAction): string[] {
  if (action.kind === "back") return ["-d", "0", "keyevent", "KEYCODE_BACK"];
  if (action.kind !== "tap" && action.kind !== "swipe") throw new Error("不支持的调试操作。");
  const coordinates = action.kind === "tap" ? [action.x, action.y] : [action.fromX, action.fromY, action.toX, action.toY];
  if (!coordinates.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000)) throw new Error("操作坐标无效。");
  if (action.kind === "swipe" && (!Number.isSafeInteger(action.durationMs) || action.durationMs < 150 || action.durationMs > 1000
    || (action.fromX === action.toX && action.fromY === action.toY))) throw new Error("滑动参数无效。");
  return ["touchscreen", "-d", "0", action.kind, ...coordinates.map(String), ...(action.kind === "swipe" ? [String(action.durationMs)] : [])];
}

export function inputDebugApp(serial: string, target: DebugTarget, action: DebugInputAction, frame: DisplayFrame, signal?: AbortSignal,
  onEvidence?: (evidence: DebugInputEvidence) => void) {
  return withCommandSignal(signal, async () => {
    const args = debugInputArgs(action);
    const adbPath = automationAdb(serial);
    const version = await runDeviceAdb(adbPath, serial, ["shell", "getprop", "ro.build.version.sdk"]);
    if (version.code !== 0) throw new Error("无法确认 Android 系统版本，未执行输入。");
    const route = inputInjectionRoute(version.stdout.toString("utf8").trim());
    const fresh = await measureDebugPhase("target_before", () => checkedDebugTarget(adbPath, serial, target.packageName));
    if (fresh.windowId !== target.windowId || !sameActivityInstance(target, fresh)) throw new Error("操作前窗口已变化，未执行操作。");
    const display = await measureDebugPhase("geometry", () => readDisplayFrame(adbPath, serial));
    if (!display || display.width !== frame.width || display.height !== frame.height || display.rotation !== frame.rotation) throw new Error("操作前屏幕方向或尺寸已变化，未执行操作。");
    const points = action.kind === "back" ? [] : action.kind === "tap" ? [[action.x, action.y]] : [[action.fromX, action.fromY], [action.toX, action.toY]];
    if (points.some(([x, y]) => x >= display.width || y >= display.height)) throw new Error("操作坐标不在屏幕内。");
    signal?.throwIfAborted();
    if (route === "legacy") {
      // Android 11 and earlier have no cmd input service; choose this route before sending anything.
      await measureDebugPhase("input", () => runDebugInputCommand(adbPath,
        ["-s", serial, "shell", "input", ...args], signal,
        evidence => onEvidence?.({ ...evidence, systemInjection: { status: "unavailable" } })));
      return;
    }
    const nonce = randomUUID().replace(/-/g, "");
    await measureDebugPhase("input", () => runDebugInputCommand(adbPath,
      ["-s", serial, "shell", buildInputInjectionCommand(args, nonce)], signal, onEvidence,
      { nonce, check: (marker, cancellation) => inspectSystemInputInjection(adbPath, serial, marker, cancellation) }));
  });
}
