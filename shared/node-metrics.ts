import type { PixelSize, UiBounds, UiNode } from "./types";

export type NodeRectMetrics = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  area: number;
};

export type ParentOffsetMetrics = {
  x: number;
  y: number;
  right: number;
  bottom: number;
};

export type NodeMetrics = {
  depth: number;
  childCount: number;
  parent: UiNode | null;
  rect: NodeRectMetrics | null;
  parentRect: NodeRectMetrics | null;
  parentOffset: ParentOffsetMetrics | null;
  screenshotSize: PixelSize | null;
};

function validBounds(bounds: UiBounds | null): bounds is UiBounds {
  return Boolean(
    bounds
    && Number.isFinite(bounds.left)
    && Number.isFinite(bounds.top)
    && Number.isFinite(bounds.right)
    && Number.isFinite(bounds.bottom)
    && bounds.right > bounds.left
    && bounds.bottom > bounds.top,
  );
}

export function rectMetrics(bounds: UiBounds | null): NodeRectMetrics | null {
  if (!validBounds(bounds)) return null;
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  return {
    left: bounds.left,
    top: bounds.top,
    right: bounds.right,
    bottom: bounds.bottom,
    width,
    height,
    centerX: bounds.left + width / 2,
    centerY: bounds.top + height / 2,
    area: width * height,
  };
}

type MeasurePoint = { x: number; y: number };
export type BoundsMeasurement = {
  relation: "gap" | "contains" | "inside" | "overlap" | "touching" | "equal";
  guides: Array<{
    from: MeasurePoint;
    to: MeasurePoint;
    distances: Array<{ label: string; value: number }>;
  }>;
};

// Measure original device-space bounds, never projected pixels or exploded Z.
export function measureBounds(anchor: UiBounds | null, target: UiBounds | null): BoundsMeasurement | null {
  const a = rectMetrics(anchor), b = rectMetrics(target);
  if (!a || !b) return null;
  const contains = (outer: NodeRectMetrics, inner: NodeRectMetrics) => outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom;
  if (contains(a, b) && contains(b, a)) {
    return { relation: "equal", guides: [{ from: { x: a.centerX, y: a.centerY }, to: { x: b.centerX, y: b.centerY }, distances: [] }] };
  }
  if (contains(a, b) || contains(b, a)) {
    const anchorOutside = contains(a, b);
    const outer = anchorOutside ? a : b, inner = anchorOutside ? b : a;
    const inset = (label: string, from: MeasurePoint, to: MeasurePoint, value: number) => ({
      from: anchorOutside ? from : to, to: anchorOutside ? to : from, distances: [{ label, value }],
    });
    return { relation: anchorOutside ? "contains" : "inside", guides: [
      inset("左", { x: outer.left, y: inner.centerY }, { x: inner.left, y: inner.centerY }, inner.left - outer.left),
      inset("右", { x: outer.right, y: inner.centerY }, { x: inner.right, y: inner.centerY }, outer.right - inner.right),
      inset("上", { x: inner.centerX, y: outer.top }, { x: inner.centerX, y: inner.top }, inner.top - outer.top),
      inset("下", { x: inner.centerX, y: outer.bottom }, { x: inner.centerX, y: inner.bottom }, outer.bottom - inner.bottom),
    ] };
  }
  const nearest = (aStart: number, aEnd: number, bStart: number, bEnd: number) => {
    if (aEnd <= bStart) return [aEnd, bStart];
    if (bEnd <= aStart) return [aStart, bEnd];
    const middle = (Math.max(aStart, bStart) + Math.min(aEnd, bEnd)) / 2;
    return [middle, middle];
  };
  const [ax, bx] = nearest(a.left, a.right, b.left, b.right);
  const [ay, by] = nearest(a.top, a.bottom, b.top, b.bottom);
  const x = Math.abs(bx - ax), y = Math.abs(by - ay);
  const overlaps = Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
  return {
    relation: x || y ? "gap" : overlaps ? "overlap" : "touching",
    guides: [{ from: { x: ax, y: ay }, to: { x: bx, y: by }, distances: [{ label: "水平", value: x }, { label: "垂直", value: y }] }],
  };
}

function findNodeEntry(root: UiNode, targetId: string) {
  const stack: Array<{ node: UiNode; parent: UiNode | null; depth: number }> = [{ node: root, parent: null, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.node.id === targetId) return current;
    for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: current.node.children[index], parent: current.node, depth: current.depth + 1 });
    }
  }
  return null;
}

export function nodeMetrics(root: UiNode, node: UiNode, screenshotSize: PixelSize | null = null): NodeMetrics {
  const entry = findNodeEntry(root, node.id);
  const rect = rectMetrics(node.bounds);
  const parentRect = entry?.parent ? rectMetrics(entry.parent.bounds) : null;
  const parentOffset = rect && parentRect ? {
    x: rect.left - parentRect.left,
    y: rect.top - parentRect.top,
    right: parentRect.right - rect.right,
    bottom: parentRect.bottom - rect.bottom,
  } : null;

  return {
    depth: entry?.depth ?? 0,
    childCount: node.children.length,
    parent: entry?.parent ?? null,
    rect,
    parentRect,
    parentOffset,
    screenshotSize,
  };
}
