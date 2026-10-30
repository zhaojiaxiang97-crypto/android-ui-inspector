import type { LayerCopyAction, LayerImageAction, LayerMenuAction, LayerMenuOptions, UiNode } from "./types";
import { indexTree } from "./visible-tree";

export const layerCopyActions: readonly LayerCopyAction[] = ["copy-text", "copy-resource-id", "copy-class-name", "copy-hierarchy-path"];
export const layerCopyLabels: Record<LayerCopyAction, string> = {
  "copy-text": "文本", "copy-resource-id": "资源 ID", "copy-class-name": "完整类名", "copy-hierarchy-path": "层级路径",
};

export const layerImageActions: readonly LayerImageAction[] = ["preview-image-own", "preview-image-branch", "copy-image-own", "copy-image-branch", "save-image-own", "save-image-branch"];
export const layerLocalLabels = { "restore-selected": "恢复此图层", "locate-hidden-ancestor": "定位隐藏的父层", "expand-branch": "展开此分支", "collapse-children": "收起子层" } as const;

export function isLayerImageAction(value: unknown): value is LayerImageAction {
  return typeof value === "string" && layerImageActions.includes(value as LayerImageAction);
}

export function layerImageActionDetails(action: LayerImageAction): { action: "preview" | "copy" | "save"; scope: "own" | "branch" } {
  return { action: action.startsWith("preview-") ? "preview" : action.startsWith("copy-") ? "copy" : "save", scope: action.endsWith("-own") ? "own" : "branch" };
}

export function isLayerCopyAction(value: unknown): value is LayerCopyAction {
  return typeof value === "string" && layerCopyActions.includes(value as LayerCopyAction);
}

export function isLayerMenuAction(value: unknown): value is LayerMenuAction {
  return value === null || isLayerCopyAction(value) || isLayerImageAction(value)
    || (typeof value === "string" && ["hide", "restore", "focus", "focus-branch", "exit-focus", "expand", "collapse", ...Object.keys(layerLocalLabels)].includes(value));
}

export function isLayerMenuOptions(value: unknown): value is LayerMenuOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some(key => !["canFocus", "expandable", "expanded", "copyActions", "canRestoreSelected", "hasChildren", "hiddenAncestorLabel", "imageScopes"].includes(key))
    || ["canFocus", "expandable", "expanded"].some(key => typeof options[key] !== "boolean")) return false;
  if (options.canRestoreSelected !== undefined && typeof options.canRestoreSelected !== "boolean") return false;
  if (options.hasChildren !== undefined && typeof options.hasChildren !== "boolean") return false;
  if (options.hiddenAncestorLabel !== undefined && (typeof options.hiddenAncestorLabel !== "string" || !options.hiddenAncestorLabel.length || options.hiddenAncestorLabel.length > 160)) return false;
  if (options.imageScopes !== undefined) {
    if (!Array.isArray(options.imageScopes) || options.imageScopes.length > 2 || Object.keys(options.imageScopes).length !== options.imageScopes.length) return false;
    const scopes = new Set<string>();
    for (const entry of options.imageScopes) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.getPrototypeOf(entry) !== Object.prototype
        || Object.keys(entry).some(key => !["scope", "available", "label", "detail"].includes(key))) return false;
      const item = entry as Record<string, unknown>;
      if ((item.scope !== "own" && item.scope !== "branch") || scopes.has(item.scope) || typeof item.available !== "boolean"
        || typeof item.label !== "string" || !item.label.length || item.label.length > 160 || typeof item.detail !== "string" || item.detail.length > 500) return false;
      scopes.add(item.scope);
    }
  }
  return options.copyActions === undefined || (Array.isArray(options.copyActions) && options.copyActions.length <= layerCopyActions.length
    && Object.keys(options.copyActions).length === options.copyActions.length
    && Array.from(options.copyActions).every(isLayerCopyAction) && new Set(options.copyActions).size === options.copyActions.length);
}

export function layerMenuActionEnabled(action: LayerMenuAction, options?: LayerMenuOptions): boolean {
  if (isLayerCopyAction(action)) return Boolean(options?.copyActions?.includes(action));
  if (isLayerImageAction(action)) return Boolean(options?.imageScopes?.some(item => item.scope === layerImageActionDetails(action).scope && item.available));
  if (action === "restore-selected") return options?.canRestoreSelected === true;
  if (action === "locate-hidden-ancestor") return Boolean(options?.hiddenAncestorLabel);
  if (action === "expand-branch" || action === "collapse-children") return options?.expandable === true;
  return true;
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
