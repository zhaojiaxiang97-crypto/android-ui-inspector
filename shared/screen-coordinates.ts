import type { CaptureGeometry, DisplayFrame, DisplayRotation, PixelSize, UiBounds, UiNode } from "./types";

export type ScreenRect = Pick<UiBounds, "left" | "top" | "right" | "bottom">;
export type ClientRect = PixelSize & { left: number; top: number };

export function validSize(size: PixelSize) {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}

export function validBounds(bounds: ScreenRect): boolean {
  return [bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite)
    && bounds.right > bounds.left && bounds.bottom > bounds.top;
}

export function clipBounds(bounds: ScreenRect, size: PixelSize): ScreenRect | null {
  if (!validBounds(bounds) || !validSize(size)) return null;
  const clipped = { left: Math.max(0, bounds.left), top: Math.max(0, bounds.top), right: Math.min(size.width, bounds.right), bottom: Math.min(size.height, bounds.bottom) };
  return validBounds(clipped) ? clipped : null;
}

// Client coordinates and getBoundingClientRect are both CSS pixels. Applying DPR
// or Android density here would scale twice. The rect must be the image pixel box.
export function clientToScreen(x: number, y: number, rect: ClientRect, size: PixelSize) {
  if (!validSize(rect) || !validSize(size) || ![x, y, rect.left, rect.top].every(Number.isFinite)) return null;
  if (x < rect.left || y < rect.top || x >= rect.left + rect.width || y >= rect.top + rect.height) return null;
  const dx = x - rect.left, dy = y - rect.top;
  // Remove floating-point cancellation at exact integer pixel boundaries only.
  const snap = (value: number) => Math.abs(value - Math.round(value)) <= Number.EPSILON * Math.max(1, Math.abs(value)) * 8 ? Math.round(value) : value;
  return { x: snap(dx / rect.width * size.width), y: snap(dy / rect.height * size.height) };
}

export function boundsPercent(bounds: ScreenRect, size: PixelSize) {
  const clipped = clipBounds(bounds, size);
  if (!clipped) return null;
  return { left: `${clipped.left / size.width * 100}%`, top: `${clipped.top / size.height * 100}%`, width: `${(clipped.right - clipped.left) / size.width * 100}%`, height: `${(clipped.bottom - clipped.top) / size.height * 100}%` };
}

// Android Rect is left/top inclusive and right/bottom exclusive. Prefer the
// smallest visible rectangle; ties prefer deeper nodes, then later XML siblings.
// XML order is only a heuristic, not proof of Android drawing/z-order.
export function findNodeAtPoint(root: UiNode, x: number, y: number, size: PixelSize): UiNode | null {
  if (!validSize(size) || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= size.width || y >= size.height) return null;
  let match: UiNode | null = null, bestArea = Infinity, bestDepth = -1;
  const stack = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    const b = node.visibleToUser && node.bounds ? clipBounds(node.bounds, size) : null;
    if (b && x >= b.left && x < b.right && y >= b.top && y < b.bottom) {
      const area = (b.right - b.left) * (b.bottom - b.top);
      if (area < bestArea || (area === bestArea && depth >= bestDepth)) {
        match = node; bestArea = area; bestDepth = depth;
      }
    }
    // A missing/invalid parent rectangle must not hide independently valid children.
    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: depth + 1 });
  }
  return match;
}

export function isRotation(value: unknown): value is DisplayRotation {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPixelSize(value: unknown): value is PixelSize {
  return isRecord(value) && typeof value.width === "number" && typeof value.height === "number"
    && Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height) && validSize(value as PixelSize);
}

function isFrame(value: unknown): value is DisplayFrame {
  return isPixelSize(value) && isRotation((value as DisplayFrame).rotation);
}

export function isCaptureGeometry(value: unknown): value is CaptureGeometry {
  return isRecord(value) && (value.hierarchyRotation === null || isRotation(value.hierarchyRotation))
    && (value.beforeScreenshot === null || isFrame(value.beforeScreenshot))
    && (value.afterScreenshot === null || isFrame(value.afterScreenshot)) && isPixelSize(value.screenshotSize);
}

export function assessCaptureGeometry(value: unknown, decodedSize?: PixelSize): { status: "checked" | "unverified" | "mismatch"; message: string } {
  if (value === undefined) return { status: "unverified", message: "此快照没有方向核对信息；若位置不符，请保持页面静止后刷新。" };
  if (!isCaptureGeometry(value)) return { status: "mismatch", message: "快照方向/尺寸信息无效，已暂停截图定位，请刷新。" };
  const { beforeScreenshot: before, afterScreenshot: after, hierarchyRotation, screenshotSize } = value;
  const frames = [before, after].filter((frame): frame is DisplayFrame => frame !== null);
  const rotationChanged = frames.some(frame => hierarchyRotation !== null && frame.rotation !== hierarchyRotation)
    || (before && after && before.rotation !== after.rotation);
  const sizeChanged = frames.some(frame => frame.width !== screenshotSize.width || frame.height !== screenshotSize.height)
    || (decodedSize && (decodedSize.width !== screenshotSize.width || decodedSize.height !== screenshotSize.height));
  if (rotationChanged || sizeChanged) return { status: "mismatch", message: "采集期间方向或尺寸不一致，已暂停截图定位；请保持页面静止后刷新。" };
  if (before && after && hierarchyRotation !== null) return { status: "checked", message: "方向/尺寸已核对" };
  return { status: "unverified", message: "设备未提供完整方向信息；若位置不符，请保持页面静止后刷新。" };
}
