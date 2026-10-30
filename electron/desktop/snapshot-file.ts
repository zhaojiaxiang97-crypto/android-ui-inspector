import { open } from "node:fs/promises";
import sharp, { type Metadata } from "sharp";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { MAX_SNAPSHOT_FILE_BYTES, parseSnapshotFile, type ImportedSnapshotFile } from "../../shared/snapshot-file";
import type { PixelSize, UiNode, UiSnapshot } from "../../shared/types";

const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_TOTAL_IMAGE_PIXELS = 128_000_000;
const SVG_TAGS = new Set(["svg", "defs", "linearGradient", "stop", "path"]);
const SVG_ATTRIBUTES = new Set(["xmlns", "width", "height", "viewBox", "id", "gradientUnits", "x1", "x2", "y1", "y2", "offset", "stop-color", "d", "fill", "fill-rule"]);

// QML styles use this small, self-contained SVG vocabulary. Other SVG content
// must not cause local-file/network access or active content during validation.
function verifyStyleSvg(bytes: Buffer) {
  if (bytes.length > 1024 * 1024) throw new Error("快照中的样式图片过大。");
  const text = bytes.toString("utf8");
  if (/<!|<\?/.test(text) || XMLValidator.validate(text) !== true) throw new Error("快照中的样式图片格式无效。");
  const parsed = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false, processEntities: false }).parse(text);
  if (!parsed.svg || Object.keys(parsed).length !== 1) throw new Error("快照中的样式图片格式无效。");
  let count = 0;
  const walk = (value: unknown, depth: number) => {
    if (depth > 20 || ++count > 10_000) throw new Error("快照中的样式图片过于复杂。");
    if (Array.isArray(value)) { value.forEach(child => walk(child, depth + 1)); return; }
    if (!value || typeof value !== "object") { if (value !== "") throw new Error("快照中的样式图片含不支持的内容。"); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("@_")) {
        const attribute = key.slice(2);
        if (!SVG_ATTRIBUTES.has(attribute) || typeof child !== "string") throw new Error("快照中的样式图片含不支持的属性。");
        if (attribute === "xmlns") {
          if (child !== "http://www.w3.org/2000/svg") throw new Error("快照中的样式图片命名空间无效。");
        } else if (/&|(?:https?:|file:|data:|javascript:)/i.test(child) || /url\s*\(/i.test(child) && !/^url\(#[a-zA-Z][\w-]*\)$/.test(child)) {
          throw new Error("快照图片只能引用文件内的样式。");
        }
      } else {
        if (!SVG_TAGS.has(key)) throw new Error("快照中的样式图片含不支持的元素。");
        walk(child, depth + 1);
      }
    }
  };
  walk(parsed, 0);
}

export async function validateSnapshotImages(snapshot: UiSnapshot) {
  const checked = new Map<string, PixelSize>();
  let totalPixels = 0;
  const verify = async (dataUrl: string, expected?: PixelSize, allowStyle = false) => {
    let size = checked.get(dataUrl);
    const match = /^data:image\/(png|webp|jpeg|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match || match[1] === "svg+xml" && !allowStyle) throw new Error("快照图片必须是内嵌的 PNG、WebP、JPEG 或受支持的 QML 样式。");
    if (!size) {
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.toString("base64") !== match[2]) throw new Error("快照图片编码无效。");
      if (match[1] === "svg+xml") verifyStyleSvg(bytes);
      const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS });
      let metadata: Metadata;
      try { metadata = await image.metadata(); } catch { throw new Error("快照图片损坏或超过像素限制。"); }
      const format = match[1] === "svg+xml" ? "svg" : match[1];
      if (metadata.format !== format || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1)
        throw new Error("快照图片的内容与格式不一致。");
      size = { width: metadata.width, height: metadata.height };
      totalPixels += size.width * size.height;
      if (size.width * size.height > MAX_IMAGE_PIXELS || totalPixels > MAX_TOTAL_IMAGE_PIXELS) throw new Error("快照图片超过像素限制。");
      try { await image.raw().toBuffer(); } catch { throw new Error("快照图片损坏，未载入。"); }
      checked.set(dataUrl, size);
    }
    if (expected && (size.width !== expected.width || size.height !== expected.height)) throw new Error("快照图片尺寸与记录不一致。");
  };
  if (snapshot.screenshotDataUrl) await verify(snapshot.screenshotDataUrl);
  const pending: UiNode[] = snapshot.root ? [snapshot.root] : [];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.layerImageDataUrl) await verify(node.layerImageDataUrl, node.layerImageSize, node.layerImageStatus === "style");
    pending.push(...node.children);
  }
  for (const group of snapshot.layerGroupImages ?? []) await verify(group.image.dataUrl, group.image.size);
}

export async function loadSnapshotFile(path: string): Promise<ImportedSnapshotFile> {
  const file = await open(path, "r");
  let content: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0) throw new Error("请选择非空的快照文件。");
    if (stat.size > MAX_SNAPSHOT_FILE_BYTES) throw new Error("快照文件超过 100 MiB，未载入。");
    // Read at most the observed size + 1, even if another process grows the file.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("快照文件在读取时发生变化，请重新打开。");
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await file.close(); }
  let document: unknown;
  try { document = JSON.parse(content); } catch { throw new Error("快照 JSON 格式无效，未载入。"); }
  const imported = parseSnapshotFile(document);
  await validateSnapshotImages(imported.snapshot);
  return imported;
}
