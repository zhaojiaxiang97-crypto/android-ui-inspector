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

export function inspectorSearchQuery(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function searchInspectorProperties<T extends InspectorSearchProperty>(properties: readonly T[], search: string) {
  const query = inspectorSearchQuery(search);
  if (!query) return { total: 0, results: [] as T[], groups: new Set<InspectorGroupId>() };
  const results: T[] = [], groups = new Set<InspectorGroupId>();
  let total = 0;
  for (const property of properties) {
    if (![property.label, property.value, ...property.terms].some(value => inspectorSearchQuery(value).includes(query))) continue;
    total++;
    groups.add(property.group);
    if (results.length < MAX_INSPECTOR_SEARCH_RESULTS) results.push(property);
  }
  return { total, results, groups };
}

/** Only the preview is shortened. Matching and copying always use the original value. */
export function inspectorSearchPreview(value: string, limit = 100) {
  if (value === "") return "（空字符串）";
  const text = value.replace(/\s+/g, " ");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
