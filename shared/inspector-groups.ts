export type InspectorGroupId = "type" | "business" | "relation" | "layout" | "interaction" | "image" | "raw";
export type InspectorGroupPreference = { version: 1; hidden: readonly InspectorGroupId[] };

export const INSPECTOR_GROUPS: readonly { id: InspectorGroupId; label: string }[] = [
  { id: "type", label: "类型" },
  { id: "business", label: "业务信息" },
  { id: "relation", label: "关系" },
  { id: "layout", label: "布局" },
  { id: "interaction", label: "交互" },
  { id: "image", label: "画面" },
  { id: "raw", label: "原始属性" },
];
export const DEFAULT_INSPECTOR_GROUPS: InspectorGroupPreference = { version: 1, hidden: [] };
export const INSPECTOR_GROUP_STORAGE_KEY = "android-ui-inspector.inspector-groups";
export const MAX_INSPECTOR_GROUP_PREFERENCE_LENGTH = 2048;

export function parseInspectorGroupPreference(value: unknown): InspectorGroupPreference | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as { version?: unknown; hidden?: unknown };
    if (data.version !== 1 || !Array.isArray(data.hidden) || data.hidden.length > MAX_INSPECTOR_GROUP_PREFERENCE_LENGTH) return null;
    const hidden: InspectorGroupId[] = [];
    for (const id of data.hidden) {
      if (typeof id !== "string" || !INSPECTOR_GROUPS.some(group => group.id === id)) return null;
      if (!hidden.includes(id as InspectorGroupId)) hidden.push(id as InspectorGroupId);
    }
    if (JSON.stringify(value).length > MAX_INSPECTOR_GROUP_PREFERENCE_LENGTH) return null;
    return { version: 1, hidden };
  } catch { return null; }
}

export function readInspectorGroupPreference(raw: string | null): InspectorGroupPreference {
  if (!raw || raw.length > MAX_INSPECTOR_GROUP_PREFERENCE_LENGTH) return DEFAULT_INSPECTOR_GROUPS;
  try { return parseInspectorGroupPreference(JSON.parse(raw)) ?? DEFAULT_INSPECTOR_GROUPS; }
  catch { return DEFAULT_INSPECTOR_GROUPS; }
}

export function inspectorGroupVisible(preference: InspectorGroupPreference, id: InspectorGroupId, hasSearch: boolean, matched: boolean): boolean {
  return hasSearch ? matched : !preference.hidden.includes(id);
}
