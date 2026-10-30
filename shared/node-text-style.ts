import type { UiNode } from "./types";

export type NodeTextStyleProperty = {
  key: string;
  label: string;
  raw: string;
  display: string;
  terms: string;
  kind: "value" | "color";
};
export type NodeTextStyle = {
  source: "view-debug";
  sourceLabel: "View Debug 快照属性";
  properties: NodeTextStyleProperty[];
};

const typefaceStyles = ["普通", "粗体", "斜体", "粗斜体"];
const textAlignments = ["继承", "按框内对齐", "文字起始侧", "文字结束侧", "居中", "控件起始侧", "控件结束侧"];
const textDirections = ["继承", "首个强方向字符", "任意从右到左字符", "从左到右", "从右到左", "按语言环境", "首个强方向字符（默认从左到右）", "首个强方向字符（默认从右到左）"];
const layoutDirections = ["从左到右", "从右到左", "继承", "按语言环境"];
const ellipsizes: Record<string, string> = { NONE: "未启用", START: "开头省略", MIDDLE: "中间省略", END: "末尾省略", MARQUEE: "跑马灯", END_SMALL: "末尾省略（END_SMALL）" };

function decimal(raw: string): number | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function integer(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function enumLabel(raw: string, labels: readonly string[]): string | null {
  const value = integer(raw);
  return value !== null && value < labels.length ? labels[value] : null;
}

function textGravity(raw: string): string | null {
  const value = integer(raw);
  if (value === null || value > 0x7fffffff) return null;
  const horizontal: Record<number, string> = { 0: "", 1: "水平居中", 3: "左", 5: "右", 7: "水平填充", 0x800003: "起始侧", 0x800005: "结束侧" };
  const vertical: Record<number, string> = { 0: "", 0x10: "垂直居中", 0x30: "上", 0x50: "下", 0x70: "垂直填充" };
  const x = value & 0x800007, y = value & 0x70;
  const code = `0x${value.toString(16).toUpperCase()}`;
  // Keep unfamiliar combinations readable and copyable without inventing an alignment.
  if (horizontal[x] === undefined || vertical[y] === undefined || (value & ~(0x800007 | 0x70)) !== 0) return `原始组合 ${code}`;
  return [horizontal[x], vertical[y]].filter(Boolean).join(" · ") || "无";
}

/** Snapshot evidence only. Live SDK values have their own identity, time and UI. */
export function nodeTextStyle(node: Pick<UiNode, "attributes">): NodeTextStyle | null {
  const attributes = node.attributes;
  if (attributes?.["text-style-source"] !== "view-debug") return null;
  const properties: NodeTextStyleProperty[] = [];
  const add = (key: string, label: string, terms: string, parse: (raw: string) => string | null, kind: "value" | "color" = "value") => {
    const raw = attributes[key];
    if (typeof raw !== "string") return;
    const display = parse(raw);
    if (display !== null) properties.push({ key, label, raw, display, terms: `${key} ${terms}`, kind });
  };
  add("text-size-px", "字号", "文字大小 textSize textSizePx font size px", raw => {
    const value = decimal(raw);
    return value !== null && value >= 0 ? `${raw.trim()}px` : null;
  });
  add("text-typeface-style", "字体样式", "typeface style normal bold italic bold_italic 普通 粗体 斜体 粗斜体", raw => enumLabel(raw, typefaceStyles));
  add("text-color-argb", "文字色", "textColor text color ARGB", raw => /^#[0-9a-f]{8}$/i.test(raw.trim()) ? raw.trim() : null, "color");
  add("text-gravity", "框内对齐", "文字重力 gravity start end left right top bottom center fill 位置 对齐", textGravity);
  add("text-ellipsize", "省略方式", "ellipsize truncate marquee 跑马灯", raw => Object.prototype.hasOwnProperty.call(ellipsizes, raw.trim()) ? ellipsizes[raw.trim()] : null);
  // These three belong to every View. They cannot establish TextView style evidence by themselves.
  if (!properties.length) return null;
  add("text-alignment", "文字对齐", "textAlignment text alignment gravity start end center 对齐", raw => enumLabel(raw, textAlignments));
  add("text-direction", "文字方向", "textDirection text direction LTR RTL locale first strong", raw => enumLabel(raw, textDirections));
  add("layout-direction", "布局方向", "layoutDirection layout direction LTR RTL locale", raw => enumLabel(raw, layoutDirections));
  return { source: "view-debug", sourceLabel: "View Debug 快照属性", properties };
}
