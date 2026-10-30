import type { LayerImageCaptureResult, LayerImageUpdate, UiNode, UiSnapshot } from "../../shared/types";
import type { InspectionMode } from "../../shared/inspection-mode";
import type { ProviderClient } from "../sdk/provider-session";
import { automationAdb, checkedDebugTarget, singleAppPid, targetActivitySection } from "../device/target";
import { runDeviceAdb } from "../device/runtime";
import { withCommandSignal, withoutCommandSignal } from "../device/command-context";
import { nodeById, nativeViewNodeMatches } from "./native-tree";
import { buildReadCurrent } from "./refresh";
import { bitmapTarget } from "./sdk-images";
import { captureViewBitmaps } from "./view-bitmaps";
import { createCaptureRunContext } from "./run-context";

const MAX_DEMAND_IMAGES = 32;
const ports = { automationAdb, checkedDebugTarget, singleAppPid, runDeviceAdb, buildReadCurrent, captureViewBitmaps };
type DemandPorts = typeof ports;

function sameBounds(a: UiNode["bounds"], b: UiNode["bounds"]): boolean {
  return Boolean(a && b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom);
}

/** Only pixel data may change: the requested path, ancestors and geometry must remain identical. */
function requireUnchangedNodes(expectedRoot: UiNode, currentRoot: UiNode, ids: readonly string[]): UiNode[] {
  return ids.map(id => {
    if (!nativeViewNodeMatches(expectedRoot, currentRoot, id))
      throw new Error("控件身份或层级已变化，请重新采集整页。");
    let currentId = id;
    while (true) {
      const expected = nodeById(expectedRoot, currentId), current = nodeById(currentRoot, currentId);
      if (!expected || !current || !sameBounds(expected.bounds, current.bounds)
        || expected.visibleToUser !== current.visibleToUser)
        throw new Error("控件或父层的位置、可见性已变化，请重新采集整页。");
      if (currentId === expectedRoot.id) break;
      currentId = currentId.slice(0, currentId.lastIndexOf("/"));
    }
    return nodeById(currentRoot, id)!;
  });
}

/** One bounded bitmap session serves a visible branch; the original tree is never replaced. */
export function createLayerImageCapture(overrides: Partial<DemandPorts> = {}) {
  const io = { ...ports, ...overrides };
  return (provider: ProviderClient, serial: string, snapshot: UiSnapshot, nodeIds: string[], signal?: AbortSignal,
    mode: InspectionMode = "standard"): Promise<LayerImageCaptureResult> => withCommandSignal(signal, async () => {
    signal?.throwIfAborted();
    if (mode !== "standard" || snapshot.inspectionSource !== "debug-view" || snapshot.serial !== serial)
      throw new Error("按需图层仅支持当前设备的标准模式快照，请重新采集。");
    if (!Array.isArray(nodeIds) || !nodeIds.length || nodeIds.length > MAX_DEMAND_IMAGES
      || nodeIds.some(id => typeof id !== "string") || new Set(nodeIds).size !== nodeIds.length)
      throw new Error(`每次请选择 1–${MAX_DEMAND_IMAGES} 个不同控件读取图层。`);
    const root = snapshot.root, packageName = root?.package;
    const rootRef = root?.children[0]?.attributes?.["view-ref"];
    const processId = Number(root?.attributes?.["debug-process-id"]);
    const component = root?.attributes?.["debug-component"], windowId = root?.attributes?.["debug-window-id"];
    const windowName = root?.attributes?.["debug-window-name"];
    if (!root || !packageName || !rootRef || !component || !windowId || !windowName
      || !Number.isSafeInteger(processId) || processId < 1
      || root.attributes?.["sdk-process-instance"] || root.attributes?.["sdk-visible-process-instance"])
      throw new Error("这份快照缺少按需取图所需的窗口身份，请重新采集。");
    const requested = nodeIds.map(id => nodeById(root, id));
    if (requested.some(node => !node || node.id === root.id || !node.visibleToUser || !node.attributes?.["view-ref"]
      || !node.bounds || node.bounds.right <= node.bounds.left || node.bounds.bottom <= node.bounds.top
      || !["deferred", "failed"].includes(node.layerImageStatus ?? "") || node.layerImageDataUrl)
      || new Set(requested.map(node => node?.attributes?.["view-ref"])).size !== nodeIds.length)
      throw new Error("请求包含无效或已取得画面的控件，请重新选择。");

    const started = performance.now(), timings: Record<string, number> = {};
    const measure = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const at = performance.now();
      try { return await work(); } finally { timings[name] = Math.round(performance.now() - at); }
    };
    const adbPath = io.automationAdb(serial);
    const sameProcess = async () => await io.singleAppPid(adbPath, serial, packageName) === processId;
    const [before, processMatches, activity] = await Promise.all([
      measure("检查前台", () => io.checkedDebugTarget(adbPath, serial, packageName)),
      measure("检查进程", sameProcess),
      measure("读取Activity", () => io.runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", packageName])),
    ]);
    if (before.component !== component || before.windowId !== windowId || !processMatches)
      throw new Error("目标 App、进程或窗口已变化，请重新采集整页。");
    if (activity.code !== 0) throw new Error("无法核对当前控件树，请重新采集整页。");
    const section = targetActivitySection(activity.stdout.toString("utf8"), before);
    signal?.throwIfAborted();
    const forwarded = await measure("建立转发", () => withoutCommandSignal(() => io.runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `jdwp:${processId}`])));
    const port = forwarded.stdout.toString("utf8").trim();
    if (forwarded.code !== 0 || !/^\d+$/.test(port)) throw new Error("无法连接当前 Debug App。");
    try {
      signal?.throwIfAborted();
      const context = createCaptureRunContext({ signal, allowAppRestart: false, inspectionMode: "standard" });
      const readCurrent = io.buildReadCurrent(provider, { adbPath, serial, packageName, snapshot, root, section, before, port,
        rootRef, windowName, processId, branch: false, nodeId: nodeIds[0], context });
      const first = await measure("抓图前读树与校验", readCurrent);
      const nodes = requireUnchangedNodes(root, first.root, nodeIds);
      signal?.throwIfAborted();
      const capture = await measure("按需独立取图", () => io.captureViewBitmaps(Number(port),
        bitmapTarget(provider, adbPath, serial, packageName, root, rootRef, windowName, "standard"),
        nodes.map(node => ({ ref: node.attributes!["view-ref"], captureOwn: true })), signal));
      const second = await measure("抓图后读树与校验", readCurrent);
      requireUnchangedNodes(root, second.root, nodeIds);
      requireUnchangedNodes(first.root, second.root, nodeIds);
      const [after, processStillMatches] = await Promise.all([
        measure("复核前台", () => io.checkedDebugTarget(adbPath, serial, packageName)), measure("复核进程", sameProcess),
      ]);
      if (after.component !== before.component || after.windowId !== windowId || !processStillMatches)
        throw new Error("取图期间 App、进程或窗口已变化，请重新采集整页。");
      const updates: LayerImageUpdate[] = [], failures: LayerImageCaptureResult["failures"] = [];
      for (const node of nodes) {
        const ref = node.attributes!["view-ref"], image = capture.images.get(ref), skipped = capture.skipDraw.has(ref);
        const reason = image && (image.width !== node.bounds!.right - node.bounds!.left || image.height !== node.bounds!.bottom - node.bounds!.top)
          ? "控件画面尺寸已变化，请重新采集整页。" : !image && !skipped ? capture.failures.get(ref) ?? "未取得控件独立画面，可重试此分支。" : null;
        if (reason) {
          failures.push({ id: node.id, message: reason });
          updates.push({ id: node.id, bounds: node.bounds, layerImageStatus: "failed", imageCaptureError: reason });
          continue;
        }
        const kind = capture.kinds.get(ref);
        updates.push({ id: node.id, bounds: node.bounds, layerImageStatus: image ? "captured" : "unavailable",
          layerImageDataUrl: image?.imageDataUrl, layerImageSize: image ? { width: image.width, height: image.height } : undefined,
          layerImageEmpty: image?.empty, imageCaptureSource: "jdwp", imageCaptureError: undefined,
          imageSource: image ? kind === "surface" ? "SurfaceView / OpenGL 独立缓冲层" : kind === "texture" ? "TextureView 自身缓冲区"
            : "按对象身份独立采集，不含子节点" : "结构容器，系统跳过自身绘制", skipDraw: skipped ? "true" : "false" });
      }
      for (const [name, value] of Object.entries(capture.timing)) if (name.endsWith("Ms")) timings[`取图明细.${name}`] = value;
      signal?.throwIfAborted();
      return { updates, failures, timings };
    } finally {
      await measure("移除转发", () => withoutCommandSignal(() => io.runDeviceAdb(adbPath, serial, ["forward", "--remove", `tcp:${port}`]))).catch(() => undefined);
      timings["总耗时"] = Math.round(performance.now() - started);
    }
  });
}

export const captureViewLayerImages = createLayerImageCapture();
