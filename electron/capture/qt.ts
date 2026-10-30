import { randomUUID } from "node:crypto";
import type { QmlGroupImage, UiBounds, UiNode, UiSnapshot } from "../../shared/types";
import { pngSize } from "../device/capture-display";
import { inspectQmlHierarchy, type QmlDebugNode, type QmlGrab } from "./qml-debug";
import { qmlColorCss, qmlStyleSvg } from "../../shared/qml-style";
import { textureDimensions } from "../../shared/layer-textures";
import { withCommandSignal, withoutCommandSignal } from "../device/command-context";
import { createCaptureRunContext, type CaptureRunContext } from "./run-context";
import { delay, type CommandResult, runDeviceAdb, commandError } from "../device/runtime";
import { type ForegroundTarget, singleAppPid, automationAdb, checkedDebugTarget, targetActivitySection } from "../device/target";
import { nodeById, appBounds } from "./native-tree";

const QML_DEBUG_PORT = 3768;

export function qmlUiTree(root: QmlDebugNode, packageName: string, viewport: UiBounds | null, images: ReadonlyMap<number, { dataUrl: string; width: number; height: number }> = new Map()): UiNode {
  const rootGeometry = root.geometry;
  const scaleX = viewport && rootGeometry?.width ? (viewport.right - viewport.left) / rootGeometry.width : 1;
  const scaleY = viewport && rootGeometry?.height ? (viewport.bottom - viewport.top) / rootGeometry.height : scaleX;
  const offsetX = viewport?.left ?? 0;
  const offsetY = viewport?.top ?? 0;
  const clickableType = /(Button|MouseArea|TapHandler|CheckBox|Switch|Slider|TextField|ComboBox)/i;

  const convert = (source: QmlDebugNode, id: string, index: number): UiNode => {
    const geometry = source.geometry;
    const bounds = geometry ? {
      left: Math.round(offsetX + geometry.x * scaleX),
      top: Math.round(offsetY + geometry.y * scaleY),
      right: Math.round(offsetX + (geometry.x + geometry.width) * scaleX),
      bottom: Math.round(offsetY + (geometry.y + geometry.height) * scaleY),
      raw: "",
    } : null;
    if (bounds) bounds.raw = `[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]`;
    const node: UiNode = {
      id,
      index,
      className: source.type || "QmlObject",
      package: packageName,
      text: geometry?.text || null,
      resourceId: source.idString || source.objectName || null,
      contentDesc: null,
      bounds,
      clickable: clickableType.test(source.type),
      enabled: geometry?.enabled ?? true,
      focusable: /(Focus|Input|TextField|Button)/i.test(source.type),
      focused: false,
      scrollable: /(Flickable|ListView|GridView|ScrollView)/i.test(source.type),
      selected: false,
      // QObject/attached-property wrappers have no geometry, but may own visual
      // descendants. Zero-size Items can also have unclipped visible children.
      visibleToUser: !geometry || (geometry.visible && geometry.effectiveOpacity > 0),
      attributes: {
        "inspection-source": "debug-qml",
        "qml-debug-id": String(source.debugId),
        "qml-context-id": String(source.contextId),
        "qml-parent-id": String(source.parentId),
        "qml-source": source.url,
        "qml-line": String(source.line),
        opacity: String(geometry?.opacity ?? 1),
        alpha: String(geometry?.opacity ?? 1),
        "effective-alpha": String(geometry?.effectiveOpacity ?? 1),
        "qml-clip": String(geometry?.clip ?? false),
        "qml-layer-enabled": String(geometry?.layerEnabled ?? false),
        z: String(geometry?.z ?? 0),
        "drawing-order": String(geometry?.z ?? index),
      },
      children: [],
    };
    if (geometry?.style && bounds && geometry.width > 0 && geometry.height > 0 && bounds.right > bounds.left && bounds.bottom > bounds.top) {
      const style = geometry.style;
      const imageSize = textureDimensions(bounds.right - bounds.left, bounds.bottom - bounds.top);
      const svg = qmlStyleSvg(style, geometry, imageSize, scaleX);
      node.layerImageDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
      delete node.layerCapturePlacement;
      node.layerImageSize = imageSize;
      node.layerImageStatus = "style";
      Object.assign(node.attributes!, {
        "background-color": style.fill ? qmlColorCss(style.fill) : "未暴露",
        "border-color": style.border ? qmlColorCss(style.border) : "未暴露",
        "border-width": String(style.borderWidth * scaleX),
        "border-status": style.borderValidityUnknown ? "默认黑色 1px 边框的启用状态未暴露，未绘制" : "已读取",
        "corner-radii": style.radii.map((r) => r * scaleX).join(" / "),
        "background-gradient": style.unsupportedGradient ? "不支持的渐变预设，未绘制填充" : style.gradient ? JSON.stringify(style.gradient) : "none",
      });
    }
    const image = images.get(source.debugId);
    if (image && bounds) {
      node.layerImageDataUrl = image.dataUrl;
      delete node.layerCapturePlacement;
      node.layerImageSize = { width: image.width, height: image.height };
      node.layerImageStatus = "captured";
    }
    node.children = source.children.map((child, childIndex) => convert(child, `${id}/${childIndex}`, childIndex));
    return node;
  };
  return convert(root, "0", 0);
}

async function readQmlGrabs(adbPath: string, serial: string, packageName: string, appDir: string, grabs: QmlGrab[], signal?: AbortSignal) {
  const images = new Map<number, { dataUrl: string; width: number; height: number }>();
  if (!grabs.length) return images;
  const prefix = `${appDir}/`;
  try {
    await delay(300);
    for (let start = 0; start < grabs.length; start += 4) {
      await Promise.all(grabs.slice(start, start + 4).map(async (grab) => {
        if (!grab.path.startsWith(prefix)) return;
        const file = grab.path.slice(prefix.length);
        for (let attempt = 0; attempt < 4; attempt++) {
          let result: CommandResult;
          try { result = await runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", "3000001", file]); }
          catch { signal?.throwIfAborted(); return; }
          const size = result.code === 0 && result.stdout.length <= 3_000_000 ? pngSize(result.stdout) : null;
          if (size && size.width * size.height <= 2_000_000
            && Math.abs(size.width / size.height - grab.width / grab.height) <= grab.width / grab.height * 0.05) {
            images.set(grab.debugId, { dataUrl: `data:image/png;base64,${result.stdout.toString("base64")}`, ...size });
            return;
          }
          await delay(250);
        }
      }));
    }
  } finally {
    await withoutCommandSignal(() => runDeviceAdb(adbPath, serial, ["shell", "run-as", packageName, "rm", "-f", ...grabs.map((grab) => grab.path.slice(prefix.length))])).catch(() => undefined);
  }
  return images;
}

export async function qmlDebugTree(adbPath: string, serial: string, target: ForegroundTarget, groupDebugId: number | undefined, context: CaptureRunContext) {
  const signal = context.signal;
  return withCommandSignal(signal, async () => {
    signal?.throwIfAborted();
    const forward = await withoutCommandSignal(() => runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `tcp:${QML_DEBUG_PORT}`]));
    if (forward.code !== 0) throw new Error(commandError("无法转发 QML 调试端口", forward));
    const port = Number(forward.stdout.toString("utf8").trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("QML 调试转发端口无效。");

    try {
      signal?.throwIfAborted();
      let directory: CommandResult | null = null;
      try { directory = await runDeviceAdb(adbPath, serial, ["shell", "run-as", target.packageName, "pwd"]); }
      catch { signal?.throwIfAborted(); }
      const appDir = directory?.stdout.toString("utf8").trim() ?? "";
      const canGrab = directory?.code === 0 && /^\/data\/(?:user(?:_de)?\/\d+|data)\/[\w.]+$/.test(appDir) && appDir.endsWith(`/${target.packageName}`);
      const capture = async () => {
        const processId = await singleAppPid(adbPath, serial, target.packageName);
        const inspected = await inspectQmlHierarchy(port, signal, canGrab ? { appDir, nonce: randomUUID(), groupDebugId } : undefined);
        let images = new Map<number, { dataUrl: string; width: number; height: number }>();
        let captureWarning = !canGrab ? "无法定位 Qt App 私有缓存目录，已保留控件树。" : inspected.grabFailed ? "部分 Qt 控件截图请求失败，已保留控件树。" : null;
        try { images = await readQmlGrabs(adbPath, serial, target.packageName, appDir, inspected.grabs, signal); }
        catch { signal?.throwIfAborted(); captureWarning = "Qt 控件截图读取失败，已保留控件树。"; }
        if (inspected.grabs.length && images.size < inspected.grabs.length) captureWarning ??= `仅取得 ${images.size}/${inspected.grabs.length} 张 Qt 独立画面。`;
        if (processId !== await singleAppPid(adbPath, serial, target.packageName)) throw new Error("Qt App 进程已变化，请重新采集。");
        return { root: inspected.root, images, captureWarning, processId };
      };
      if (context.options.allowAppRestart === false) {
        // Automated observation must never reset the page it is trying to verify.
        return { ...await capture(), restarted: false };
      }
      try {
        const captured = await capture();
        return { ...captured, restarted: false };
      } catch {
        signal?.throwIfAborted();
      }

      await runDeviceAdb(adbPath, serial, ["shell", "am", "force-stop", target.packageName]);
      const start = await runDeviceAdb(adbPath, serial, [
        "shell", "am", "start", "-n", target.component,
        "--es", "applicationArguments", `-qmljsdebugger=port:${QML_DEBUG_PORT},services:QmlDebugger`,
      ]);
      if (start.code !== 0 || /\bError:/.test(start.stdout.toString("utf8"))) {
        throw new Error(commandError("无法以 QML Debug 模式启动目标 App", start));
      }

      let lastError: unknown = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const captured = await capture();
          return { ...captured, restarted: true };
        } catch (error) {
          signal?.throwIfAborted();
          lastError = error;
          await delay(250);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("无法连接 QML Debug 服务。");
    } finally {
      await withoutCommandSignal(() => runDeviceAdb(adbPath, serial, ["forward", "--remove", `tcp:${port}`])).catch(() => undefined);
    }
  });
}

export function qmlGroupNodeMatches(expected: UiNode, current: UiNode): boolean {
  const a = expected.bounds, b = current.bounds;
  return expected.id === current.id && expected.className === current.className
    && expected.package === current.package && expected.resourceId === current.resourceId
    && expected.children.length > 0 && current.children.length > 0
    && expected.visibleToUser && current.visibleToUser && Boolean(a && b)
    && a!.left === b!.left && a!.top === b!.top && a!.right === b!.right && a!.bottom === b!.bottom
    && ["qml-debug-id", "qml-context-id", "qml-parent-id", "qml-source", "qml-line"].every(key => expected.attributes?.[key] === current.attributes?.[key]);
}

export function captureQmlGroupImage(serial: string, snapshot: UiSnapshot, nodeId: string, signal?: AbortSignal): Promise<QmlGroupImage | null> {
  const context = createCaptureRunContext({ signal, allowAppRestart: false });
  return withCommandSignal(signal, async () => {
    const root = snapshot.root, packageName = root?.package;
    if (snapshot.inspectionSource !== "debug-qml" || !root || !packageName || snapshot.serial !== serial) return null;
    const expected = nodeById(root, nodeId);
    const debugId = Number(expected?.attributes?.["qml-debug-id"]);
    const processId = Number(root.attributes?.["qml-process-id"]);
    const windowId = root.attributes?.["qml-window-id"];
    if (!expected?.bounds || !expected.children.length || !Number.isSafeInteger(debugId) || debugId < 1
      || !Number.isSafeInteger(processId) || processId < 1 || !windowId) return null;
    const adbPath = automationAdb(serial);
    const before = await checkedDebugTarget(adbPath, serial, packageName);
    if (before.windowId !== windowId || processId !== await singleAppPid(adbPath, serial, packageName)) return null;
    const top = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", packageName]);
    if (top.code !== 0) return null;
    const section = targetActivitySection(top.stdout.toString("utf8"), before);
    if (!section.includes("org.qtproject.qt.android.")) return null;
    const captured = await qmlDebugTree(adbPath, serial, before, debugId, context);
    const current = nodeById(qmlUiTree(captured.root, packageName, appBounds(section)), nodeId);
    const image = captured.images.get(debugId);
    const after = await checkedDebugTarget(adbPath, serial, packageName);
    if (!current || !qmlGroupNodeMatches(expected, current) || !image || captured.processId !== processId
      || after.windowId !== windowId || processId !== await singleAppPid(adbPath, serial, packageName)) return null;
    return { dataUrl: image.dataUrl, size: { width: image.width, height: image.height }, capturedAt: new Date().toISOString() };
  });
}
