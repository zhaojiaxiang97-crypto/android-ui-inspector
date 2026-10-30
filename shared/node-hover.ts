import { TREE_INDENT, TREE_ROW_HEIGHT, type TreeIndex } from "./visible-tree";

export type NodeHoverSource = "tree" | "canvas";
export type NodeHover = Readonly<{ nodeId: string; source: NodeHoverSource }>;

export function resolveVisibleHoverId(nodeId: string | null, visibleIds: ReadonlySet<string>,
  parents?: ReadonlyMap<string, string | null>, hiddenIds?: ReadonlySet<string>): string | null {
  let candidate = nodeId;
  while (candidate) {
    if (hiddenIds?.has(candidate)) return null;
    if (visibleIds.has(candidate)) return candidate;
    if (parents) { candidate = parents.get(candidate) ?? null; continue; }
    const separator = candidate.lastIndexOf("/");
    candidate = separator < 0 ? null : candidate.slice(0, separator);
  }
  return null;
}

// One store belongs to one committed tree/session. Repeated moves within the
// same node are a no-op, so coordinates never trigger workbench-wide renders.
export function createNodeHoverStore(validIds: Iterable<string>) {
  const ids = new Set(validIds);
  const listeners = new Set<() => void>();
  let hover: NodeHover | null = null;
  let active = true;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const clearHover = (source: NodeHoverSource) => {
    if (hover?.source !== source) return;
    hover = null;
    notify();
  };
  return {
    getSnapshot: () => hover,
    getServerSnapshot: () => null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publishHover: (nodeId: string | null, source: NodeHoverSource) => {
      if (!active) return;
      if (nodeId === null || !ids.has(nodeId)) { clearHover(source); return; }
      if (hover?.nodeId === nodeId && hover.source === source) return;
      hover = Object.freeze({ nodeId, source });
      notify();
    },
    clearHover,
    activate: () => { active = true; },
    deactivate: () => {
      active = false;
      if (hover !== null) { hover = null; notify(); }
    },
  };
}

// Draw only the hovered row's immediate parent connection, clipped to the
// mounted virtual window. Ancestors and siblings retain their neutral guides.
export function treeHoverGuide(index: TreeIndex, positions: ReadonlyMap<string, number>,
  nodeId: string | null, start: number, end: number, rowHeight = TREE_ROW_HEIGHT) {
  if (nodeId === null || start >= end) return null;
  const row = index.get(nodeId);
  const childPosition = positions.get(nodeId);
  const parentPosition = row?.parentId ? positions.get(row.parentId) : undefined;
  const parent = row?.parentId ? index.get(row.parentId) : undefined;
  if (!row || !parent || childPosition === undefined || parentPosition === undefined
    || childPosition < start || childPosition >= end || parentPosition >= childPosition) return null;
  const parentX = 17 + parent.depth * TREE_INDENT;
  const childX = 17 + row.depth * TREE_INDENT;
  const parentY = (parentPosition - start) * rowHeight + rowHeight / 2;
  const childY = (childPosition - start) * rowHeight + rowHeight / 2;
  return {
    parentId: parent.node.id, nodeId, parentX, childX, parentY, childY,
    top: start * rowHeight,
    height: (end - start) * rowHeight,
    path: `M ${parentX} ${Math.max(0, parentY + 8)} V ${childY} H ${Math.max(parentX, childX - 5)}`,
    parentVisible: parentPosition >= start,
  };
}
