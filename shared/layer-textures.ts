import type { UiNode } from "./types";

// Only this branch participates; hidden ancestors also hide their descendants.
export function subtreeImageNodes(root: UiNode): UiNode[] {
  const result: UiNode[] = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (!node.visibleToUser) continue;
    if (node.layerImageDataUrl && node.layerImageSize && node.bounds) result.push(node);
    const children = node.children.map((child, index) => ({ child, index })).sort((a, b) => {
      const order = (item: typeof a) => Number(item.child.attributes?.["drawing-order"] ?? item.child.index ?? item.index);
      return order(a) - order(b);
    });
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index].child);
  }
  return result;
}
