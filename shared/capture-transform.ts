export type CapturePoint = { x: number; y: number };
export type LayerCapturePlacement = {
  screen: { left: number; top: number; width: number; height: number };
  source: { left: number; top: number; width: number; height: number };
  opacity: number;
  hidden: boolean;
};
export type RectCaptureEvidence = {
  diagnosticOnly?: boolean;
  rootReached: boolean; bitmapSpace?: "view-local"; localToScreen?: number[]; chain: unknown[][];
  clipContext?: { ref: string; clipBounds: number[] | null; padding: number[]; localToScreen?: number[] }[];
};

export function isLayerCapturePlacement(value: unknown): value is LayerCapturePlacement {
  if (!value || typeof value !== "object") return false;
  const p = value as LayerCapturePlacement;
  const rect = (r: LayerCapturePlacement["screen"]) => r && [r.left, r.top, r.width, r.height].every(n => Number.isFinite(n) && Math.abs(n) <= 2_147_483_647)
    && r.width >= 0 && r.height >= 0;
  return Boolean(rect(p.screen) && rect(p.source) && Number.isFinite(p.opacity) && p.opacity >= 0 && p.opacity <= 1
    && typeof p.hidden === "boolean" && (p.hidden || p.screen.width > 0 && p.screen.height > 0 && p.source.width > 0 && p.source.height > 0));
}

/** Only the verified positive axis-scale/translation path; null means legacy fallback. */
export function rectangularCapturePlacement(e: RectCaptureEvidence, width: number, height: number): LayerCapturePlacement | null {
  if (e.diagnosticOnly) return null;
  if (!e.rootReached || e.bitmapSpace !== "view-local" || !e.clipContext || e.clipContext.length !== e.chain.length || !e.chain.length) return null;
  const axis = (m: unknown): m is number[] => validScreenMatrix(m) && m[0] > 0 && m[4] > 0
    && m[1] === 0 && m[3] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 1;
  if (!axis(e.localToScreen) || !captureScreenQuad(e.localToScreen, width, height)) return null;
  const m = e.localToScreen;
  let left = m[2], top = m[5], right = left + width * m[0], bottom = top + height * m[4], opacity = 1;
  const intersect = (matrix: number[], rect: number[]) => {
    left = Math.max(left, matrix[2] + rect[0] * matrix[0]);
    top = Math.max(top, matrix[5] + rect[1] * matrix[4]);
    right = Math.min(right, matrix[2] + rect[2] * matrix[0]);
    bottom = Math.min(bottom, matrix[5] + rect[3] * matrix[4]);
  };
  for (let i = 0; i < e.chain.length; i++) {
    const row = e.chain[i], clip = e.clipContext[i];
    if (row[13] !== false || clip.ref !== row[0] || !axis(clip.localToScreen)) return null;
    // Custom ancestor dispatchDraw may add arbitrary clip paths absent from public properties.
    if (i > 0 && !/^(?:android\.widget\.(?:FrameLayout|LinearLayout|RelativeLayout|ScrollView|HorizontalScrollView)|com\.android\.internal\.policy\.DecorView)@/.test(String(row[0]))) return null;
    const alpha = row[8];
    if (typeof alpha !== "number" || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
    opacity *= row[9] === 0 ? alpha : 0;
    if (clip.clipBounds) intersect(clip.localToScreen, clip.clipBounds);
    if (i > 0 && row[11] === true || i === e.chain.length - 1) intersect(clip.localToScreen, [0, 0, Number(row[4]), Number(row[5])]);
    if (i > 0 && row[12] === true) {
      const [l, t, r, b] = clip.padding;
      if (clip.padding.length !== 4 || !clip.padding.every(n => Number.isFinite(n) && n >= 0)) return null;
      intersect(clip.localToScreen, [l, t, Number(row[4]) - r, Number(row[5]) - b]);
    }
  }
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  const hidden = right <= left || bottom <= top || opacity === 0;
  return { screen: { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
    source: { left: (left - m[2]) / m[0], top: (top - m[5]) / m[4], width: Math.max(0, right - left) / m[0], height: Math.max(0, bottom - top) / m[4] }, opacity, hidden };
}

// Android Matrix order: scaleX, skewX, translateX, skewY, scaleY,
// translateY, perspectiveX, perspectiveY, perspectiveScale.
export function validScreenMatrix(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 9
    && value.every(v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 2_147_483_647);
}

/** Shared candidate geometry for pixels, border and picking; not an AABB. */
export function captureScreenQuad(matrix: unknown, width: number, height: number): CapturePoint[] | null {
  if (!validScreenMatrix(matrix) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const points = [[0, 0], [width, 0], [width, height], [0, height]];
  const denominators = points.map(([x, y]) => matrix[6] * x + matrix[7] * y + matrix[8]);
  // Crossing the perspective horizon cannot be represented by one finite quad.
  if (denominators.some(d => Math.abs(d) < 1e-8 || Math.sign(d) !== Math.sign(denominators[0]))) return null;
  const quad = points.map(([x, y], i) => ({
    x: (matrix[0] * x + matrix[1] * y + matrix[2]) / denominators[i],
    y: (matrix[3] * x + matrix[4] * y + matrix[5]) / denominators[i],
  }));
  if (quad.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 2_147_483_647 || Math.abs(p.y) > 2_147_483_647)) return null;
  const area = quad.reduce((sum, p, i) => sum + p.x * quad[(i + 1) % 4].y - p.y * quad[(i + 1) % 4].x, 0);
  return Math.abs(area) < 1e-8 ? null : quad;
}
