import type { UiNode } from "../../../shared/types";

export const MAX_TREE_SEARCH_SUGGESTIONS = 8;
export const MAX_TREE_SEARCH_CANDIDATES_SCANNED = 4096;
export type TreeSearchSuggestion = {
  key: string; kind: "text" | "resource" | "class"; value: string; label: string; occurrences: number;
};
type Entry = TreeSearchSuggestion & { normalized: string };
export type TreeSearchSuggestionIndex = {
  entries: readonly Entry[];
  exact: ReadonlyMap<string, readonly number[]>;
  prefixes: readonly { value: string; entry: number }[];
  grams: ReadonlyMap<string, readonly number[]>;
};

const normalized = (value: string) => value.trim().toLocaleLowerCase();
function add(map: Map<string, number[]>, key: string, entry: number) {
  const values = map.get(key);
  if (values) values.push(entry); else map.set(key, [entry]);
}

// Build once per snapshot/root. Keystrokes query this value index, never the tree.
export function indexTreeSearchSuggestions(root: UiNode): TreeSearchSuggestionIndex {
  const entries: Entry[] = [], byValue = new Map<string, number>(), stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    for (const [kind, raw] of [["text", node.text], ["resource", node.resourceId], ["class", node.className]] as const) {
      const value = raw?.trim();
      if (!value) continue;
      const key = `${kind}:${value}`, existing = byValue.get(key);
      if (existing !== undefined) { entries[existing].occurrences++; continue; }
      byValue.set(key, entries.length);
      entries.push({ key, kind, value, normalized: normalized(value), occurrences: 1,
        label: kind === "resource" ? value.split("/").pop()! : kind === "class" ? value.split(".").pop()! : value });
    }
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  const exact = new Map<string, number[]>(), grams = new Map<string, number[]>();
  const prefixes: { value: string; entry: number }[] = [];
  entries.forEach((entry, i) => {
    for (const value of new Set([entry.normalized, normalized(entry.label)])) {
      add(exact, value, i); prefixes.push({ value, entry: i });
    }
    // One- and two-character postings keep Chinese and short ID searches useful.
    // Deduplicate per value so a repeated word never duplicates a candidate.
    const seen = new Set<string>();
    for (let p = 0; p < entry.normalized.length; p++) {
      seen.add(entry.normalized.slice(p, p + 1));
      if (p + 1 < entry.normalized.length) seen.add(entry.normalized.slice(p, p + 2));
    }
    for (const gram of seen) add(grams, gram, i);
  });
  prefixes.sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : a.entry - b.entry);
  return { entries, exact, prefixes, grams };
}

export function findTreeSearchSuggestions(index: TreeSearchSuggestionIndex, query: string) {
  const literal = normalized(query), matches: TreeSearchSuggestion[] = [], seen = new Set<number>();
  let scanned = 0, limited = false;
  if (!literal) return { items: matches, limited, scanned };
  const accept = (id: number) => {
    if (seen.has(id)) return;
    seen.add(id); matches.push(index.entries[id]);
  };
  // Exact full values and short class/ID names win even at the end of a huge tree.
  for (const id of index.exact.get(literal) ?? []) {
    accept(id);
    if (matches.length === MAX_TREE_SEARCH_SUGGESTIONS) return { items: matches, limited: true, scanned };
  }
  let low = 0, high = index.prefixes.length;
  while (low < high) { const middle = (low + high) >>> 1; if (index.prefixes[middle].value < literal) low = middle + 1; else high = middle; }
  for (let p = low; p < index.prefixes.length && index.prefixes[p].value.startsWith(literal); p++) {
    accept(index.prefixes[p].entry);
    if (matches.length === MAX_TREE_SEARCH_SUGGESTIONS) return { items: matches, limited: true, scanned };
  }
  let candidates: readonly number[] | undefined;
  const size = Math.min(2, literal.length);
  for (let i = 0; i <= literal.length - size; i++) {
    const posting = index.grams.get(literal.slice(i, i + size));
    if (!posting) return { items: matches, limited, scanned };
    if (!candidates || posting.length < candidates.length) candidates = posting;
  }
  for (const id of candidates ?? []) {
    if (seen.has(id)) continue;
    if (scanned === MAX_TREE_SEARCH_CANDIDATES_SCANNED) { limited = true; break; }
    scanned++;
    if (!index.entries[id].normalized.includes(literal)) continue;
    accept(id);
    if (matches.length === MAX_TREE_SEARCH_SUGGESTIONS) { limited = true; break; }
  }
  return { items: matches, limited, scanned };
}
