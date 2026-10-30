import { nodePresentationStatus } from "./node-presentation-status";
import { validBounds, validSize } from "./screen-coordinates";
import type { UiNode } from "./types";

const NO_IDS: ReadonlySet<string> = new Set();

function hasOwnPixels(node: UiNode) {
  return Boolean(node.layerImageDataUrl?.trim() && node.layerImageSize && validSize(node.layerImageSize)
    && node.bounds && validBounds(node.bounds) && !node.layerImageEmpty && node.layerImageStatus !== "ambiguous");
}

function visibleNodes(root: UiNode, showOffscreen: boolean) {
  const nodes: UiNode[] = [], stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    const alpha = node.attributes?.["effective-alpha"] ?? node.attributes?.alpha, placement = node.layerCapturePlacement;
    if (!node.visibleToUser || placement?.hidden === true && (!showOffscreen || placement.opacity === 0)
      || alpha !== undefined && alpha.trim() !== "" && Number(alpha) === 0) continue;
    nodes.push(node);
    for (const child of node.children) stack.push(child);
  }
  return nodes;
}

function hiddenBranches(root: UiNode, hiddenIds: ReadonlySet<string>) {
  const hidden = new Set<string>();
  if (!hiddenIds.size) return hidden;
  const nodes = [root];
  for (let cursor = 0; cursor < nodes.length; cursor++) nodes.push(...nodes[cursor].children);
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (hiddenIds.has(node.id) || node.children.some(child => hidden.has(child.id))) hidden.add(node.id);
  }
  return hidden;
}

/** Pending capture is not evidence of transparency or a failed/missing image. */
export function hasDeferredLayerImages(root: UiNode, showOffscreen = false): boolean {
  return visibleNodes(root, showOffscreen).some(node => nodePresentationStatus(node).ownImage.code === "deferred");
}

/** Captured pixels available in this tree; this does not assert viewport coverage. */
export function hasAvailableLayerImages(root: UiNode, groupImageIds: ReadonlySet<string> = NO_IDS,
  hiddenIds: ReadonlySet<string> = NO_IDS, showOffscreen = false): boolean {
  const hidden = hiddenBranches(root, hiddenIds);
  return visibleNodes(root, showOffscreen).some(node => !hiddenIds.has(node.id) && hasOwnPixels(node)
    || groupImageIds.has(node.id) && !hidden.has(node.id));
}

/**
 * Hide only pending planes, before depth packing and capping. A folded branch
 * can still show captured descendant pixels, a valid group image, or a real
 * capture diagnostic. Confirmed empty planes retain their separate filter.
 */
export function deferredLayerIds(root: UiNode, expandedIds: ReadonlySet<string>, groupImageIds: ReadonlySet<string> = NO_IDS,
  hiddenIds: ReadonlySet<string> = NO_IDS, showOffscreen = false): Set<string> {
  const nodes = visibleNodes(root, showOffscreen), pendingPlanes = new Set<string>(), hiddenGroups = hiddenBranches(root, hiddenIds);
  const branches = new Map<string, { pixels: boolean; diagnostic: boolean; pending: boolean }>();
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index], state = nodePresentationStatus(node).ownImage.code;
    const children = node.children.flatMap(child => branches.has(child.id) ? [branches.get(child.id)!] : []);
    const hidden = hiddenIds.has(node.id), pending = !hidden && state === "deferred";
    const branch = {
      pixels: !hidden && hasOwnPixels(node) || children.some(child => child.pixels),
      diagnostic: !hidden && !["deferred", "empty", "structural", "device-hidden"].includes(state) || children.some(child => child.diagnostic),
      pending: pending || children.some(child => child.pending),
    };
    branches.set(node.id, branch);
    const folded = node.children.length > 0 && !expandedIds.has(node.id);
    if (folded ? branch.pending && !branch.pixels && !branch.diagnostic && !(groupImageIds.has(node.id) && !hiddenGroups.has(node.id)) : pending)
      pendingPlanes.add(node.id);
  }
  return pendingPlanes;
}
