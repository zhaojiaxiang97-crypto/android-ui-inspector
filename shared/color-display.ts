import { colorAlias, colorHasExactHex, colorHex, colorRgba, parseInspectorColor,
  type ColorAliasPreference, type InspectorColorEncoding } from "./inspector-colors";

export type ColorDisplayFormat = "hex" | "rgba" | "raw";
export const COLOR_DISPLAY_STORAGE_KEY = "android-ui-inspector.color-format";
export const DEFAULT_COLOR_FORMAT: ColorDisplayFormat = "hex";
export const COLOR_FORMAT_LABELS = { hex: "Hex", rgba: "RGBA", raw: "原值" } as const;

export function parseColorDisplayFormat(value: unknown): ColorDisplayFormat | null {
  return value === "hex" || value === "rgba" || value === "raw" ? value : null;
}

export function inspectorColorDisplay(raw: string | null | undefined, encoding: InspectorColorEncoding | undefined,
  format: ColorDisplayFormat, aliases: ColorAliasPreference) {
  const color = encoding === "android-argb" || encoding === "qml-rgba" ? parseInspectorColor(raw, encoding) : null;
  const values = { raw: raw ?? "", hex: color ? colorHex(color) : "", rgba: color ? colorRgba(color) : "" };
  const actualFormat = color ? format : "raw";
  const approximate = actualFormat === "hex" && color !== null && !colorHasExactHex(color);
  return { color, values, alias: color ? colorAlias(color, aliases) : null, format: actualFormat,
    value: values[actualFormat], label: COLOR_FORMAT_LABELS[actualFormat], approximate,
    exactHex: color ? colorHasExactHex(color) : false,
    sourceLabel: encoding === "android-argb" ? "Android ARGB" : encoding === "qml-rgba" ? "QML RGBA" : "来源未确认" };
}
