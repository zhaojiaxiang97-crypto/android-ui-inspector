import type { UiNode } from "./types";
import { flattenNodes, remapViewNodeIds } from "./tree-utils";
import { expandAncestors, indexTree } from "./visible-tree";
import { nodePresentationStatus } from "./node-presentation-status";
import { componentBoundaryIds } from "./tree-components";

export type TreeCollapsePreference = { version: 1; depth: number | null; classes: readonly string[]; components?: boolean };
export const TREE_COLLAPSE_STORAGE_KEY = "android-ui-inspector.initial-collapse";
export const MAX_COLLAPSE_PREFERENCE_LENGTH = 8192;
export const DEFAULT_TREE_COLLAPSE: TreeCollapsePreference = { version: 1, depth: null, classes: [], components: true };

// Exact platform component types, never substring guesses about layout wrappers
// or custom subclasses. Existing saved rules without this option retain behavior.
const COMPONENT_CLASSES = new Set([
  "android.widget.Button", "android.widget.ImageButton", "android.widget.CheckBox", "android.widget.RadioButton",
  "android.widget.Switch", "android.widget.ToggleButton", "android.widget.Spinner", "android.widget.SeekBar",
  "android.widget.RatingBar", "android.widget.ProgressBar", "android.widget.DatePicker", "android.widget.TimePicker",
  "android.widget.NumberPicker", "android.widget.SearchView", "android.webkit.WebView",
]);

export type TreeExpansionPreset = 2 | 4 | "all" | "components";

// A one-off change to the displayed root. Expansion outside a focused branch is
// left intact; the selected path is kept visible without changing preferences.
export function treeExpansionForPreset(root: UiNode, preset: TreeExpansionPreset, expanded: ReadonlySet<string>, selectedId: string | null = null,
  classes: readonly string[] = []): Set<string> {
  const index = indexTree(root);
  const next = new Set(expanded);
  const components = preset === "components" ? initialTreeExpansion(root, { version: 1, depth: null, classes, components: true }) : null;
  for (const [id, row] of index) {
    next.delete(id);
    if (row.node.children.length > 0 && (preset === "all" || components?.has(id) || typeof preset === "number" && row.depth + 1 < preset)) next.add(id);
  }
  return new Set(expandAncestors(index, next, selectedId));
}

// Local display changes use actual descendants, so opaque IDs and neighboring
// positional branches are treated alike. The selected path stays visible.
export function treeExpansionForBranch(root: UiNode, action: "expand-branch" | "collapse-children", expanded: ReadonlySet<string>, selectedId: string | null = null): Set<string> {
  if (!root.children.length) return new Set(expanded);
  const index = indexTree(root), next = new Set(expanded);
  for (const [id, row] of index) {
    next.delete(id);
    if (row.node.children.length && (action === "expand-branch" || id === root.id)) next.add(id);
  }
  return new Set(expandAncestors(index, next, selectedId));
}

// Double-click opens the requested layer, then crosses only confirmed empty
// wrappers. Each branch stops at its first painted or unconfirmed layer.
export function treeExpansionToContent(root: UiNode, expanded: ReadonlySet<string>): Set<string> {
  const next = new Set(expanded);
  if (!root.children.length || next.has(root.id)) return next;
  next.add(root.id);
  const boundaries = componentBoundaryIds(root);
  const stack = [...root.children];
  while (stack.length) {
    const node = stack.pop()!;
    if (!node.children.length || boundaries.has(node.id) || !node.visibleToUser || node.layerCapturePlacement?.opacity === 0) continue;
    const alpha = node.attributes?.["effective-alpha"] ?? node.attributes?.alpha;
    if (alpha !== undefined && alpha.trim() !== "" && Number(alpha) === 0) continue;
    const state = nodePresentationStatus(node).ownImage.code;
    if (state !== "empty" && state !== "structural") continue;
    next.add(node.id);
    for (const child of node.children) stack.push(child);
  }
  return next;
}

// Exact class names only. No regex, inheritance, resource IDs or guessed container meaning.
export function parseTreeCollapsePreference(value: unknown): TreeCollapsePreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !(candidate.depth === null || Number.isInteger(candidate.depth)
    && Number(candidate.depth) >= 1 && Number(candidate.depth) <= 200)) return null;
  if (!Array.isArray(candidate.classes) || candidate.classes.length > 32) return null;
  if (candidate.components !== undefined && typeof candidate.components !== "boolean") return null;
  const classes: string[] = [];
  for (const name of candidate.classes) {
    if (typeof name !== "string" || name.length > 200
      || !/^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*$/u.test(name)) return null;
    if (!classes.includes(name)) classes.push(name);
  }
  const result: TreeCollapsePreference = { version: 1, depth: candidate.depth as number | null, classes,
    ...(typeof candidate.components === "boolean" ? { components: candidate.components } : {}) };
  return JSON.stringify(result).length <= MAX_COLLAPSE_PREFERENCE_LENGTH ? result : null;
}

function shouldExpand(node: UiNode, depth: number, preference: TreeCollapsePreference, classes: ReadonlySet<string>) {
  return (preference.depth === null || depth < preference.depth)
    && !(preference.components && COMPONENT_CLASSES.has(node.className ?? ""))
    && !classes.has(node.className ?? "") && !classes.has(node.className?.split(".").pop() ?? "");
}

export function initialTreeExpansion(root: UiNode, preference: TreeCollapsePreference): Set<string> {
  return reconcileTreeExpansion(null, root, new Set(), preference);
}

// Existing branches keep their actual open/closed state, including manual opens of a
// rule-matched class. Only new branches use the session's initial rules. View identity
// follows sibling moves; new descendants of a closed branch stay closed on reopen.
export function reconcileTreeExpansion(before: UiNode | null, after: UiNode, expanded: ReadonlySet<string>, preference: TreeCollapsePreference): Set<string> {
  const previous = before ? flattenNodes(before) : new Map<string, UiNode>();
  const mapped = before ? remapViewNodeIds(before, after) : new Map<string, string>();
  const oldByNewId = new Map([...mapped].map(([oldId, newId]) => [newId, oldId]));
  const boundaries = preference.components ? componentBoundaryIds(after) : new Set<string>();
  // Lookin reduces its initial expansion on large hierarchies. Android has many
  // non-drawing wrappers, so count confirmed painted surfaces rather than raw
  // tree depth. Explicit depth rules and legacy preferences keep their meaning.
  const overview = preference.components && preference.depth === null && flattenNodes(after).size > 300;
  const classes = new Set(preference.classes), next = new Set<string>();
  const stack = [{ node: after, depth: 1, paintedDepth: 0, ancestorsOpen: true }];
  while (stack.length) {
    const { node, depth, paintedDepth, ancestorsOpen } = stack.pop()!;
    const nextPaintedDepth = paintedDepth + Number(["captured", "style"].includes(nodePresentationStatus(node).ownImage.code));
    const oldId = oldByNewId.get(node.id);
    const knownBranch = oldId !== undefined && Boolean(previous.get(oldId)?.children.length);
    const open = node.children.length > 0 && (knownBranch ? expanded.has(oldId!)
      : ancestorsOpen && !(overview && nextPaintedDepth >= 3) && !boundaries.has(node.id) && shouldExpand(node, depth, preference, classes));
    if (open) next.add(node.id);
    for (let index = node.children.length - 1; index >= 0; index--)
      stack.push({ node: node.children[index], depth: depth + 1, paintedDepth: nextPaintedDepth, ancestorsOpen: ancestorsOpen && open });
  }
  return next;
}
