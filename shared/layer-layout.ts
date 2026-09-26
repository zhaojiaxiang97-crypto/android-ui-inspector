import type { PixelSize, UiBounds, UiNode } from "./types";
import { clipBounds, type ScreenRect } from "./screen-coordinates";
import { compareSiblingNodes, layerOrdering } from "./layer-textures";

const MAX_EXPLODED_DEPTH_SLOTS = 12;

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
  zOrder: number;
  zOrderSource: "z" | "drawing-order" | "index" | "xml-order";
  isSelected: boolean;
  isAncestor: boolean;
  isDescendant: boolean;
  isCollapsed: boolean;
  isCompact?: boolean;
  isVirtual: boolean;
  hitTestable: boolean;
};

export type LayerLayoutResult = {
  records: LayerRecord[];
  candidateCount: number;
  truncated: boolean;
  omittedCount: number;
};

export type LayerOverviewResult = LayerLayoutResult & {
  parent: LayerRecord | null;
  parentId: string | null;
};

export type LayerOverviewOptions = Pick<LayerLayoutOptions, "layerGap" | "maxLayers"> & {
  expandedIds?: ReadonlySet<string>;
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

function compareLayerEntries(left: NodeEntry, right: NodeEntry) {
  if (left.depth !== right.depth) return left.order - right.order;
  return compareSiblingNodes(left.node, right.node, left.order, right.order) || left.order - right.order;
}

function zOrderFor(entry: NodeEntry) {
  if (entry.node.attributes?.z?.trim() && Number.isFinite(Number(entry.node.attributes.z))) return { value: Number(entry.node.attributes.z), source: "z" as const };
  return layerOrdering(entry.node, entry.order);
}

function compareSiblingEntries(left: NodeEntry, right: NodeEntry) {
  return compareSiblingNodes(left.node, right.node) || left.order - right.order;
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
        z: 0,
        zOrder: entry.order,
        zOrderSource: "xml-order",
        isSelected: entry.isSelected,
        isAncestor: entry.isAncestor,
        isDescendant: entry.isDescendant,
        isCollapsed: false,
        isVirtual: hasVirtualClass(entry.node),
        hitTestable: true,
      };
    })
    .filter((record): record is LayerRecord => record !== null);

  const selectedVisibleIndex = records.findIndex((record) => record.isSelected);
  const farthestVisibleSlot = Math.max(selectedVisibleIndex, records.length - selectedVisibleIndex - 1);
  const explodedStep = farthestVisibleSlot > MAX_EXPLODED_DEPTH_SLOTS
    ? layerGap * MAX_EXPLODED_DEPTH_SLOTS / farthestVisibleSlot
    : layerGap;
  const positionedRecords = selectedVisibleIndex < 0
    ? records
    // Give siblings their own depth slot as well as parents and children. A
    // depth-only z value leaves same-level Android nodes coplanar and hard to
    // select in an exploded hierarchy. Compress large branches so their far
    // planes do not disappear past the camera.
    : records.map((record, index) => ({ ...record, z: (index - selectedVisibleIndex) * explodedStep }));

  return { records: positionedRecords, candidateCount: eligible.length, truncated, omittedCount: Math.max(0, eligible.length - limited.length) };
}

export function buildLayerRecords(root: UiNode, selectedNode: UiNode | null, size: PixelSize, options: LayerLayoutOptions = {}): LayerRecord[] {
  return buildLayerLayout(root, selectedNode, size, options).records;
}

/**
 * Expand every visible descendant into one stable 3D overview.
 * Selection changes only the highlight; it never changes the Z stack.
 */
export function buildLayerOverview(root: UiNode, selectedNode: UiNode | null, size: PixelSize, options: LayerOverviewOptions = {}): LayerOverviewResult {
  if (!root || !root.visibleToUser || !size.width || !size.height) return { parent: null, parentId: null, records: [], candidateCount: 0, truncated: false, omittedCount: 0 };

  const { entries, target, path } = layerPath(root, selectedNode?.id ?? root.id);
  const rootEntry = entries.get(root.id);
  const selectedEntry = entries.get(target);
  if (!rootEntry || !selectedEntry) return { parent: null, parentId: null, records: [], candidateCount: 0, truncated: false, omittedCount: 0 };

  const selectedPath = new Set(path);
  const selectedDescendants = new Set(descendantsOf(entries, target, Number.MAX_SAFE_INTEGER).map((entry) => entry.node.id));
  const candidates: NodeEntry[] = [];
  const stack: Array<{ entry: NodeEntry; emitOnly?: boolean }> = options.expandedIds && !options.expandedIds.has(rootEntry.node.id)
    ? []
    : rootEntry.node.children
    .map((child) => entries.get(child.id))
    .filter((entry): entry is NodeEntry => Boolean(entry))
    .sort(compareSiblingEntries)
    .reverse().map((entry) => ({ entry }));

  while (stack.length > 0) {
    const { entry, emitOnly } = stack.pop()!;
    if (!entry.node.visibleToUser) continue;
    const clipped = entry.node.bounds ? clipBounds(entry.node.bounds, size) : null;
    const children = emitOnly || (options.expandedIds && !options.expandedIds.has(entry.node.id)) ? [] : entry.node.children
      .map((child) => entries.get(child.id))
      .filter((child): child is NodeEntry => Boolean(child))
      .sort(compareSiblingEntries);
    if (!emitOnly && entry.node.attributes?.["inspection-source"] === "debug-qml") {
      const behind = children.filter((child) => Number(child.node.attributes?.z ?? 0) < 0);
      const above = children.filter((child) => Number(child.node.attributes?.z ?? 0) >= 0);
      for (let index = above.length - 1; index >= 0; index--) stack.push({ entry: above[index] });
      stack.push({ entry, emitOnly: true });
      for (let index = behind.length - 1; index >= 0; index--) stack.push({ entry: behind[index] });
    } else {
      if (clipped) candidates.push(entry);
      for (let index = children.length - 1; index >= 0; index--) stack.push({ entry: children[index] });
    }
  }

  const maxLayers = clampInteger(options.maxLayers, 512, 1, 1024);
  const limited = candidates.slice(0, maxLayers);
  if (candidates.includes(selectedEntry) && !limited.includes(selectedEntry)) {
    limited[limited.length - 1] = selectedEntry;
    const order = new Map(candidates.map((entry, index) => [entry, index]));
    limited.sort((a, b) => order.get(a)! - order.get(b)!);
  }
  const layerGap = clampNumber(options.layerGap, 64, 16, 240);
  const records: LayerRecord[] = [];
  const emptyBounds = new Set<string>();
  let frontDepth = 0;
  for (const entry of limited) {
    const renderBounds = clipBounds(entry.node.bounds!, size)!;
    const zOrder = zOrderFor(entry);
    const isCollapsed = Boolean(entry.node.children.length && options.expandedIds && !options.expandedIds.has(entry.node.id));
    // Only confirmed empty/skip-draw nodes are compacted. Missing or failed
    // captures, real backgrounds and collapsed composites keep full spacing.
    const isEmpty = !isCollapsed && (entry.node.layerImageEmpty === true || (!entry.node.layerImageDataUrl && entry.node.attributes?.["skip-draw"] === "true"));
    const boundsKey = `${renderBounds.left},${renderBounds.top},${renderBounds.right},${renderBounds.bottom}`;
    const isCompact = isEmpty && emptyBounds.has(boundsKey);
    if (isEmpty) emptyBounds.add(boundsKey);
    // Keep repeated empty wrappers quieter, but leave enough separation to pick
    // their edges without turning the whole stack into a solid wire bundle.
    const step = layerGap * (isCompact ? 0.28 : 1);
    let depth = step;
    // Only overlapping regions need another plane. Disjoint controls share
    // depth without losing their individual images, outlines or hit targets.
    // ponytail: bounded O(n²) packing (at most 1024 records); use a spatial index only if this rendering cap grows.
    for (const previous of records) {
      const b = previous.renderBounds;
      if (renderBounds.left < b.right && renderBounds.right > b.left && renderBounds.top < b.bottom && renderBounds.bottom > b.top) {
        depth = Math.max(depth, previous.z + step);
      }
    }
    frontDepth = Math.max(frontDepth, depth);
    records.push({
      id: entry.node.id,
      parentId: entry.parentId,
      node: entry.node,
      depth: entry.depth,
      sourceBounds: entry.node.bounds!,
      renderBounds,
      z: depth,
      zOrder: zOrder.value,
      zOrderSource: zOrder.source,
      isSelected: entry.node.id === target,
      isAncestor: entry.node.id !== target && selectedPath.has(entry.node.id),
      isDescendant: selectedDescendants.has(entry.node.id),
      isCollapsed,
      isCompact,
      isVirtual: hasVirtualClass(entry.node),
      hitTestable: true,
    });
  }
  // Keep the requested content spacing even in deep trees. The camera fits
  // the full stack; more nodes must not silently squeeze every existing gap.
  for (const record of records) record.z -= frontDepth;
  const rootBounds = rootEntry.node.bounds ? clipBounds(rootEntry.node.bounds, size) : null;
  const parent = rootBounds && rootEntry.node.visibleToUser
    ? {
        id: rootEntry.node.id,
        parentId: null,
        node: rootEntry.node,
        depth: 0,
        sourceBounds: rootEntry.node.bounds!,
        renderBounds: rootBounds,
        z: -frontDepth,
        zOrder: 0,
        zOrderSource: "xml-order" as const,
        isSelected: rootEntry.node.id === target,
        isAncestor: false,
        isDescendant: false,
        isCollapsed: Boolean(rootEntry.node.children.length && options.expandedIds && !options.expandedIds.has(rootEntry.node.id)),
        isVirtual: hasVirtualClass(rootEntry.node),
        hitTestable: Boolean(rootEntry.node.children.length && options.expandedIds && !options.expandedIds.has(rootEntry.node.id)),
      }
    : null;

  return {
    parent,
    parentId: rootEntry.node.id,
    records,
    candidateCount: candidates.length,
    truncated: candidates.length > limited.length,
    omittedCount: Math.max(0, candidates.length - limited.length),
  };
}
