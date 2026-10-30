import { crc32 } from "node:zlib";

export type CapturedViewLayer = {
  name: string;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  imageDataUrl: string | null;
  viewRef?: string;
  geometry?: import("./layer-images").CaptureGeometryEvidence;
};

export function utf16be(value: string) {
  const littleEndian = Buffer.from(value, "utf16le");
  for (let index = 0; index < littleEndian.length; index += 2) {
    const byte = littleEndian[index];
    littleEndian[index] = littleEndian[index + 1];
    littleEndian[index + 1] = byte;
  }
  return littleEndian;
}

function readUtf16be(buffer: Buffer, offset: number, length: number) {
  const value = Buffer.from(buffer.subarray(offset, offset + length * 2));
  for (let index = 0; index < value.length; index += 2) {
    const byte = value[index];
    value[index] = value[index + 1];
    value[index + 1] = byte;
  }
  return value.toString("utf16le");
}

export function parseWindowNames(data: Buffer) {
  if (data.length < 4) return [];
  const count = data.readUInt32BE(0);
  const names: string[] = [];
  let offset = 4;
  for (let index = 0; index < count && offset + 4 <= data.length; index += 1) {
    const length = data.readUInt32BE(offset);
    offset += 4;
    if (offset + length * 2 > data.length) break;
    names.push(readUtf16be(data, offset, length));
    offset += length * 2;
  }
  return names;
}

function pngSize(data: Buffer) {
  if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function webpSize(data: Buffer) {
  if (data.length < 20 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP"
      || data.readUInt32LE(4) + 8 !== data.length) return null;
  let offset = 12, size: { width: number; height: number } | null = null;
  while (offset + 8 <= data.length) {
    const kind = data.toString("ascii", offset, offset + 4), length = data.readUInt32LE(offset + 4), start = offset + 8, end = start + length;
    if (end > data.length) return null;
    if (kind === "VP8X" && length >= 10) size = { width: data.readUIntLE(start + 4, 3) + 1, height: data.readUIntLE(start + 7, 3) + 1 };
    else if (kind === "VP8L" && length >= 5 && data[start] === 0x2f) {
      size = { width: 1 + data[start + 1] + ((data[start + 2] & 0x3f) << 8), height: 1 + (data[start + 2] >> 6) + (data[start + 3] << 2) + ((data[start + 4] & 0x0f) << 10) };
    } else if (kind === "VP8 " && length >= 10 && data[start + 3] === 0x9d && data[start + 4] === 0x01 && data[start + 5] === 0x2a) {
      size = { width: data.readUInt16LE(start + 6) & 0x3fff, height: data.readUInt16LE(start + 8) & 0x3fff };
    }
    offset = end + (length & 1);
  }
  return offset === data.length && size?.width && size.height ? size : null;
}

function imageInfo(data: Buffer) {
  const png = pngSize(data);
  if (png) return { ...png, mime: "image/png" };
  const webp = webpSize(data);
  return webp ? { ...webp, mime: "image/webp" } : null;
}

export function parseCapturedViewLayers(data: Buffer): CapturedViewLayer[] {
  if (data.length < 9) return [];
  const layers: CapturedViewLayer[] = [];
  let offset = 8;
  while (offset < data.length) {
    const tag = data[offset++];
    if (tag === 2) break;
    if (tag !== 1 || offset + 2 > data.length) throw new Error("Debug View 图层数据损坏。");
    const nameLength = data.readUInt16BE(offset);
    offset += 2;
    if (offset + nameLength + 9 > data.length) throw new Error("Debug View 图层数据不完整。");
    const name = data.subarray(offset, offset + nameLength).toString("utf8");
    offset += nameLength;
    const visible = data[offset++] === 1;
    const x = data.readInt32BE(offset);
    const y = data.readInt32BE(offset + 4);
    offset += 8;
    let image: Buffer | null = null;
    // Android omits the length entirely when performViewCapture returns null.
    if (offset < data.length && data[offset] !== 1 && data[offset] !== 2) {
      if (offset + 4 > data.length) throw new Error("Debug View 图层图片长度缺失。");
      const imageLength = data.readUInt32BE(offset);
      offset += 4;
      if (offset + imageLength > data.length) throw new Error("Debug View 图层图片不完整。");
      image = data.subarray(offset, offset + imageLength);
      offset += imageLength;
    }
    const info = image ? imageInfo(image) : null;
    if (info?.mime === "image/webp") {
      if (offset + 4 > data.length || crc32(image!) !== data.readUInt32BE(offset)) throw new Error("Debug View WebP 校验失败。");
      offset += 4;
    }
    layers.push({ name, visible, x, y, width: info?.width ?? 0, height: info?.height ?? 0, imageDataUrl: info ? `data:${info.mime};base64,${image!.toString("base64")}` : null });
  }
  return layers;
}

/** Only publish complete, checksum-verified image records while the SDK is writing the file. */
export function parseCapturedViewLayerPrefix(data: Buffer, nonce?: string): CapturedViewLayer[] {
  if (data.length < 8 || !data.subarray(0, 8).equals(nonce ? Buffer.from(nonce, "hex") : Buffer.alloc(8))) return [];
  let offset = 8;
  while (offset < data.length && data[offset] === 1) {
    if (offset + 3 > data.length) break;
    const nameLength = data.readUInt16BE(offset + 1);
    if (nameLength < 1 || nameLength > 256) throw new Error("SDK 图层身份长度无效");
    const imageLengthAt = offset + 3 + nameLength + 9;
    if (imageLengthAt + 4 > data.length) break;
    if (data[offset + 3 + nameLength] !== 1) throw new Error("SDK 图层可见状态无效");
    const imageLength = data.readUInt32BE(imageLengthAt);
    if (imageLength < 12 || imageLength > 10_000_000) throw new Error("SDK 图层图片长度无效");
    const imageAt = imageLengthAt + 4;
    if (imageAt + imageLength > data.length) break;
    const image = data.subarray(imageAt, imageAt + imageLength);
    const webp = Boolean(webpSize(image));
    if (webp) {
      if (imageAt + imageLength + 4 > data.length) break;
      if (crc32(image) !== data.readUInt32BE(imageAt + imageLength)) throw new Error("SDK 图层 WebP 校验失败");
    } else if (!validCompletePng(image)) throw new Error("SDK 图层图片校验失败");
    offset = imageAt + imageLength + (webp ? 4 : 0);
  }
    if (offset < data.length && data[offset] !== 1 && data[offset] !== 2) throw new Error("SDK 图层记录无效");
  return parseCapturedViewLayers(Buffer.concat([data.subarray(0, offset), Buffer.from([2])]));
}

function validCompletePng(data: Buffer) {
  if (!pngSize(data)) return false;
  let offset = 8, first = true, hasData = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (length > 10_000_000 || offset + length + 12 > data.length) return false;
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (first && (type !== "IHDR" || length !== 13)) return false;
    if (type === "IDAT") hasData = true;
    if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== data.readUInt32BE(offset + 8 + length)) return false;
    offset += length + 12;
    if (type === "IEND") return hasData && length === 0 && offset === data.length;
    first = false;
  }
  return false;
}

export function matchesViewRoot(expected: string, actual: string) {
  // Activity.dump() abbreviates DecorView; DDMS includes its package/enclosing class.
  return expected === actual || (/^DecorView@[0-9a-f]+$/i.test(expected)
    && (actual.endsWith(`.${expected}`) || actual.endsWith(`$${expected}`)));
}
