import type { UiNode } from "./types";
import { flattenNodes, remapViewNodeIds } from "./tree-utils";

export type TreeCollapsePreference = { version: 1; depth: number | null; classes: readonly string[] };
export const TREE_COLLAPSE_STORAGE_KEY = "android-ui-inspector.initial-collapse";
export const MAX_COLLAPSE_PREFERENCE_LENGTH = 8192;
export const DEFAULT_TREE_COLLAPSE: TreeCollapsePreference = { version: 1, depth: null, classes: [] };

// Exact class names only. No regex, inheritance, resource IDs or guessed container meaning.
export function parseTreeCollapsePreference(value: unknown): TreeCollapsePreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !(candidate.depth === null || Number.isInteger(candidate.depth)
    && Number(candidate.depth) >= 1 && Number(candidate.depth) <= 200)) return null;
  if (!Array.isArray(candidate.classes) || candidate.classes.length > 32) return null;
  const classes: string[] = [];
  for (const name of candidate.classes) {
    if (typeof name !== "string" || name.length > 200
      || !/^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*$/u.test(name)) return null;
    if (!classes.includes(name)) classes.push(name);
  }
  const result: TreeCollapsePreference = { version: 1, depth: candidate.depth as number | null, classes };
  return JSON.stringify(result).length <= MAX_COLLAPSE_PREFERENCE_LENGTH ? result : null;
}

function shouldExpand(node: UiNode, depth: number, preference: TreeCollapsePreference, classes: ReadonlySet<string>) {
  return (preference.depth === null || depth < preference.depth)
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
  const classes = new Set(preference.classes), next = new Set<string>();
  const stack = [{ node: after, depth: 1, ancestorsOpen: true }];
  while (stack.length) {
    const { node, depth, ancestorsOpen } = stack.pop()!;
    const oldId = oldByNewId.get(node.id);
    const knownBranch = oldId !== undefined && Boolean(previous.get(oldId)?.children.length);
    const open = node.children.length > 0 && (knownBranch ? expanded.has(oldId!)
      : ancestorsOpen && shouldExpand(node, depth, preference, classes));
    if (open) next.add(node.id);
    for (let index = node.children.length - 1; index >= 0; index--)
      stack.push({ node: node.children[index], depth: depth + 1, ancestorsOpen: ancestorsOpen && open });
  }
  return next;
}
