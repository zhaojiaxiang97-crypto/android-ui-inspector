import type { PixelSize, UiNode } from "../../../shared/types";
import { exportableImageSize, type NodeImageExportPlan } from "../../../shared/node-image-export";
import { prepareNodeImageExport } from "./prepareNodeImageExport";

export type PreparedNodeImagePreview = { dataUrl: string; size: PixelSize };

/** Validate the saved bitmap before displaying dimensions or enabling pixel zoom. */
export async function prepareNodeImagePreview(node: UiNode, plan: NodeImageExportPlan, signal: AbortSignal): Promise<PreparedNodeImagePreview> {
  const prepared = await prepareNodeImageExport(node, plan, signal);
  if (signal.aborted) throw new DOMException("图片准备已停止。", "AbortError");
  const image = new Image();
  const abortError = () => new DOMException("图片准备已停止。", "AbortError");
  let stop!: () => void;
  const aborted = new Promise<never>((_, reject) => { stop = () => { image.src = ""; reject(abortError()); }; });
  signal.addEventListener("abort", stop, { once: true });
  try {
    image.src = prepared.dataUrl;
    await Promise.race([image.decode(), aborted]);
    if (signal.aborted) throw abortError();
    const size = { width: image.naturalWidth, height: image.naturalHeight };
    if (!exportableImageSize(size)) throw new Error("图片尺寸无效或超过预览限制。");
    if (prepared.size && (prepared.size.width !== size.width || prepared.size.height !== size.height)) {
      throw new Error("已保存图片的尺寸与记录不一致，无法准确预览。");
    }
    return { dataUrl: prepared.dataUrl, size };
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof DOMException && error.name === "EncodingError") throw new Error("已保存图片无法解码，请重新采集或检查快照。");
    throw error;
  } finally {
    signal.removeEventListener("abort", stop);
    image.src = "";
  }
}
