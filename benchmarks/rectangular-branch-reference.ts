import type { UiNode } from "../shared/types";

type Rect = { left: number; top: number; right: number; bottom: number };

// Test-only oracle: calculate ancestral intersections, then paint a flat list.
// No production traversal, sorting, clipping or compositing helpers are used.
export function rectangularBranchReference(root: UiNode) {
  const result: Array<{ node: UiNode; clip: Rect }> = [];
  const bounds = (node: UiNode): Rect => {
    const b = node.bounds;
    if (!b || ![b.left, b.top, b.right, b.bottom].every(Number.isFinite) || b.right < b.left || b.bottom < b.top)
      throw new Error(`Unknown rectangular bounds: ${node.id}`);
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  };
  const intersect = (a: Rect, b: Rect): Rect => {
    const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
    return { left, top, right: Math.max(left, Math.min(a.right, b.right)), bottom: Math.max(top, Math.min(a.bottom, b.bottom)) };
  };
  const visit = (node: UiNode, inherited: Rect) => {
    if (!node.visibleToUser) return;
    const b = bounds(node), a = node.attributes ?? {};
    for (const key of ["clip-children", "clip-to-padding", "clip-to-outline", "qml-clip"])
      if (a[key] !== undefined && a[key] !== "true" && a[key] !== "false") throw new Error(`Unknown ${key}: ${node.id}`);
    if (["alpha", "effective-alpha"].some(k => a[k] !== undefined && Number(a[k]) !== 1)
        || a["clip-to-outline"] === "true" || a["qml-clip"] === "true" || a["inspection-source"] === "debug-qml"
        || Object.keys(a).some(k => /rotation|translation|scale|drawing-order|^z$/.test(k) && Number(a[k]) !== (k.startsWith("scale") ? 1 : 0)))
      throw new Error(`Branch is outside the rectangular reference scope: ${node.id}`);
    if (node.layerImageDataUrl && !node.layerImageEmpty && node.layerImageSize) result.push({ node, clip: inherited });
    let childrenClip = inherited;
    if (a["clip-children"] === "true") childrenClip = intersect(childrenClip, b);
    if (node.children.length && a["clip-to-padding"] === "true") {
      const padding = ["left", "top", "right", "bottom"].map(side => a[`padding-${side}`]);
      if (padding.some(v => v === undefined || v.trim() === "" || !Number.isFinite(Number(v)) || Number(v) < 0))
        throw new Error(`Missing or invalid padding evidence: ${node.id}`);
      const [l, t, r, bot] = padding.map(Number);
      // Android's CLIP_TO_PADDING_MASK also requires non-zero padding.
      if (padding.some(v => Number(v) > 0)) childrenClip = intersect(childrenClip,
        { left: b.left + l, top: b.top + t, right: Math.max(b.left + l, b.right - r), bottom: Math.max(b.top + t, b.bottom - bot) });
    }
    node.children.forEach(child => visit(child, childrenClip));
  };
  visit(root, bounds(root));
  return result;
}
