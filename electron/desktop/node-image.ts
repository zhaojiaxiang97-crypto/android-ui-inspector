import sharp from "sharp";
import { basename } from "node:path";
import type { ExportSnapshotResult, NodeImageOutputRequest } from "../../shared/types";
import { exportableImageSize, MAX_NODE_IMAGE_DATA_LENGTH, MAX_NODE_IMAGE_PIXELS, savedRaster } from "../../shared/node-image-export";

type OutputPorts = {
  choosePath: (defaultFileName: string) => Promise<string | null>;
  write: (path: string, bytes: Buffer) => Promise<void>;
  copy: (bytes: Buffer) => void | Promise<void>;
};

export async function prepareNodeImage(input: unknown) {
  const request = input as Partial<NodeImageOutputRequest> | null;
  if (!request || (request.action !== "save" && request.action !== "copy") || !savedRaster(request.dataUrl)
    || typeof request.defaultFileName !== "string" || request.defaultFileName.length > 256
    || request.size !== null && !exportableImageSize(request.size)) throw new Error("控件图片参数、格式或尺寸无效。");
  const match = /^data:image\/(png|webp|jpeg);base64,(.*)$/.exec(request.dataUrl)!;
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.toString("base64") !== match[2]) throw new Error("控件图片编码无效。");
  const image = sharp(bytes, { limitInputPixels: MAX_NODE_IMAGE_PIXELS, failOn: "warning" });
  const metadata = await image.metadata();
  const size = { width: metadata.width ?? 0, height: metadata.height ?? 0 };
  if (metadata.format !== match[1] || (metadata.pages ?? 1) !== 1 || !exportableImageSize(size)
    || request.size && (request.size.width !== size.width || request.size.height !== size.height)) throw new Error("控件图片内容与记录的格式或尺寸不一致。");
  // Fully decode before opening a dialog or changing the clipboard.
  const png = await image.png().toBuffer();
  if (png.length * 4 / 3 + 32 > MAX_NODE_IMAGE_DATA_LENGTH) throw new Error("导出的控件图片过大。");
  const name = basename(request.defaultFileName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\.png$/i, "").trim().slice(0, 160);
  return { bytes: png, action: request.action, defaultFileName: `android-ui-${name || "control"}.png` };
}

export async function outputNodeImage(input: unknown, ports: OutputPorts): Promise<ExportSnapshotResult> {
  try {
    const image = await prepareNodeImage(input);
    if (image.action === "copy") { await ports.copy(image.bytes); return { canceled: false, filePath: null, error: null }; }
    const path = await ports.choosePath(image.defaultFileName);
    if (!path) return { canceled: true, filePath: null, error: null };
    await ports.write(path, image.bytes);
    return { canceled: false, filePath: path, error: null };
  } catch (error) {
    return { canceled: false, filePath: null, error: error instanceof Error ? error.message : "输出控件图片失败。" };
  }
}
