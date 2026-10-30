import type { LayerCopyAction, LayerMenuAction, LayerMenuOptions, UiNode } from "./types";
import { indexTree } from "./visible-tree";

export const layerCopyActions: readonly LayerCopyAction[] = ["copy-text", "copy-resource-id", "copy-class-name", "copy-hierarchy-path"];
export const layerCopyLabels: Record<LayerCopyAction, string> = {
  "copy-text": "文本", "copy-resource-id": "资源 ID", "copy-class-name": "完整类名", "copy-hierarchy-path": "层级路径",
};

export function isLayerCopyAction(value: unknown): value is LayerCopyAction {
  return typeof value === "string" && layerCopyActions.includes(value as LayerCopyAction);
}

export function isLayerMenuAction(value: unknown): value is LayerMenuAction {
  return value === null || isLayerCopyAction(value)
    || (typeof value === "string" && ["hide", "restore", "focus", "focus-branch", "exit-focus", "expand", "collapse"].includes(value));
}

export function isLayerMenuOptions(value: unknown): value is LayerMenuOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some(key => !["canFocus", "expandable", "expanded", "copyActions"].includes(key))
    || ["canFocus", "expandable", "expanded"].some(key => typeof options[key] !== "boolean")) return false;
  return options.copyActions === undefined || (Array.isArray(options.copyActions) && options.copyActions.length <= layerCopyActions.length
    && Object.keys(options.copyActions).length === options.copyActions.length
    && Array.from(options.copyActions).every(isLayerCopyAction) && new Set(options.copyActions).size === options.copyActions.length);
}

const present = (value: string | null | undefined): value is string => typeof value === "string" && value.length > 0;

export function layerMenuCopyValues(root: UiNode, node: UiNode | null): Partial<Record<LayerCopyAction, string>> {
  if (!node) return {};
  const index = indexTree(root);
  if (index.get(node.id)?.node !== node) return {};
  const values: Partial<Record<LayerCopyAction, string>> = {};
  if (present(node.text)) values["copy-text"] = node.text;
  if (present(node.resourceId)) values["copy-resource-id"] = node.resourceId;
  if (present(node.className)) values["copy-class-name"] = node.className;
  const path: string[] = [];
  let row = index.get(node.id);
  while (row) {
    const item = row.node;
    // Keep the actual names and full types; this describes the current tree, not a locator.
    const name = [item.attributes?.["debug-name"], item.text, item.contentDesc, item.resourceId, item.className].find(present) ?? "控件";
    path.push(present(item.className) && name !== item.className ? `${name} (${item.className})` : name);
    row = row.parentId ? index.get(row.parentId) : undefined;
  }
  values["copy-hierarchy-path"] = path.reverse().join(" > ");
  return values;
}
