import type { UiNode } from "./types";
import { nodeDisplayLabel, nodeResourceName, nodeShortClass } from "./tree-utils";

export type TreeRowMode = "compact" | "detailed";
export const TREE_ROW_MODE_STORAGE_KEY = "android-ui-inspector.tree-row-mode";
export function parseTreeRowMode(value: unknown): TreeRowMode | null {
  return value === "compact" || value === "detailed" ? value : null;
}

export function treeRowSubtitle(node: UiNode) {
  const label = nodeDisplayLabel(node), resource = node.resourceId?.trim();
  if (resource && resource !== label && nodeResourceName(node) !== label) return { text: resource, resource: true };
  const type = node.className?.trim();
  return type && type !== label && nodeShortClass(node) !== label ? { text: type, resource: false } : null;
}
