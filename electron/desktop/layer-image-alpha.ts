export const MAX_LAYER_IMAGE_BYTES = 10_000_000;
export const MAX_LAYER_IMAGE_PIXELS = 4_000_000;
export const LAYER_ALPHA_BUDGET_MS = 3000;
export type ImageSize = { width: number; height: number };

export function validImageSize(size: ImageSize | null | undefined): size is ImageSize {
  return Boolean(size && Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height)
    && size.width > 0 && size.height > 0 && size.width * size.height <= MAX_LAYER_IMAGE_PIXELS);
}

export function sameImageSize(a: ImageSize, b: ImageSize) {
  return a.width === b.width && a.height === b.height;
}

/** Preflight only. Header alpha flags are not evidence that pixels are transparent. */
export function webpImageSize(data: Buffer): ImageSize | null {
  if (data.length < 20 || data.length > MAX_LAYER_IMAGE_BYTES || data.toString("ascii", 0, 4) !== "RIFF"
    || data.toString("ascii", 8, 12) !== "WEBP" || data.readUInt32LE(4) + 8 !== data.length) return null;
  let offset = 12, chunks = 0, canvas: ImageSize | null = null, frame: ImageSize | null = null, alpha = false;
  while (offset + 8 <= data.length) {
    if (++chunks > 4096) return null;
    const kind = data.toString("ascii", offset, offset + 4), length = data.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length, next = end + (length & 1);
    if (next > data.length || ((length & 1) && data[end] !== 0)) return null;
    if (kind === "VP8X") {
      if (offset !== 12 || canvas || length !== 10 || (data[start] & 0x02)) return null;
      canvas = { width: data.readUIntLE(start + 4, 3) + 1, height: data.readUIntLE(start + 7, 3) + 1 };
      if (!validImageSize(canvas)) return null;
    } else if (kind === "ANIM" || kind === "ANMF") return null; // No first-frame-only guesses.
    else if (kind === "ALPH") {
      if (!canvas || frame || alpha || length < 1) return null;
      alpha = true;
    } else if (kind === "VP8L") {
      if (frame || alpha || length < 5 || data[start] !== 0x2f || (data[start + 4] & 0xe0)) return null;
      frame = { width: 1 + data[start + 1] + ((data[start + 2] & 0x3f) << 8),
        height: 1 + (data[start + 2] >> 6) + (data[start + 3] << 2) + ((data[start + 4] & 0x0f) << 10) };
    } else if (kind === "VP8 ") {
      if (frame || length < 10 || data[start + 3] !== 0x9d || data[start + 4] !== 0x01 || data[start + 5] !== 0x2a) return null;
      frame = { width: data.readUInt16LE(start + 6) & 0x3fff, height: data.readUInt16LE(start + 8) & 0x3fff };
    }
    if (frame && (!validImageSize(frame) || (canvas && !sameImageSize(canvas, frame)))) return null;
    offset = next;
  }
  return offset === data.length && frame ? frame : null;
}

export function rgbaIsEmpty(pixels: Uint8Array | Uint8ClampedArray, size: ImageSize): boolean | undefined {
  if (!validImageSize(size) || pixels.length !== size.width * size.height * 4) return undefined;
  for (let offset = 3; offset < pixels.length; offset += 4) if (pixels[offset] !== 0) return false;
  return true;
}
