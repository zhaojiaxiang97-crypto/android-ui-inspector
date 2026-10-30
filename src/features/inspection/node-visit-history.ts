import type { TreeReadingAnchor } from "../../../shared/visible-tree";
import type { UiNode } from "../../../shared/types";

export const MAX_NODE_VISITS = 50;
export type NodeReadingPosition = { top: number; left: number; scope?: string | null; filtered?: boolean; search?: string; treeAnchor?: TreeReadingAnchor };
export type NodeReadingPositions = Partial<Record<"tree" | "inspector", NodeReadingPosition>>;
export type NodeVisit = { key: number; node: UiNode; positions: NodeReadingPositions };
export type NodeVisitHistory = { root: UiNode | null; session: number; visits: readonly NodeVisit[]; cursor: number; nextKey: number };
export type NodeHistoryViewRequest = { root: UiNode; node: UiNode; revision: number; positions: NodeReadingPositions; restoring: boolean };
export type NodeHistoryView = {
  request: NodeHistoryViewRequest | null;
  register: (surface: keyof NodeReadingPositions, reader: () => { node: UiNode; position: NodeReadingPosition } | null) => () => void;
};
export type NodeHistoryControlsState = {
  canBack: boolean; canForward: boolean; backLabel: string | null; forwardLabel: string | null;
  disabledReason: string | null; back: () => boolean; forward: () => boolean;
};

export function createNodeVisitHistory(root: UiNode | null, session: number, node: UiNode | null): NodeVisitHistory {
  return { root, session, visits: node && root ? [{ key: 0, node, positions: {} }] : [], cursor: node && root ? 0 : -1, nextKey: 1 };
}

export function visitNode(history: NodeVisitHistory, node: UiNode): NodeVisitHistory {
  if (history.visits[history.cursor]?.node === node) return history;
  const visits = [...history.visits.slice(0, history.cursor + 1), { key: history.nextKey, node, positions: {} }].slice(-MAX_NODE_VISITS);
  return { ...history, visits, cursor: visits.length - 1, nextKey: history.nextKey + 1 };
}

export function rememberNodeReading(history: NodeVisitHistory, positions: NodeReadingPositions): NodeVisitHistory {
  const current = history.visits[history.cursor];
  if (!current) return history;
  const valid: NodeReadingPositions = {};
  for (const surface of ["tree", "inspector"] as const) {
    const value = positions[surface];
    if (value && Number.isFinite(value.top) && Number.isFinite(value.left)) valid[surface] = { ...value, top: Math.max(0, value.top), left: Math.max(0, value.left) };
  }
  return { ...history, visits: history.visits.map((entry, i) => i === history.cursor ? { ...entry, positions: { ...entry.positions, ...valid } } : entry) };
}

export function stepNodeVisit(history: NodeVisitHistory, direction: -1 | 1): NodeVisitHistory {
  const cursor = history.cursor + direction;
  return cursor < 0 || cursor >= history.visits.length ? history : { ...history, cursor };
}

function identities(root: UiNode) {
  const objects = new Set<UiNode>(), refs = new Map<string, UiNode | null>(), pending = [root];
  while (pending.length) {
    const node = pending.pop()!; objects.add(node);
    const ref = node.attributes?.["view-ref"];
    if (ref) refs.set(ref, refs.has(ref) ? null : node);
    for (const child of node.children) pending.push(child);
  }
  return { objects, refs };
}

// Positional IDs and duplicate refs cannot establish continuity across a refresh.
export function reconcileNodeVisits(history: NodeVisitHistory, root: UiNode | null, session: number, selected: UiNode | null): NodeVisitHistory {
  if (history.session !== session || !root || !history.root) return createNodeVisitHistory(root, session, selected);
  if (history.root === root) return selected ? visitNode(history, selected) : history;
  const before = identities(history.root), after = identities(root);
  const visits: NodeVisit[] = []; let cursor = -1;
  history.visits.forEach((entry, i) => {
    const ref = entry.node.attributes?.["view-ref"];
    const target = ref ? before.refs.get(ref) === entry.node && after.refs.get(ref) : after.objects.has(entry.node) ? entry.node : null;
    if (target && (!ref || entry.node.className && target.className === entry.node.className)) {
      visits.push({ ...entry, node: target });
      if (i <= history.cursor) cursor = visits.length - 1;
    }
  });
  const next = { ...history, root, visits, cursor };
  if (!selected || !after.objects.has(selected) || visits[cursor]?.node === selected) return next;
  // A refresh may fall back to another selected node when the current one disappears.
  // This is a new baseline, not an explicit visit that discards reliable forward entries.
  const insertion = cursor + 1;
  visits.splice(insertion, 0, { key: history.nextKey, node: selected, positions: {} });
  const overflow = Math.max(0, visits.length - MAX_NODE_VISITS);
  return { ...next, visits: visits.slice(overflow), cursor: insertion - overflow, nextKey: history.nextKey + 1 };
}
