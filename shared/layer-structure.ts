import type { LayerRecord } from "./layer-layout";
import { nodePresentationStatus } from "./node-presentation-status";
import type { UiNode } from "./types";

export function isQuietStructure(record: LayerRecord) {
  if (record.isCollapsed || record.isDeviceInvisible || record.node.layerCapturePlacement) return false;
  const state = nodePresentationStatus(record.node).ownImage.code;
  return state === "empty" || state === "structural";
}

function geometryMeaning(node: UiNode) {
  return JSON.stringify(Object.entries(node.attributes ?? {}).filter(([key]) =>
    /clip|alpha|opacity|padding|rotation|scale|translation|elevation|matrix|transform|^z$/i.test(key)).sort(([a], [b]) => a.localeCompare(b)));
}

function hasBackground(node: UiNode) {
  return Object.entries(node.attributes ?? {}).some(([key, value]) =>
    /background|foreground|(?:^|-)color$/i.test(key) && value.trim() !== "" && value !== "null" && value !== "none");
}

function sameBounds(a: LayerRecord["renderBounds"], b: LayerRecord["renderBounds"]) {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

// Deduplicate only a continuous, single-child ancestor chain. Keep the frontmost
// outline; every original node remains available for tree selection. Display
// depth is assigned separately by the compact/full layout mode.
export function redundantStructureOutlines(records: readonly LayerRecord[]): ReadonlySet<string> {
  const quiet = new Map(records.filter(record => isQuietStructure(record) && !hasBackground(record.node)).map(record => [record.id, record]));
  const signatures = new Map([...quiet].map(([id, record]) => [id, geometryMeaning(record.node)]));
  const suppressed = new Set<string>();
  for (const child of quiet.values()) {
    const parent = child.parentId ? quiet.get(child.parentId) : undefined;
    if (!parent || parent.node.children.length !== 1 || parent.node.children[0].id !== child.id) continue;
    if (sameBounds(parent.sourceBounds, child.sourceBounds) && sameBounds(parent.renderBounds, child.renderBounds)
      && signatures.get(parent.id) === signatures.get(child.id)) suppressed.add(parent.id);
  }
  return suppressed;
}
