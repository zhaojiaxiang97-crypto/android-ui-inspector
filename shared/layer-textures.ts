import type { UiNode } from "./types";

export function layerOrdering(node: UiNode, fallback = Number.POSITIVE_INFINITY) {
  for (const key of ["drawing-order", "drawingOrder", "drawing_order"]) {
    const raw = node.attributes?.[key];
    if (raw?.trim() && Number.isFinite(Number(raw))) return { value: Number(raw), source: "drawing-order" as const };
  }
  return node.index !== null ? { value: node.index, source: "index" as const } : { value: fallback, source: "xml-order" as const };
}

export function compareSiblingNodes(a: UiNode, b: UiNode, aOrder = Number.POSITIVE_INFINITY, bOrder = Number.POSITIVE_INFINITY) {
  const z = (node: UiNode) => {
    const value = Number(node.attributes?.z ?? Number(node.attributes?.elevation ?? 0) + Number(node.attributes?.["translation-z"] ?? 0));
    return Number.isFinite(value) ? value : 0;
  };
  const depth = z(a) - z(b);
  if (depth) return depth;
  const left = layerOrdering(a, aOrder).value, right = layerOrdering(b, bOrder).value;
  return left === right ? 0 : left < right ? -1 : 1;
}

// Only this branch participates; hidden ancestors also hide their descendants.
export function subtreeImageNodes(root: UiNode, hiddenNodeIds?: ReadonlySet<string>): UiNode[] {
  const result: UiNode[] = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (!node.visibleToUser) continue;
    if (!hiddenNodeIds?.has(node.id) && !node.layerImageEmpty && node.layerImageDataUrl && node.layerImageSize && node.bounds) result.push(node);
    const children = [...node.children].sort(compareSiblingNodes);
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
  return result;
}

export function textureDimensions(width: number, height: number, maxPixels = 2_000_000, maxSize = 4096) {
  if (![width, height, maxPixels, maxSize].every((value) => Number.isFinite(value) && value > 0) || maxPixels < 1 || maxSize < 1) throw new Error("图层图片尺寸无效。");
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)), maxSize / width, maxSize / height);
  const result = { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
  // One-pixel thin images still have to fit the total pixel budget.
  if (result.width * result.height > maxPixels) {
    if (result.width >= result.height) result.width = Math.max(1, Math.floor(maxPixels / result.height));
    else result.height = Math.max(1, Math.floor(maxPixels / result.width));
  }
  return result;
}

// Only supplied, independent bitmaps participate; never sample the screen image.
export async function composeSubtreeImage(
  root: UiNode,
  rect: { left: number; top: number; width: number; height: number },
  load: (node: UiNode) => Promise<CanvasImageSource | null>,
  maxPixels = 2_000_000,
  hiddenNodeIds?: ReadonlySet<string>,
) {
  const size = textureDimensions(rect.width, rect.height, maxPixels);
  let livePixels = 0;
  const create = () => {
    if (livePixels + size.width * size.height > 16_000_000) throw new Error("透明分组合成超出内存预算，请缩小检查分支。");
    const canvas = document.createElement("canvas");
    canvas.width = size.width; canvas.height = size.height;
    livePixels += canvas.width * canvas.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法建立图层合成画布。");
    context.setTransform(size.width / rect.width, 0, 0, size.height / rect.height, -rect.left * size.width / rect.width, -rect.top * size.height / rect.height);
    return context;
  };
  const release = (context: CanvasRenderingContext2D) => {
    livePixels -= context.canvas.width * context.canvas.height;
    context.canvas.width = context.canvas.height = 0;
  };
  const alpha = (node: UiNode) => {
    const raw = node === root ? node.attributes?.["effective-alpha"] ?? node.attributes?.alpha : node.attributes?.alpha;
    const value = Number(raw ?? 1);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  };
  const clip = (context: CanvasRenderingContext2D, left: number, top: number, width: number, height: number) => {
    context.beginPath(); context.rect(left, top, Math.max(0, width), Math.max(0, height)); context.clip();
  };
  const content = async (node: UiNode, context: CanvasRenderingContext2D, qmlAlphaDivisor: number) => {
    const b = node.bounds;
    const isQml = node.attributes?.["inspection-source"] === "debug-qml";
    const children = [...node.children].sort(compareSiblingNodes);
    // Qt paints negative-Z children behind the item's own background.
    if (isQml) for (const child of children) {
      if (Number(child.attributes?.z ?? 0) < 0) await paint(child, context, false, qmlAlphaDivisor);
    }
    if (b && !hiddenNodeIds?.has(node.id) && !node.layerImageEmpty && node.layerImageDataUrl && node.layerImageSize) {
      const image = await load(node);
      try { if (image) context.drawImage(image, b.left, b.top, b.right - b.left, b.bottom - b.top); }
      finally { if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) image.close(); }
    }
    context.save();
    try {
      const padding = ["left", "top", "right", "bottom"].map((side) => Number(node.attributes?.[`padding-${side}`] ?? 0));
      if (b && node.attributes?.["clip-to-padding"] === "true" && padding.every(Number.isFinite) && padding.some((value) => value > 0)) {
        clip(context, b.left + padding[0], b.top + padding[1], b.right - b.left - padding[0] - padding[2], b.bottom - b.top - padding[1] - padding[3]);
      }
      for (const child of children) {
        if (isQml && Number(child.attributes?.z ?? 0) < 0) continue;
        await paint(child, context, node.attributes?.["clip-children"] === "true", qmlAlphaDivisor);
      }
    } finally { context.restore(); }
  };
  const paint = async (node: UiNode, context: CanvasRenderingContext2D, clipSelf: boolean, qmlAlphaDivisor = 1) => {
    const isQml = node.attributes?.["inspection-source"] === "debug-qml";
    const effectiveAlpha = Number(node.attributes?.["effective-alpha"] ?? 1);
    const opacity = isQml ? Math.max(0, Math.min(1, effectiveAlpha / qmlAlphaDivisor)) : alpha(node);
    if (!node.visibleToUser || opacity === 0) return;
    context.save();
    try {
      const b = node.bounds;
      if ((clipSelf || node.attributes?.["qml-clip"] === "true") && b) clip(context, b.left, b.top, b.right - b.left, b.bottom - b.top);
      // QML opacity normally applies to each item, unlike an offscreen layer.
      if (isQml && node.attributes?.["qml-layer-enabled"] !== "true") {
        context.globalAlpha = opacity;
        await content(node, context, qmlAlphaDivisor);
      } else if (opacity === 1) await content(node, context, qmlAlphaDivisor);
      else {
        const group = create();
        try {
          await content(node, group, isQml ? effectiveAlpha : qmlAlphaDivisor);
          context.globalAlpha = opacity;
          context.drawImage(group.canvas, rect.left, rect.top, rect.width, rect.height);
        } finally { release(group); }
      }
    } finally { context.restore(); }
  };
  const output = create();
  try {
    await paint(root, output, true);
    return output.canvas;
  } catch (error) { release(output); throw error; }
}
