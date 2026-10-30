import { layerImagePresentation } from "./layer-image-provenance";
import { nodeCaptureFacts, type NodeCaptureFacts } from "./node-capture-facts";
import type { InspectionSource, UiNode } from "./types";

export type NodePresentationCode = "user-hidden" | "device-hidden" | "waiting" | "missing" | "empty"
  | "failed" | "ambiguous" | "structural" | "captured" | "style" | "group" | "composite" | "outline";
export type NodePresentationTone = "muted" | "info" | "warning" | "error";
export type NodePresentationFact = {
  code: NodePresentationCode;
  label: string;
  detail: string;
  tone: NodePresentationTone;
};
export type NodePresentationContext = {
  // Hiding one plane does not hide its descendants in the current workbench.
  hiddenByUser?: "node";
  // Capture is still in progress; this does not assert a per-node image queue.
  waitingForImage?: boolean;
  inspectionSource?: InspectionSource;
  captureMode?: "fast" | "deep";
  // Actual renderer provenance, never inferred from the node's own bitmap.
  presentation?: { source: string; groupState: string };
};
export type NodePresentationStatus = NodePresentationFact & {
  badgeLabel: string | null;
  ownImage: NodePresentationFact;
  presentation?: NodePresentationFact;
  imageStatus: UiNode["layerImageStatus"];
  imageEmpty: UiNode["layerImageEmpty"];
};

function fact(code: NodePresentationCode, label: string, detail: string, tone: NodePresentationTone = "muted"): NodePresentationFact {
  return { code, label, detail, tone };
}

function ownImageFact(capture: NodeCaptureFacts, context: NodePresentationContext): NodePresentationFact {
  const hasImage = capture.hasNonBlankImageData;
  const source = capture.inspectionSource ?? context.inspectionSource;
  const fast = context.captureMode === "fast" || source === "uiautomator" || source === "accessibility-helper";
  if (capture.status === "hidden") return fact("device-hidden", "采集不可见", "独立画面采集报告控件或祖先不可见。");
  if (capture.status === "failed") return fact("failed", "采集失败", hasImage
    ? "独立画面采集标记为失败；当前数据仍保留了已有画面。"
    : capture.error?.trim() ? "独立画面采集失败。" : "独立画面采集失败，未返回具体原因。", "error");
  if (capture.status === "ambiguous") return fact("ambiguous", "匹配不明", "画面与控件的匹配有歧义，未使用匹配结果。", "warning");
  if (capture.empty === true) return fact("empty", "自身空图", "已检测的自身图片全透明；子层和折叠后的整组画面仍可能有内容。");
  if (hasImage) {
    if (capture.status === "style") return fact("style", "样式重建", "根据 QML 真实样式重建画面，未采集独立截图。", "info");
    if (capture.status === "captured") return fact("captured", "已采集", capture.empty === false
      ? "已采集自身独立画面，含可见像素。" : "已采集自身独立画面，透明度未检测。", "info");
    return fact("captured", "已提供画面", "当前数据保存了自身画面，未标注采集方式或透明度。", "info");
  }
  if (capture.skipDraw) return fact("structural", "无自身绘制", "系统报告此控件跳过自身绘制；子层仍可能有画面。");
  if (fast) return fact("missing", "无独立画面", "当前采集提供控件信息和整屏截图；画布可能裁剪截图展示叶片，裁剪图包含背景，不能作为独立画面。");
  if (context.waitingForImage) return fact("waiting", "等待画面", "本次采集仍在进行，尚未返回此控件的独立画面。", "info");
  if (capture.status === "captured") return fact("missing", "画面未提供", "记录为已采集，但当前数据未提供自身图片。", "warning");
  if (capture.status === "style") return fact("missing", "画面未提供", "记录为样式重建，但当前数据未提供重建画面。", "warning");
  if (capture.status === "unavailable") return fact("missing", "画面未提供", "本次未返回独立画面；这不代表控件透明。", "warning");
  return fact("missing", "画面未提供", "当前数据未记录独立画面或采集状态。", "muted");
}

function presentationFact(context: NodePresentationContext): NodePresentationFact | undefined {
  const provenance = context.presentation;
  if (!provenance || !["none", "live-group", "local-composite"].includes(provenance.source)) return undefined;
  const description = layerImagePresentation(provenance);
  return fact(provenance.source === "none" ? "outline" : provenance.source === "live-group" ? "group" : "composite",
    description.label, description.detail, provenance.source === "none" ? "muted" : "info");
}

// Only facts supplied by the snapshot or the current workspace affect this model.
// In particular, a missing own image cannot describe a collapsed branch as empty.
export function nodePresentationStatus(node: UiNode, context: NodePresentationContext = {}): NodePresentationStatus {
  const capture = nodeCaptureFacts(node);
  const ownImage = ownImageFact(capture, context);
  const presentation = presentationFact(context);
  const visibility = context.hiddenByUser === "node" ? fact("user-hidden", "已隐藏", "你在工作台中隐藏了此图层。")
    : !node.visibleToUser ? fact("device-hidden", "设备不可见", "设备报告此控件不可见。") : null;
  const current = visibility ?? (presentation && presentation.code !== "outline" ? presentation
    : presentation?.code === "outline" && ["captured", "style"].includes(ownImage.code) ? presentation : ownImage);
  const source = capture.inspectionSource ?? context.inspectionSource;
  const isFast = context.captureMode === "fast" || source === "uiautomator" || source === "accessibility-helper";
  const knowsImageCapture = Boolean(capture.status || context.captureMode === "deep"
    || ["debug-view", "debug-qml", "debug-hybrid"].includes(source ?? ""));
  const badges: Partial<Record<NodePresentationCode, string>> = {
    "user-hidden": "已隐藏", "device-hidden": "不可见", waiting: "等待", missing: "缺画面",
    empty: "自身空图", failed: "失败", ambiguous: "匹配不明",
  };
  const badgeLabel = current.code === "missing" && (isFast || !knowsImageCapture) ? null : badges[current.code] ?? null;
  return { ...current, badgeLabel, ownImage, ...(presentation ? { presentation } : {}),
    imageStatus: capture.status, imageEmpty: capture.empty };
}
