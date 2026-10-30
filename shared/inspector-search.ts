import type { InspectorGroupId } from "./inspector-groups";

export const MAX_INSPECTOR_SEARCH_RESULTS = 30;
export const INSPECTOR_SEARCH_HIGHLIGHT_MS = 1600;

export type InspectorSearchProperty = {
  id: string;
  group: InspectorGroupId;
  section: string;
  label: string;
  value: string;
  terms: readonly string[];
};

export type InspectorSearchPage = { index: number; count: number; start: number; end: number; size: number };

export function inspectorSearchQuery(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function searchInspectorProperties<T extends InspectorSearchProperty>(properties: readonly T[], search: string, pageIndex = 0) {
  const query = inspectorSearchQuery(search);
  const matches: T[] = [], groups = new Set<InspectorGroupId>();
  if (query) for (const property of properties) {
    if (![property.label, property.value, ...property.terms].some(value => inspectorSearchQuery(value).includes(query))) continue;
    matches.push(property);
    groups.add(property.group);
  }
  const total = matches.length, count = Math.ceil(total / MAX_INSPECTOR_SEARCH_RESULTS);
  const index = Math.max(0, Math.min(count - 1, Number.isSafeInteger(pageIndex) ? pageIndex : 0));
  const offset = index * MAX_INSPECTOR_SEARCH_RESULTS;
  const results = matches.slice(offset, offset + MAX_INSPECTOR_SEARCH_RESULTS);
  const page: InspectorSearchPage = { index, count, start: total ? offset + 1 : 0, end: offset + results.length, size: MAX_INSPECTOR_SEARCH_RESULTS };
  return { total, results, groups, page };
}

/** Only the preview is shortened. Matching and copying always use the original value. */
export function inspectorSearchPreview(value: string, limit = 100) {
  if (value === "") return "（空字符串）";
  const text = value.replace(/\s+/g, " ");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
