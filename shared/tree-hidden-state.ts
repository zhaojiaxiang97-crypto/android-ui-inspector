import type { UiNode } from "./types";
import type { TreeIndex } from "./visible-tree";
import { nodeDisplayLabel } from "./tree-utils";

export type ManuallyHiddenLayer = { node: UiNode; hiddenAncestor: UiNode | null; readonly path: string };

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

export function manuallyHiddenLayers(index: TreeIndex, hidden: ReadonlySet<string>): ManuallyHiddenLayer[] {
  const ancestors = new Map<string, UiNode | null>();
  // indexTree keeps parents before children; compute each relationship once.
  for (const row of index.values()) {
    const parent = row.parentId ? index.get(row.parentId)?.node : null;
    ancestors.set(row.node.id, parent ? hidden.has(parent.id) ? parent : ancestors.get(parent.id) ?? null : null);
  }
  const result: ManuallyHiddenLayer[] = [];
  for (const id of hidden) {
    const node = index.get(id)?.node;
    if (!node) continue;
    let path: string | undefined;
    result.push({ node, hiddenAncestor: ancestors.get(id) ?? null,
      // Only the visible page reads paths; do not materialize 25k long strings.
      get path() {
        if (path !== undefined) return path;
        const names: string[] = [];
        let row = index.get(id);
        while (row) {
          const label = nodeDisplayLabel(row.node);
          names.push(row.node.className && row.node.className !== label ? `${label} (${row.node.className})` : label);
          row = row.parentId ? index.get(row.parentId) : undefined;
        }
        path = names.reverse().join(" > ");
        return path;
      },
    });
  }
  return result;
}
