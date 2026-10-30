import type { Rect } from "./types";

// One bit per uploaded texel. The existing texture budget also bounds this cache.
export type TextureAlphaMask = { width: number; height: number; bits: Uint8Array };

export function createAlphaMask(width: number, height: number): TextureAlphaMask {
  return { width, height, bits: new Uint8Array(Math.ceil(width * height / 8)) };
}

export function scanAlphaSlice(pixels: Uint8ClampedArray, mask: TextureAlphaMask, startY: number, rows: number): Rect | null {
  const { width, height, bits } = mask;
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3] === 0) continue;
    const at = (startY + y) * width + x;
    bits[at >> 3] |= 1 << (at & 7);
    left = Math.min(left, x); right = Math.max(right, x + 1);
    top = Math.min(top, startY + y); bottom = Math.max(bottom, startY + y + 1);
  }
  return right > left ? { left: left / width, top: top / height, width: (right - left) / width, height: (bottom - top) / height } : null;
}

export function alphaMaskContains(mask: TextureAlphaMask, u: number, v: number): boolean {
  if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || v < 0 || u > 1 || v > 1) return false;
  // Match LINEAR filtering and CLAMP_TO_EDGE, including thin antialiased glyphs.
  const x = u * mask.width - .5, y = v * mask.height - .5, x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  for (const [dx, wx] of [[0, 1 - fx], [1, fx]]) for (const [dy, wy] of [[0, 1 - fy], [1, fy]]) {
    if (wx * wy <= 0) continue;
    const px = Math.max(0, Math.min(mask.width - 1, x0 + dx)), py = Math.max(0, Math.min(mask.height - 1, y0 + dy));
    const at = py * mask.width + px;
    if (mask.bits[at >> 3] & (1 << (at & 7))) return true;
  }
  return false;
}
