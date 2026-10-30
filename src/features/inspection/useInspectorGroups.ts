import { useCallback, useState } from "react";
import { DEFAULT_INSPECTOR_GROUPS, INSPECTOR_GROUP_STORAGE_KEY, parseInspectorGroupPreference,
  readInspectorGroupPreference, type InspectorGroupPreference } from "../../../shared/inspector-groups";

export function useInspectorGroups() {
  const [inspectorGroups, setInspectorGroups] = useState<InspectorGroupPreference>(() => {
    try { return readInspectorGroupPreference(localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY)); }
    catch { return DEFAULT_INSPECTOR_GROUPS; }
  });
  const saveInspectorGroups = useCallback((value: InspectorGroupPreference) => {
    const preference = parseInspectorGroupPreference(value);
    if (!preference) return false;
    setInspectorGroups(preference);
    try { localStorage.setItem(INSPECTOR_GROUP_STORAGE_KEY, JSON.stringify(preference)); return true; }
    catch { return false; }
  }, []);
  return { inspectorGroups, saveInspectorGroups };
}
