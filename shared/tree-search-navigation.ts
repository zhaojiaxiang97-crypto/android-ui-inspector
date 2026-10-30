import type { UiNode } from "./types";
import { createTreeMatcher, flattenNodes, type TreeFilter } from "./tree-utils";

export type TreeSearchNavigation = {
  active: boolean;
  count: number;
  position: number | null;
  disabledReason: string | null;
  previous: () => boolean;
  next: () => boolean;
};

export function treeSearchMatches(root: UiNode, filter: TreeFilter): UiNode[] {
  const matches = createTreeMatcher(filter);
  return [...flattenNodes(root).values()].filter(matches);
}

export function stepTreeSearchMatch(matches: readonly UiNode[], selected: UiNode | null, direction: -1 | 1): UiNode | null {
  if (!matches.length) return null;
  const current = selected ? matches.indexOf(selected) : -1;
  return matches[current < 0 ? 0 : (current + direction + matches.length) % matches.length];
}

export function treeSearchShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): -1 | 1 | null {
  return !event.altKey && event.metaKey !== event.ctrlKey && event.key.toLowerCase() === "g" ? (event.shiftKey ? -1 : 1) : null;
}
