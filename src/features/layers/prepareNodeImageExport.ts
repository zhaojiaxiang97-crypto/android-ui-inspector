import type { UiNode } from "../../../shared/types";
import { composeSubtreeImage } from "../../../shared/layer-textures";
import { exportableImageSize, MAX_NODE_IMAGE_PIXELS, savedOwnRaster, type NodeImageExportPlan } from "../../../shared/node-image-export";

export async function prepareNodeImageExport(node: UiNode, plan: NodeImageExportPlan, signal: AbortSignal) {
  const check = () => { if (signal.aborted) throw new DOMException("图片准备已停止。", "AbortError"); };
  check();
  if (plan.kind === "unavailable") throw new Error(plan.detail);
  if (plan.kind !== "composite") return { dataUrl: plan.dataUrl, size: plan.size };
  const bounds = node.bounds!;
  const output = await composeSubtreeImage(node, { left: bounds.left, top: bounds.top, ...plan.size }, async current => {
    check();
    if (!savedOwnRaster(current) || !exportableImageSize(current.layerImageSize)) return null;
    const source = new Image(); source.src = current.layerImageDataUrl!;
    try {
      await source.decode(); check();
      const image = await createImageBitmap(source, { premultiplyAlpha: "none" });
      if (signal.aborted || image.width !== current.layerImageSize.width || image.height !== current.layerImageSize.height) {
        image.close(); check(); throw new Error("已保存图层的图片尺寸与记录不一致。");
      }
      return image;
    } finally { source.src = ""; }
  }, MAX_NODE_IMAGE_PIXELS);
  try {
    check();
    if (output.width !== plan.size.width || output.height !== plan.size.height) throw new Error("本地重建尺寸超出限制，未导出缩小的图片。");
    return { dataUrl: output.toDataURL("image/png"), size: plan.size };
  } finally { output.width = output.height = 0; }
}
