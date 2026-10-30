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
    const source = new Image();
    const abortError = () => new DOMException("图片准备已停止。", "AbortError");
    let stop!: () => void;
    const aborted = new Promise<never>((_, reject) => { stop = () => { source.src = ""; reject(abortError()); }; });
    signal.addEventListener("abort", stop, { once: true });
    try {
      source.src = current.layerImageDataUrl!;
      await Promise.race([source.decode(), aborted]); check();
      // Bitmap creation cannot be cancelled. Keep ownership of a late result so
      // racing the abort never leaves its backing pixels alive after closing.
      const bitmap = createImageBitmap(source, { premultiplyAlpha: "none" }).then(image => {
        if (signal.aborted) { image.close(); throw abortError(); }
        return image;
      });
      const image = await Promise.race([bitmap, aborted]);
      if (signal.aborted || image.width !== current.layerImageSize.width || image.height !== current.layerImageSize.height) {
        image.close(); check(); throw new Error("已保存图层的图片尺寸与记录不一致。");
      }
      return image;
    } catch (error) { check(); throw error; }
    finally { signal.removeEventListener("abort", stop); source.src = ""; }
  }, MAX_NODE_IMAGE_PIXELS);
  try {
    check();
    if (output.width !== plan.size.width || output.height !== plan.size.height) throw new Error("本地重建尺寸超出限制，未导出缩小的图片。");
    return { dataUrl: output.toDataURL("image/png"), size: plan.size };
  } finally { output.width = output.height = 0; }
}
