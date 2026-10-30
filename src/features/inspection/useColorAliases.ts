import { useState } from "react";
import { COLOR_ALIAS_STORAGE_KEY, DEFAULT_COLOR_ALIASES, MAX_COLOR_ALIAS_TEXT_LENGTH,
  parseColorAliasPreference, type ColorAliasPreference } from "../../../shared/inspector-colors";

export function useColorAliases() {
  const [colorAliases, setColorAliases] = useState<ColorAliasPreference>(() => {
    try {
      const raw = localStorage.getItem(COLOR_ALIAS_STORAGE_KEY);
      return raw && raw.length <= MAX_COLOR_ALIAS_TEXT_LENGTH
        ? parseColorAliasPreference(JSON.parse(raw)) ?? DEFAULT_COLOR_ALIASES : DEFAULT_COLOR_ALIASES;
    } catch { return DEFAULT_COLOR_ALIASES; }
  });
  const saveColorAliases = (value: ColorAliasPreference) => {
    const preference = parseColorAliasPreference(value);
    if (!preference) return false;
    setColorAliases(preference);
    try { localStorage.setItem(COLOR_ALIAS_STORAGE_KEY, JSON.stringify(preference)); return true; }
    catch { return false; }
  };
  return { colorAliases, saveColorAliases };
}
