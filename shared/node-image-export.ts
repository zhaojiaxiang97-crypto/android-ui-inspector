import type { PixelSize, QmlGroupImage, UiNode } from "./types";

export type NodeImageScope = "own" | "branch";
export const MAX_NODE_IMAGE_PIXELS = 16_000_000;
export const MAX_NODE_IMAGE_EDGE = 16_384;
export const MAX_NODE_IMAGE_DATA_LENGTH = 96 * 1024 * 1024;
const MAX_COMPOSITE_EDGE = 4096;
type Description = { label: string; detail: string; fileTag: string };
export type NodeImageExportPlan = Description & (
  | { kind: "own" | "group"; dataUrl: string; size: PixelSize | null }
  | { kind: "composite"; size: PixelSize; missingCount: number }
  | { kind: "unavailable" }
);

export function savedRaster(data: unknown): data is string {
  return typeof data === "string" && data.length <= MAX_NODE_IMAGE_DATA_LENGTH
    && /^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(data);
}
export function exportableImageSize(size: PixelSize | null | undefined): size is PixelSize {
  return Boolean(size && Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height)
    && size.width > 0 && size.height > 0 && size.width <= MAX_NODE_IMAGE_EDGE && size.height <= MAX_NODE_IMAGE_EDGE
    && size.width * size.height <= MAX_NODE_IMAGE_PIXELS);
}
export function savedOwnRaster(node: UiNode) {
  return node.layerImageStatus !== "style" && savedRaster(node.layerImageDataUrl);
}
export function nodeImageExportPlan(node: UiNode, scope: NodeImageScope, group: QmlGroupImage | null = null): NodeImageExportPlan {
  const unavailable = (detail: string): NodeImageExportPlan => ({ kind: "unavailable", label: "没有可导出的图片", detail, fileTag: "missing" });
  if (scope === "own") {
    if (!savedOwnRaster(node)) return unavailable(node.layerImageStatus === "style" ? "只有样式重建，未保存独立位图。"
      : node.attributes?.["image-capture-error"] || "当前没有保存此控件的独立图片，不代表透明。");
    if (node.layerImageSize && !exportableImageSize(node.layerImageSize)) return unavailable("独立图片尺寸无效或超过导出限制。");
    const source = node.attributes?.["image-capture-source"];
    const sourceLabel = source === "sdk" ? "SDK" : source === "ddms" ? "View Debug" : "来源未标注";
    return { kind: "own", dataUrl: node.layerImageDataUrl!, size: node.layerImageSize ?? null,
      label: `自身独立图 · ${sourceLabel}`, detail: "保留采集图片的尺寸与透明度；不含子层，不叠加画布强调或外部透明度。", fileTag: "own" };
  }
  if (group) {
    if (!savedRaster(group.dataUrl) || !exportableImageSize(group.size)) return unavailable("已保存整组图无效，不能当作可用画面导出。");
    return { kind: "group", dataUrl: group.dataUrl, size: group.size, label: "此分支 · 已保存原生整组图",
      detail: `采集于 ${group.capturedAt}；可能与快照不同帧，来源不代表逐像素校验通过。`, fileTag: "native-group" };
  }
  const bounds = node.bounds;
  const size = bounds && { width: Math.ceil(bounds.right - bounds.left), height: Math.ceil(bounds.bottom - bounds.top) };
  if (!bounds || ![bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite) || !exportableImageSize(size)
    || size.width > MAX_COMPOSITE_EDGE || size.height > MAX_COMPOSITE_EDGE) return unavailable("本地分支重建需要有效外框，边长不超过4096 px，总像素不超过1600万。");
  let pixels = 0, missingCount = 0;
  const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (!current.visibleToUser) continue;
    if (savedOwnRaster(current) && exportableImageSize(current.layerImageSize) && current.bounds) pixels++;
    else if (!current.layerImageEmpty && current.attributes?.["skip-draw"] !== "true") missingCount++;
    pending.push(...current.children);
  }
  if (!pixels) return unavailable("此分支没有已保存的独立位图或原生整组图，无法重建；不会从整屏截图裁图。");
  return { kind: "composite", size, missingCount, fileTag: missingCount ? "local-partial" : "local-branch",
    label: `此分支 · 本地重建${missingCount ? `（缺 ${missingCount} 层画面）` : ""}`,
    detail: "仅合成已保存的独立位图，包含设备可见子层，不受画布折叠或隐藏影响；缺失部分不代表透明，不保证与原生整组图逐像素一致。" };
}
