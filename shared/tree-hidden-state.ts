import type { UiNode } from "./types";
import type { TreeIndex } from "./visible-tree";

export function manuallyHiddenAncestor(index: TreeIndex, node: UiNode, hidden: ReadonlySet<string>): UiNode | null {
  if (index.get(node.id)?.node !== node) return null;
  let parent = index.get(node.id)?.parentId;
  while (parent) {
    const row = index.get(parent);
    if (!row) return null;
    if (hidden.has(parent)) return row.node;
    parent = row.parentId;
  }
  return null;
}
