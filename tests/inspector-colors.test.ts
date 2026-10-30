import { test } from "node:test";
import assert from "node:assert/strict";
import { colorAlias, colorAliasText, colorHasExactHex, colorHex, colorRgba, DEFAULT_COLOR_ALIASES,
  parseAliasColor, parseColorAliasPreference, parseColorAliasText, parseInspectorColor } from "../shared/inspector-colors";

test("Android ARGB and CSS hex use different alpha positions without losing source channels", () => {
  const color = parseInspectorColor("#80123456", "android-argb")!;
  assert.deepEqual(color, { red: 18, green: 52, blue: 86, alpha: 128 / 255 });
  assert.equal(colorHex(color), "#12345680");
  assert.equal(colorRgba(color), `rgba(18, 52, 86, ${128 / 255})`);
  assert.deepEqual(parseAliasColor("#12345680"), color);
  assert.equal(parseInspectorColor("#80123456", "qml-rgba"), null);
  assert.equal(parseInspectorColor("rgba(18,52,86,0.5)", "android-argb"), null);
});

test("all Android alpha bytes round trip through hex and RGBA, including invisible RGB", () => {
  for (let alpha = 0; alpha <= 255; alpha++) {
    const raw = `#${alpha.toString(16).padStart(2, "0")}12a4f6`;
    const color = parseInspectorColor(raw, "android-argb")!;
    assert.deepEqual(parseAliasColor(colorHex(color)), color);
    assert.deepEqual(parseAliasColor(colorRgba(color)), color);
    assert(colorHasExactHex(color));
  }
  assert.equal(colorHex(parseInspectorColor("#0012A4F6", "android-argb")!), "#12A4F600");
});

test("QML alpha retains its precision; an approximate hex does not become an exact alias", () => {
  const color = parseInspectorColor("rgba(18,52,86,0.5)", "qml-rgba")!;
  assert.equal(colorRgba(color), "rgba(18, 52, 86, 0.5)");
  assert.equal(colorHex(color), "#12345680");
  assert(!colorHasExactHex(color));
  const preference = parseColorAliasText("#12345680 = 八位透明度\nrgba(18,52,86,0.5) = 半透明").preference!;
  assert.equal(colorAlias(color, preference), "半透明");
  assert.equal(colorAlias(parseAliasColor("#12345680")!, preference), "八位透明度");
  const fine = parseInspectorColor("rgba(1,2,3,1e-7)", "qml-rgba")!;
  assert.deepEqual(parseAliasColor(colorRgba(fine)), fine);
  assert.equal(colorHasExactHex(fine), false);
  assert.equal(colorAlias(parseAliasColor("#123456")!, preference), null);
});

test("missing, out-of-range and arbitrary CSS values cannot generate a preview", () => {
  for (const raw of [null, 1, "", "未暴露", "red", "transparent", "#123", "#123456", "#GG123456", "url(x)", "rgba(256,1,2,1)", "rgba(-1,2,3,1)", "rgba(1.1,2,3,1)", "rgba(1,2,3,1.01)", "rgba(1,2,3,-0.1)", "rgba(1,2,3,Infinity)", "rgba(1,2,3,1);color:red", " ".repeat(129)]) {
    assert.equal(parseInspectorColor(raw, "qml-rgba"), null);
    assert.equal(parseInspectorColor(raw, "android-argb"), null);
  }
  assert.equal(parseAliasColor("#123456" )?.alpha, 1);
  assert.equal(parseAliasColor("rgba(0,0,0,0)")?.alpha, 0);
});

test("alias normalization preserves alpha and names, with duplicates and bounded input rejected", () => {
  const parsed = parseColorAliasText(" #123456 = 品牌主色 \n\nrgba(18, 52, 86, 0.5) = 半透明 = 次级\n#12345600 = 透明");
  assert.equal(parsed.error, null);
  assert.equal(parsed.preference!.entries[1].alias, "半透明 = 次级");
  assert.deepEqual(parseColorAliasText(colorAliasText(parsed.preference!)).preference, parsed.preference);
  assert.deepEqual(parseColorAliasPreference(JSON.parse(JSON.stringify(parsed.preference))), parsed.preference);
  assert.deepEqual(parseColorAliasText("\n ").preference, DEFAULT_COLOR_ALIASES);
  for (const text of ["#123456 = 主色\n#123456FF = 重复", "#123456 = 主色\nrgba(18,52,86,1) = 重复", "#123 = 名称", "#123456 =", `#123456 = ${"名".repeat(65)}`, "#123456 = 名\t称", " ".repeat(8193), Array.from({ length: 33 }, (_, i) => `rgba(0,0,${i},1) = 名称`).join("\n")]) {
    assert.equal(parseColorAliasText(text).preference, null, text);
  }
});

test("corrupt and unsupported stored alias preferences are rejected as a whole", () => {
  for (const raw of [null, [], { version: 2, entries: [] }, { version: 1, entries: "bad" }, { version: 1, entries: [null] },
    { version: 1, entries: [{ color: "red", alias: "主色" }] }, { version: 1, entries: [{ color: "#123456", alias: 0 }] },
    { version: 1, entries: [{ color: "#123456", alias: "" }] }, { version: 1, entries: [{ color: "#123456", alias: "主色" }, { color: "#123456FF", alias: "重复" }] },
    { version: 1, entries: Array.from({ length: 33 }, (_, i) => ({ color: `rgba(0,0,${i},1)`, alias: "名称" })) }]) {
    assert.equal(parseColorAliasPreference(raw), null);
  }
});
