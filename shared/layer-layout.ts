import type { PixelSize, UiBounds, UiNode } from "./types";
import { clipBounds, type ScreenRect } from "./screen-coordinates";

export type LayerScope = "focus" | "branch" | "all";

export type LayerLayoutOptions = {
  includeParents?: boolean;
  includeChildren?: boolean;
  scope?: LayerScope;
  maxChildDepth?: number;
  maxDepth?: number;
  maxLayers?: number;
  layerGap?: number;
};

export type LayerRecord = {
  id: string;
  parentId: string | null;
  node: UiNode;
  depth: number;
  sourceBounds: UiBounds;
  renderBounds: ScreenRect;
  z: number;
  isSelected: boolean;
  isAncestor: boolean;
  isDescendant: boolean;
  isVirtual: boolean;
  hitTestable: boolean;
};

export type LayerLayoutResult = {
  records: LayerRecord[];
  candidateCount: number;
  truncated: boolean;
  omittedCount: number;
};

type NodeEntry = {
  node: UiNode;
  parentId: string | null;
  depth: number;
  order: number;
};

type EligibleEntry = NodeEntry & {
  isSelected: boolean;
  isAncestor: boolean;
  isDescendant: boolean;
};

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value!)));
}

function clampNumber(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value!));
}

function hasVirtualClass(node: UiNode) {
  return node.className?.includes("$VirtualChild") ?? false;
}

function numericOrdering(node: UiNode, keys: readonly string[]) {
  for (const key of keys) {
    const value = Number(node.attributes?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return Number.POSITIVE_INFINITY;
}

function compareLayerEntries(left: NodeEntry, right: NodeEntry) {
  if (left.depth !== right.depth) return left.order - right.order;
  const drawingOrder = numericOrdering(left.node, ["drawing-order", "drawingOrder", "drawing_order"])
    - numericOrdering(right.node, ["drawing-order", "drawingOrder", "drawing_order"]);
  if (drawingOrder !== 0 && Number.isFinite(drawingOrder)) return drawingOrder;
  const index = (left.node.index ?? Number.POSITIVE_INFINITY) - (right.node.index ?? Number.POSITIVE_INFINITY);
  if (index !== 0 && Number.isFinite(index)) return index;
  return left.order - right.order;
}

function indexTree(root: UiNode) {
  const entries = new Map<string, NodeEntry>();
  const stack: Array<{ node: UiNode; parentId: string | null; depth: number }> = [{ node: root, parentId: null, depth: 0 }];
  let order = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    entries.set(current.node.id, { ...current, order: order++ });
    for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: current.node.children[index], parentId: current.node.id, depth: current.depth + 1 });
    }
  }

  return entries;
}

export function layerPath(root: UiNode, targetId: string | null) {
  const entries = indexTree(root);
  const target = targetId && entries.has(targetId) ? targetId : root.id;
  const path: string[] = [];
  let current: string | null = target;

  while (current) {
    path.push(current);
    current = entries.get(current)?.parentId ?? null;
  }

  path.reverse();
  return { entries, target, path };
}

function descendantsOf(entries: Map<string, NodeEntry>, targetId: string, maxDepth: number) {
  const target = entries.get(targetId);
  if (!target || maxDepth < 1) return [];

  const descendants: NodeEntry[] = [];
  const stack = target.node.children.slice().reverse().map((node) => ({ node, depth: target.depth + 1 }));
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entry = entries.get(current.node.id);
    if (!entry || current.depth - target.depth > maxDepth) continue;
    descendants.push(entry);
    for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: current.node.children[index], depth: current.depth + 1 });
    }
  }
  return descendants;
}

function shouldInclude(entry: NodeEntry, target: string, path: ReadonlySet<string>, selectedDepth: number, options: Required<Pick<LayerLayoutOptions, "includeParents" | "includeChildren" | "scope" | "maxChildDepth" | "maxDepth">>) {
  if (entry.node.id === target) return true;
  const isAncestor = path.has(entry.node.id) && entry.depth < selectedDepth;
  if (isAncestor) return options.includeParents;

  if (options.scope === "all") {
    return options.includeChildren && entry.depth <= options.maxDepth;
  }

  const isDescendant = entry.depth > selectedDepth;
  if (!isDescendant || !options.includeChildren) return false;
  const relativeDepth = entry.depth - selectedDepth;
  if (options.scope === "focus") return relativeDepth <= options.maxChildDepth;
  if (options.scope === "branch") return relativeDepth <= options.maxDepth;
  return false;
}

export function buildLayerLayout(root: UiNode, selectedNode: UiNode | null, size: PixelSize, options: LayerLayoutOptions = {}): LayerLayoutResult {
  if (!root || !size.width || !size.height) return { records: [], candidateCount: 0, truncated: false, omittedCount: 0 };

  const { entries, target, path } = layerPath(root, selectedNode?.id ?? root.id);
  const selectedEntry = entries.get(target);
  if (!selectedEntry) return { records: [], candidateCount: 0, truncated: false, omittedCount: 0 };

  const resolved = {
    includeParents: options.includeParents ?? true,
    includeChildren: options.includeChildren ?? true,
    scope: options.scope ?? "focus",
    maxChildDepth: clampInteger(options.maxChildDepth, 1, 0, 12),
    maxDepth: clampInteger(options.maxDepth, 8, 0, 200),
  } as const;
  const maxLayers = clampInteger(options.maxLayers, 96, 1, 256);
  const layerGap = clampNumber(options.layerGap, 32, 0, 128);
  const pathSet = new Set(path);
  const eligible: EligibleEntry[] = [];

  // Keep the focus path first so a large sibling set cannot evict the selected
  // node or its parents when maxLayers is reached.
  const orderedEntries = path
    .map((id) => entries.get(id))
    .filter((entry): entry is NodeEntry => Boolean(entry));
  const selectedChildren = resolved.scope === "focus"
    ? descendantsOf(entries, target, resolved.maxChildDepth)
    : [];
  const branchEntries = resolved.scope === "branch"
    ? descendantsOf(entries, target, resolved.maxDepth)
    : [];
  const allEntries = resolved.scope === "all"
    ? [...entries.values()].filter((entry) => entry.depth <= resolved.maxDepth).sort(compareLayerEntries)
    : [];
  const candidates = [...orderedEntries, ...(resolved.scope === "focus" ? selectedChildren : resolved.scope === "branch" ? branchEntries : allEntries)];
  const seen = new Set<string>();

  for (const entry of candidates) {
    if (seen.has(entry.node.id) || !shouldInclude(entry, target, pathSet, selectedEntry.depth, resolved)) continue;
    seen.add(entry.node.id);
    const isSelected = entry.node.id === target;
    const isAncestor = pathSet.has(entry.node.id) && entry.depth < selectedEntry.depth;
    const isDescendant = entry.depth > selectedEntry.depth;
    eligible.push({ ...entry, isSelected, isAncestor, isDescendant });
  }

  const selectedIndex = eligible.findIndex((entry) => entry.isSelected);
  if (selectedIndex < 0) return { records: [], candidateCount: 0, truncated: false, omittedCount: 0 };
  const truncated = eligible.length > maxLayers;
  const limited = eligible.length <= maxLayers
    ? eligible
    : [...eligible.slice(0, Math.max(0, maxLayers - 1)), eligible[selectedIndex]].filter((entry, index, list) => list.findIndex((item) => item.node.id === entry.node.id) === index);

  const records = limited
    .map((entry): LayerRecord | null => {
      const clipped = entry.node.bounds ? clipBounds(entry.node.bounds, size) : null;
      if (!clipped || !entry.node.visibleToUser) return null;
      return {
        id: entry.node.id,
        parentId: entry.parentId,
        node: entry.node,
        depth: entry.depth,
        sourceBounds: entry.node.bounds!,
        renderBounds: clipped,
        z: (entry.depth - selectedEntry.depth) * layerGap,
        isSelected: entry.isSelected,
        isAncestor: entry.isAncestor,
        isDescendant: entry.isDescendant,
        isVirtual: hasVirtualClass(entry.node),
        hitTestable: true,
      };
    })
    .filter((record): record is LayerRecord => record !== null);

  return { records, candidateCount: eligible.length, truncated, omittedCount: Math.max(0, eligible.length - limited.length) };
}

export function buildLayerRecords(root: UiNode, selectedNode: UiNode | null, size: PixelSize, options: LayerLayoutOptions = {}): LayerRecord[] {
  return buildLayerLayout(root, selectedNode, size, options).records;
}
