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
    rect,
    parentRect,
    parentOffset,
    screenshotSize,
  };
}
