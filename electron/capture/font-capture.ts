import type { UiNode, UiSnapshot } from "../../shared/types";
import type { ViewFontResult } from "../../shared/view-font";
import type { InspectionMode } from "../../shared/inspection-mode";
import type { ProviderClient } from "../sdk/provider-session";
import { automationAdb, checkedDebugTarget, singleAppPid, targetActivitySection } from "../device/target";
import { runDeviceAdb } from "../device/runtime";
import { withCommandSignal, withoutCommandSignal } from "../device/command-context";
import { debugViewTree, applyViewProperties, nodeById } from "./native-tree";
import { captureViewLayers } from "./view-debug";
import { windowAcceleration } from "../sdk/capture-protocol";
import { readViewFont } from "./view-font";

const ports = { automationAdb, checkedDebugTarget, singleAppPid, runDeviceAdb, debugViewTree, applyViewProperties, captureViewLayers, readViewFont };

// Match native object identity, not tree row IDs: SDK trees can insert wrappers.
function nativePath(root: UiNode, ref: string): UiNode[] {
  const matches: UiNode[][] = [];
  const visit = (node: UiNode, ancestors: UiNode[]) => {
    const path = node.attributes?.["view-ref"] ? [...ancestors, node] : ancestors;
    if (node.attributes?.["view-ref"] === ref) matches.push(path);
    node.children.forEach(child => visit(child, path));
  };
  visit(root, []);
  if (matches.length !== 1) throw new Error("控件身份不唯一或已消失，请重新采集整页。");
  return matches[0];
}

function requireSamePath(expected: UiNode[], current: UiNode[]) {
  if (expected.length !== current.length || expected.some((node, index) => {
    const other = current[index], a = node.bounds, b = other.bounds;
    return node.attributes?.["view-ref"] !== other.attributes?.["view-ref"] || node.className !== other.className
      || Boolean(a) !== Boolean(b) || a && b && (a.left !== b.left || a.top !== b.top || a.right !== b.right || a.bottom !== b.bottom);
  })) throw new Error("控件或父层身份、位置已变化，请重新采集整页。");
}

/** Explicit, bounded, SDK-independent reading of one live TextPaint. */
export function createFontCapture(overrides: Partial<typeof ports> = {}) {
  const io = { ...ports, ...overrides };
  return (_provider: ProviderClient, serial: string, snapshot: UiSnapshot, nodeId: string, signal?: AbortSignal,
    _mode: InspectionMode = "standard"): Promise<ViewFontResult> => withCommandSignal(signal, async () => {
    signal?.throwIfAborted();
    if (!["debug-view", "debug-hybrid"].includes(snapshot.inspectionSource ?? "") || snapshot.serial !== serial)
      throw new Error("字体读取仅支持当前设备的实时 Debug 快照。");
    const root = snapshot.root, packageName = root?.package, node = root && nodeById(root, nodeId);
    const ref = node?.attributes?.["view-ref"], rootRef = root?.children[0]?.attributes?.["view-ref"];
    const processId = Number(root?.attributes?.["debug-process-id"]);
    const component = root?.attributes?.["debug-component"], windowId = root?.attributes?.["debug-window-id"], windowName = root?.attributes?.["debug-window-name"];
    if (!root || !packageName || !node || !ref || !rootRef || !component || !windowId || !windowName
      || !Number.isSafeInteger(processId) || processId < 1) throw new Error("快照缺少字体读取所需的控件或窗口身份，请重新采集。");
    const expected = nativePath(root, ref), adbPath = io.automationAdb(serial);
    const checkTarget = async () => {
      const [target, pid] = await Promise.all([io.checkedDebugTarget(adbPath, serial, packageName), io.singleAppPid(adbPath, serial, packageName)]);
      if (target.component !== component || target.windowId !== windowId || pid !== processId)
        throw new Error("目标 App、进程或窗口已变化，请重新采集整页。");
      return target;
    };
    const before = await checkTarget();
    signal?.throwIfAborted();
    const forwarded = await withoutCommandSignal(() => io.runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `jdwp:${processId}`]));
    const port = forwarded.stdout.toString("utf8").trim();
    if (forwarded.code !== 0 || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("无法连接当前 Debug App。");
    try {
      const readPath = async () => {
        signal?.throwIfAborted();
        const activity = await io.runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", packageName]);
        if (activity.code !== 0) throw new Error("无法核对当前控件树，请重新采集。");
        const current = io.debugViewTree(targetActivitySection(activity.stdout.toString("utf8"), before), before);
        let actualWindow = "";
        await io.captureViewLayers(Number(port), { rootRefs: [rootRef], skipImages: true, signal,
          onHierarchy: (dump, name) => { io.applyViewProperties(current, dump, true); actualWindow = name; } });
        if (actualWindow !== windowName) throw new Error("当前窗口已变化，请重新采集。");
        const path = nativePath(current, ref);
        requireSamePath(expected, path);
        return path;
      };
      const first = await readPath();
      signal?.throwIfAborted();
      const acceleration = windowAcceleration(root);
      const result = await io.readViewFont(Number(port), { rootRef, windowName,
        hardwareAccelerated: acceleration === "true" ? true : acceleration === "false" ? false : undefined }, ref, signal);
      requireSamePath(first, await readPath());
      await checkTarget();
      signal?.throwIfAborted();
      if (result.ref !== ref) throw new Error("字体结果与当前控件不匹配。");
      return result;
    } finally {
      await withoutCommandSignal(() => io.runDeviceAdb(adbPath, serial, ["forward", "--remove", `tcp:${port}`])).catch(() => undefined);
      signal?.throwIfAborted();
    }
  });
}

export const captureViewFont = createFontCapture();
