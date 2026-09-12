import type { UiNode } from "./types";

export const TREE_ROW_HEIGHT = 32;
export const TREE_OVERSCAN = 8;
export const TREE_VIRTUAL_THRESHOLD = 500;

export type TreeRow = {
  node: UiNode;
  parentId: string | null;
  depth: number;
  position: number;
  setSize: number;
};
export type TreeIndex = ReadonlyMap<string, TreeRow>;

// Iterative preorder. Collapsed branches cost no work beyond their parent row.
export function visibleTreeRows(root: UiNode | null, expanded: ReadonlySet<string>, forceExpand = false): TreeRow[] {
  if (!root) return [];
  const rows: TreeRow[] = [];
  const stack: TreeRow[] = [{ node: root, parentId: null, depth: 0, position: 1, setSize: 1 }];
  while (stack.length > 0) {
    const row = stack.pop()!;
    rows.push(row);
    if (!forceExpand && !expanded.has(row.node.id)) continue;
    const children = row.node.children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], parentId: row.node.id, depth: row.depth + 1, position: index + 1, setSize: children.length });
    }
  }
  return rows;
}

export function indexTree(root: UiNode): TreeIndex {
  return new Map(visibleTreeRows(root, new Set(), true).map((row) => [row.node.id, row]));
}

export function expandAncestors(index: TreeIndex, expanded: ReadonlySet<string>, id: string | null): ReadonlySet<string> {
  let parentId = id ? index.get(id)?.parentId : null;
  let result: Set<string> | null = null;
  while (parentId) {
    if (!expanded.has(parentId)) {
      result ??= new Set(expanded);
      result.add(parentId);
    }
    parentId = index.get(parentId)?.parentId;
  }
  return result ?? expanded;
}

export function nearestVisibleId(id: string | null, index: TreeIndex, visible: ReadonlyMap<string, number>): string | null {
  let candidate = id;
  while (candidate) {
    if (visible.has(candidate)) return candidate;
    candidate = index.get(candidate)?.parentId ?? null;
  }
  return null;
}

export function treeWindow(count: number, scrollTop: number, viewportHeight: number, rowHeight = TREE_ROW_HEIGHT, overscan = TREE_OVERSCAN) {
  if (rowHeight <= 0 || !Number.isFinite(rowHeight)) throw new Error("Row height must be positive and finite");
  const height = Math.max(0, viewportHeight);
  const totalHeight = count * rowHeight;
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - height)));
  const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((top + height) / rowHeight) + overscan);
  return { start, end, top, totalHeight, offset: start * rowHeight };
}

export function scrollToTreeRow(index: number, count: number, scrollTop: number, viewportHeight: number) {
  const current = treeWindow(count, scrollTop, viewportHeight).top;
  if (index < 0 || index >= count) return current;
  const rowTop = index * TREE_ROW_HEIGHT;
  const rowBottom = rowTop + TREE_ROW_HEIGHT;
  const next = rowTop < current ? rowTop : rowBottom > current + viewportHeight ? rowBottom - viewportHeight : current;
  return treeWindow(count, next, viewportHeight).top;
}
