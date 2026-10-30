import type { ViewFontResult } from "./view-font";

export type NodeFontProperty = { key: string; label: string; display: string; value: string; terms: string };

/** Describes only the returned TextPaint base Typeface; never infer files or glyph fallback. */
export function nodeFontPresentation(font: ViewFontResult): NodeFontProperty[] | null {
  if (font.source !== "jdwp" || font.basis !== "text-paint" || !font.ref
    || !Number.isSafeInteger(font.capturedAtMillis) || font.capturedAtMillis <= 0 || typeof font.usesDefaultTypeface !== "boolean"
    || font.weight !== null && (!Number.isInteger(font.weight) || font.weight < 1 || font.weight > 1000)
    || font.style !== null && (!Number.isInteger(font.style) || font.style < 0 || font.style > 3)) return null;
  let family: string;
  if (font.familyNameStatus === "system-family") {
    if (typeof font.familyName !== "string" || !font.familyName.trim()) return null;
    family = font.familyName;
  } else if (font.familyNameStatus === "not-exposed" && font.familyName === null) family = "未提供名称";
  else if (font.familyNameStatus === "unsupported" && font.familyName === null) family = "当前系统不支持读取名称";
  else return null;
  const style = font.style === null ? "未提供" : ["普通", "粗体", "斜体", "粗斜体"][font.style];
  return [
    { key: "font-family", label: "字体家族", display: family, value: family, terms: `font family familyName system family 字体名称 系统家族 ${font.familyNameStatus}` },
    { key: "font-weight", label: "字重", display: font.weight === null ? "未提供" : String(font.weight), value: font.weight === null ? "未提供" : String(font.weight), terms: "font weight fontWeight 数值字重" },
    { key: "font-style", label: "字体样式", display: style, value: font.style === null ? "未提供" : String(font.style), terms: "font style typefaceStyle normal bold italic bold_italic" },
    { key: "font-italic", label: "斜体", display: font.style === null ? "未提供" : font.style & 2 ? "是" : "否", value: font.style === null ? "未提供" : String(Boolean(font.style & 2)), terms: "font italic isItalic" },
    { key: "font-default", label: "默认字体", display: font.usesDefaultTypeface ? "是" : "否", value: String(font.usesDefaultTypeface), terms: "usesDefaultTypeface default Typeface 默认 Typeface" },
  ];
}
