export type PreviewRect = { left: number; top: number; width: number; height: number };

// Pick one clear rectangle, so fitting never places a layer behind the inspector.
export function unobscuredViewport(width: number, height: number, obstruction: PreviewRect | null): PreviewRect {
  const full = { left: 0, top: 0, width, height };
  if (!obstruction || obstruction.width <= 0 || obstruction.height <= 0) return full;
  const right = Math.min(width, obstruction.left + obstruction.width), bottom = Math.min(height, obstruction.top + obstruction.height);
  const left = Math.max(0, obstruction.left), top = Math.max(0, obstruction.top);
  if (right <= left || bottom <= top) return full;
  const gap = 8;
  const candidates = [
    { left: 0, top: 0, width: Math.max(0, left - gap), height },
    { left: Math.min(width, right + gap), top: 0, width: Math.max(0, width - right - gap), height },
    { left: 0, top: 0, width, height: Math.max(0, top - gap) },
    { left: 0, top: Math.min(height, bottom + gap), width, height: Math.max(0, height - bottom - gap) },
  ];
  return candidates.reduce((best, rect) => rect.width * rect.height > best.width * best.height ? rect : best);
}
