export const PREFERENCES_SECTIONS = [
  { id: "interaction", label: "交互" },
  { id: "appearance", label: "外观" },
  { id: "layout", label: "布局" },
  { id: "properties", label: "属性与颜色" },
  { id: "help", label: "帮助" },
] as const;

export type PreferencesSection = typeof PREFERENCES_SECTIONS[number]["id"];
export type PreferencesReadingPosition = { section: PreferencesSection; offset: number };

export function preferencesReadingPosition(scrollTop: number, sections: readonly { id: PreferencesSection; top: number }[], atEnd = false): PreferencesReadingPosition {
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  let section = sections[0];
  for (const candidate of sections) {
    if (candidate.top > top + 1) break;
    section = candidate;
  }
  if (atEnd && sections.length) section = sections[sections.length - 1];
  return { section: section?.id ?? "interaction", offset: section ? top - section.top : 0 };
}
