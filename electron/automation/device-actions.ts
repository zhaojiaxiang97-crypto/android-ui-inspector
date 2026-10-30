import type { ProviderClient } from "../sdk/provider-session";
import { runDebugInputCommand } from "../device/debug-input";
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


export type DebugObserver = (serial: string, packageName: string, mode: "fast" | "deep", signal?: AbortSignal,
  backend?: FastCaptureBackend) => Promise<{ snapshot: UiSnapshot; target: DebugTarget }>;

export function observeDebugApp(provider: ProviderClient, serial: string, packageName: string, mode: "fast" | "deep", signal?: AbortSignal,
  backend: FastCaptureBackend = "uiautomator"): ReturnType<DebugObserver> {
  if (backend !== "uiautomator" && (backend !== "accessibility-helper" || mode !== "fast")) throw new Error("Helper只支持fast只读采集。");
  const deadline = backend === "accessibility-helper" ? captureSignal(signal, 30_000) : signal;
  return withCommandSignal(deadline, async () => {
    const started = performance.now();
    const adbPath = automationAdb(serial);
    const before = await checkedDebugTarget(adbPath, serial, packageName);
    let snapshot: UiSnapshot;
    if (mode === "deep") {
      snapshot = await inspectPreferredDevice(provider, serial, { signal, expectedPackage: packageName, allowAppRestart: false });
      if (snapshot.error) throw new Error(snapshot.error);
    } else if (backend === "accessibility-helper") {
      const frame = await readDisplayFrame(adbPath, serial);
      if (!frame) throw new Error("无法确认Helper采集的主显示器。");
      const tree = await readAccessibilityHelper(adbPath, serial, packageName, frame, deadline!);
      const screen = await captureScreen(adbPath, serial);
      if (!screen.screenshotDataUrl || !screen.captureGeometry || screen.captureGeometry.afterScreenshot?.rotation !== frame.rotation
        || screen.captureGeometry.afterScreenshot.width !== frame.width || screen.captureGeometry.afterScreenshot.height !== frame.height)
        throw new Error("Helper截图失败或屏幕方向、尺寸发生变化。");
      snapshot = { serial, root: tree.root, nodeCount: tree.nodeCount, xmlSize: Buffer.byteLength(tree.xml), rawXml: tree.xml,
        screenshotDataUrl: screen.screenshotDataUrl, error: null, inspectionSource: "accessibility-helper",
        captureGeometry: { ...screen.captureGeometry, hierarchyRotation: frame.rotation },
        warning: "Helper无障碍语义树：提示与文本分别保留，系统装饰节点可能与UIAutomator不同；没有独立图层，仅支持只读观察。" };
    } else {
      // One unique temporary file per request; never consume a previous dump after failure.
      const remote = `/data/local/tmp/android-ui-inspector-${randomUUID()}.xml`;
      let xml: string;
      try {
        const dump = await runCommand(adbPath, ["-s", serial, "shell", "uiautomator", "dump", remote], 15_000);
        if (dump.code !== 0) throw new Error(commandError("轻量控件读取失败", dump));
        const read = await runDeviceAdb(adbPath, serial, ["exec-out", "cat", remote]);
        xml = read.stdout.toString("utf8");
        if (read.code !== 0 || !xml.includes("<hierarchy") || read.stdout.length > 8 * 1024 * 1024) throw new Error("未获得有效的新控件树；不会用旧快照判断成功。");
      } finally {
        await withoutCommandSignal(() => runCommand(adbPath, ["-s", serial, "shell", "rm", "-f", remote], 3_000)).catch(() => undefined);
      }
      const parsed = parseUiHierarchy(xml);
      if (parsed.root.package !== packageName) throw new Error("读取到其他窗口的控件树，已拒绝继续。");
      const screen = await captureScreen(adbPath, serial);
      if (!screen.screenshotDataUrl || !screen.captureGeometry) throw new Error("截图失败，无法核对点击位置。");
      snapshot = {
        serial, root: parsed.root, nodeCount: countNodes(parsed.root), xmlSize: Buffer.byteLength(xml), rawXml: xml,
        screenshotDataUrl: screen.screenshotDataUrl, error: null,
        warning: "自动调试：轻量模式读取无障碍语义节点，不是完整绘制层级；独立图层请使用深度采集。",
        inspectionSource: "uiautomator", hierarchyDumpMode: "full",
        captureGeometry: { ...screen.captureGeometry, hierarchyRotation: parsed.rotation },
      };
    }
    const after = await checkedDebugTarget(adbPath, serial, packageName);
    if (!sameActivityInstance(before, after) || before.windowId !== after.windowId) throw new Error("采集期间窗口发生变化，请重新观察。");
    if (assessCaptureGeometry(snapshot.captureGeometry).status !== "checked") throw new Error("无法确认屏幕方向和尺寸，已暂停自动操作。");
    deadline?.throwIfAborted();
    return { snapshot: { ...snapshot, captureMode: mode, captureDurationMs: Math.round(performance.now() - started) }, target: after };
  });
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
    const fresh = await checkedDebugTarget(adbPath, serial, target.packageName);
    if (fresh.windowId !== target.windowId || fresh.component !== target.component) throw new Error("操作前窗口已变化，未执行操作。");
    const display = await readDisplayFrame(adbPath, serial);
    if (!display || display.width !== frame.width || display.height !== frame.height || display.rotation !== frame.rotation) throw new Error("操作前屏幕方向或尺寸已变化，未执行操作。");
    const points = action.kind === "back" ? [] : action.kind === "tap" ? [[action.x, action.y]] : [[action.fromX, action.fromY], [action.toX, action.toY]];
    if (points.some(([x, y]) => x >= display.width || y >= display.height)) throw new Error("操作坐标不在屏幕内。");
    signal?.throwIfAborted();
    await runDebugInputCommand(adbPath, ["-s", serial, "shell", "input", ...args], signal, onEvidence);
  });
}
