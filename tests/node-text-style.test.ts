import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeTextStyle } from "../shared/node-text-style";

const style = (attributes: Record<string, string>) => nodeTextStyle({ attributes: { "text-style-source": "view-debug", ...attributes } });
const property = (attributes: Record<string, string>, key: string) => style(attributes)?.properties.find(item => item.key === key);

test("only explicit snapshot evidence with a valid TextView style creates a section", () => {
  assert.equal(nodeTextStyle({}), null);
  assert.equal(nodeTextStyle({ attributes: { "text-size-px": "14" } }), null);
  assert.equal(style({ "text-style-source": "sdk", "text-size-px": "14" }), null);
  assert.equal(style({}), null);
  assert.equal(style({ "text-alignment": "1", "text-direction": "0", "layout-direction": "0" }), null);
  assert.equal(style({ "text-typeface-style": "4", "text-direction": "0" }), null);
  assert.equal(style({ "text-ellipsize": "NONE" })?.sourceLabel, "View Debug 快照属性");
});

test("size accepts zero and decimal precision, preserving raw px without inferring sp", () => {
  for (const raw of ["0", "0.0", "13.123456789", " 14.5000 ", "1e2"]) {
    const result = property({ "text-size-px": raw }, "text-size-px")!;
    assert.equal(result.raw, raw);
    assert.equal(result.display, `${raw.trim()}px`);
    assert(!result.display.includes("sp"));
  }
  for (const raw of ["", " ", "-1", "NaN", "Infinity", "1e309", "14px", "0x10", "0b10", "1,5"]) {
    assert.equal(style({ "text-size-px": raw }), null, raw);
  }
});

test("Typeface style is an enum, not numeric weight or a guessed font family", () => {
  for (const [raw, label] of ["普通", "粗体", "斜体", "粗斜体"].entries()) {
    const result = property({ "text-typeface-style": String(raw) }, "text-typeface-style")!;
    assert.equal(result.display, label);
    assert.equal(result.raw, String(raw));
  }
  for (const raw of ["-1", "4", "400", "1.5", "bold", "constructor", "__proto__"]) assert.equal(style({ "text-typeface-style": raw }), null, raw);
});

test("ARGB accepts only complete source colors and keeps transparent zero alpha", () => {
  for (const raw of ["#00123456", "#FF123456", "  #ffabcdef  "]) {
    assert.equal(property({ "text-color-argb": raw }, "text-color-argb")?.raw, raw);
    assert.equal(property({ "text-color-argb": raw }, "text-color-argb")?.kind, "color");
  }
  for (const raw of ["#123456", "#FFF", "#GG123456", "0xFF123456", "transparent", ""]) assert.equal(style({ "text-color-argb": raw }), null, raw);
});

test("gravity separates relative start/end and vertical placement and retains raw", () => {
  for (const [raw, display] of [
    ["8388659", "起始侧 · 上"], ["8388693", "结束侧 · 下"],
    ["17", "水平居中 · 垂直居中"], ["119", "水平填充 · 垂直填充"],
    ["3", "左"], ["5", "右"], ["0", "无"],
    ["256", "原始组合 0x100"],
  ]) {
    const result = property({ "text-gravity": raw }, "text-gravity")!;
    assert.equal(result.display, display); assert.equal(result.raw, raw);
  }
  for (const raw of ["-1", "1.5", "2147483648", "9007199254740992", "0x11", "NaN", ""]) assert.equal(style({ "text-gravity": raw }), null, raw);
});

test("known ellipsize values include explicit NONE; missing and unknown stay absent", () => {
  for (const raw of ["NONE", "START", "MIDDLE", "END", "MARQUEE", "END_SMALL"]) {
    assert.equal(property({ "text-ellipsize": raw }, "text-ellipsize")?.raw, raw);
  }
  assert.equal(property({ "text-ellipsize": "NONE" }, "text-ellipsize")?.display, "未启用");
  for (const raw of ["", "null", "UNKNOWN", "end", "constructor", "__proto__"]) assert.equal(style({ "text-ellipsize": raw }), null, raw);
});

test("base View enums appear only alongside text evidence and reject unsupported values", () => {
  const attributes = { "text-size-px": "0", "text-alignment": "6", "text-direction": "7", "layout-direction": "2" };
  assert.equal(property(attributes, "text-alignment")?.display, "控件结束侧");
  assert.equal(property(attributes, "text-direction")?.display, "首个强方向字符（默认从右到左）");
  assert.equal(property(attributes, "layout-direction")?.display, "继承");
  assert.equal(style({ "text-size-px": "0", "text-alignment": "7", "text-direction": "8", "layout-direction": "4" })?.properties.length, 1);
});

test("snapshot round trip keeps fields and source; extraction never mutates attributes", () => {
  const attributes = Object.freeze({ "text-style-source": "view-debug", "text-size-px": "14.12500", "text-typeface-style": "3", "text-color-argb": "#80123456" });
  const before = JSON.stringify(attributes);
  const original = nodeTextStyle({ attributes });
  const restored = nodeTextStyle(JSON.parse(JSON.stringify({ attributes })));
  assert.deepEqual(restored, original);
  assert.equal(JSON.stringify(attributes), before);
  assert.equal(original?.properties.length, 3);
  assert(original?.properties.every(item => item.terms.includes(item.key)));
});
