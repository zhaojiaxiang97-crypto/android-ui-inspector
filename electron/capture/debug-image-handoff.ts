import type { UiNode } from "../../shared/types";
import { withCommandSignal } from "../device/command-context";
import { captureSignal } from "../device/runtime";
import { notifyViewTreeReady, type CaptureRunContext } from "./run-context";
import type { InspectionPreview } from "./types";
import { applyViewProperties } from "./native-tree";
import { captureViewLayers } from "./view-debug";

type PropertyHandoff = {
  port: number; packageName: string; root: UiNode; context: CaptureRunContext;
  stage(name: string): void; preview?: InspectionPreview; timings?: Record<string, number>;
  onBatchTiming: NonNullable<Parameters<typeof captureViewLayers>[1]>["onBatchTiming"];
};

/** Property export verifies the tree before the same request decides whether to skip DDMS pixels. */
export async function readDebugPropertiesAndImages(input: PropertyHandoff,
  ports = { captureViewLayers, applyViewProperties }) {
  const { root, context, packageName, stage, preview, timings } = input;
  let windowName = "";
  const layers = await ports.captureViewLayers(input.port, {
    rootRefs: root.children.map(node => node.attributes?.["view-ref"]).filter((value): value is string => Boolean(value)),
    onHierarchyTiming: info => {
      if (timings) for (const [name, value] of [["属性协议：连接", info.connectMs], ["属性协议：窗口列表", info.windowsMs],
        ["属性协议：身份探测", info.probeMs], ["属性协议：V2读取", info.exportMs], ["属性协议：主机解码", info.decodeMs],
        ["属性协议：合计", info.totalMs]] as const) timings[name] = Math.round(value);
      root.attributes = { ...root.attributes, "view-property-probe-requests": String(info.probeRequests),
        "view-property-export-requests": String(info.exportRequests), "view-property-success": String(info.success), "view-property-phase": info.phase };
    },
    onHierarchy: async (dump, name) => {
      ports.applyViewProperties(root, dump, true); windowName = name;
      root.attributes = { ...root.attributes, "debug-window-name": name };
      await preview?.("tree"); stage("核对 SDK 控件树");
      await notifyViewTreeReady(context, packageName, root);
      stage(context.plan.imageRoute === "sdk" ? "SDK 抓取独立画面" : "DDMS 批量抓图");
    },
    onBatchTiming: input.onBatchTiming,
    skipImages: () => context.plan.imageRoute === "sdk",
    signal: context.signal,
  });
  return { layers, windowName };
}

/** Publish first, then start one parallel screenshot only if the caller still wants this capture. */
export async function startFinalScreenAfterPreview<T>(preview: InspectionPreview | undefined, signal: AbortSignal | undefined,
  readScreen: () => Promise<T>, timeoutMs: number): Promise<{ finalScreen: Promise<T | null> }> {
  await preview?.("layers");
  signal?.throwIfAborted();
  const finalScreen = (async () => {
    try { return await withCommandSignal(captureSignal(signal, timeoutMs), readScreen); }
    catch { signal?.throwIfAborted(); return null; }
  })();
  void finalScreen.catch(() => undefined);
  return { finalScreen };
}
