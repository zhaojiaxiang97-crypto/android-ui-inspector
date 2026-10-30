export type InspectorColor = { red: number; green: number; blue: number; alpha: number };
export type InspectorColorEncoding = "android-argb" | "qml-rgba";
export type ColorAliasPreference = { version: 1; entries: readonly { color: string; alias: string }[] };

export const COLOR_ALIAS_STORAGE_KEY = "android-ui-inspector.color-aliases";
export const MAX_COLOR_ALIAS_TEXT_LENGTH = 8192;
export const DEFAULT_COLOR_ALIASES: ColorAliasPreference = { version: 1, entries: [] };

function rgbaColor(raw: string): InspectorColor | null {
  const match = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*\)$/i.exec(raw);
  if (!match) return null;
  const [red, green, blue, alpha] = match.slice(1).map(Number);
  return [red, green, blue].every(value => value <= 255) && Number.isFinite(alpha) && alpha >= 0 && alpha <= 1
    ? { red, green, blue, alpha } : null;
}

// Source formats are explicit: Android puts alpha first; QML transports RGBA.
export function parseInspectorColor(raw: unknown, encoding: InspectorColorEncoding): InspectorColor | null {
  if (typeof raw !== "string" || raw.length > 128) return null;
  const value = raw.trim();
  if (encoding === "qml-rgba") return rgbaColor(value);
  if (!/^#[0-9a-f]{8}$/i.test(value)) return null;
  return { alpha: parseInt(value.slice(1, 3), 16) / 255, red: parseInt(value.slice(3, 5), 16),
    green: parseInt(value.slice(5, 7), 16), blue: parseInt(value.slice(7, 9), 16) };
}

// User aliases accept CSS hex (#RRGGBB / #RRGGBBAA) or numeric RGBA only.
export function parseAliasColor(raw: unknown): InspectorColor | null {
  if (typeof raw !== "string" || raw.length > 128) return null;
  const value = raw.trim();
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value)) return rgbaColor(value);
  return { red: parseInt(value.slice(1, 3), 16), green: parseInt(value.slice(3, 5), 16),
    blue: parseInt(value.slice(5, 7), 16), alpha: value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1 };
}

export function colorRgba(color: InspectorColor) {
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${color.alpha})`;
}

export function colorHex(color: InspectorColor) {
  return `#${[color.red, color.green, color.blue, Math.round(color.alpha * 255)].map(value => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export function colorHasExactHex(color: InspectorColor) {
  return color.alpha === Math.round(color.alpha * 255) / 255;
}

export function colorAlias(color: InspectorColor, preference: ColorAliasPreference) {
  return preference.entries.find(entry => entry.color === colorRgba(color))?.alias ?? null;
}

export function parseColorAliasPreference(raw: unknown): ColorAliasPreference | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as { version?: unknown; entries?: unknown };
  if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 32) return null;
  const entries: { color: string; alias: string }[] = [], seen = new Set<string>();
  for (const entry of data.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const color = parseAliasColor(entry.color);
    if (!color || typeof entry.alias !== "string") return null;
    const alias = entry.alias.trim(), key = colorRgba(color);
    if (!alias || alias.length > 64 || /[\u0000-\u001f\u007f]/.test(alias) || seen.has(key)) return null;
    seen.add(key); entries.push({ color: key, alias });
  }
  return { version: 1, entries };
}

export function parseColorAliasText(text: string): { preference: ColorAliasPreference | null; error: string | null } {
  if (text.length > MAX_COLOR_ALIAS_TEXT_LENGTH) return { preference: null, error: "颜色别名内容过长。" };
  const lines = text.split(/\r?\n/), entries: { color: string; alias: string }[] = [], seen = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const equal = line.indexOf("="), color = equal < 0 ? null : parseAliasColor(line.slice(0, equal).trim());
    const alias = equal < 0 ? "" : line.slice(equal + 1).trim();
    if (!color || !alias || alias.length > 64 || /[\u0000-\u001f\u007f]/.test(alias))
      return { preference: null, error: `第 ${index + 1} 行格式无效：颜色 = 别名（别名最多 64 字）。` };
    const key = colorRgba(color);
    if (seen.has(key)) return { preference: null, error: `第 ${index + 1} 行颜色重复；同一颜色只能有一个别名。` };
    seen.add(key); entries.push({ color: key, alias });
    if (entries.length > 32) return { preference: null, error: "最多保存 32 个颜色别名。" };
  }
  return { preference: { version: 1, entries }, error: null };
}

export function colorAliasText(preference: ColorAliasPreference) {
  return preference.entries.map(entry => {
    const color = parseAliasColor(entry.color)!;
    return `${colorHasExactHex(color) ? colorHex(color) : colorRgba(color)} = ${entry.alias}`;
  }).join("\n");
}
