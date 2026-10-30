export type AppearancePreference = "dark" | "light" | "system";
export type ResolvedAppearance = "dark" | "light";
export const APPEARANCE_STORAGE_KEY = "android-ui-inspector.appearance";
export const DEFAULT_APPEARANCE: AppearancePreference = "dark";

export function parseAppearancePreference(value: unknown): AppearancePreference | null {
  return value === "dark" || value === "light" || value === "system" ? value : null;
}

export function readAppearancePreference(raw: string | null): AppearancePreference {
  return parseAppearancePreference(raw) ?? DEFAULT_APPEARANCE;
}

export function resolveAppearance(preference: AppearancePreference, systemDark: boolean): ResolvedAppearance {
  return preference === "system" ? systemDark ? "dark" : "light" : preference;
}
