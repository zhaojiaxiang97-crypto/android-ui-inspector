import { test } from "node:test";
import assert from "node:assert/strict";
import type { ViewFontResult } from "../shared/view-font";
import { nodeFontPresentation } from "../shared/node-font-presentation";

const font: ViewFontResult = { ref: "TextView@a", capturedAtMillis: 1_792_000_000_000, source: "jdwp", basis: "text-paint",
  familyName: "sans-serif", familyNameStatus: "system-family", weight: 500, style: 2, usesDefaultTypeface: false };
const row = (value: ViewFontResult, key: string) => nodeFontPresentation(value)?.find(property => property.key === key);

test("font rows retain returned family and numeric weight without inferring a font file", () => {
  const before = JSON.stringify(font), properties = nodeFontPresentation(font)!;
  assert.equal(row(font, "font-family")?.value, "sans-serif");
  assert.equal(row(font, "font-weight")?.value, "500");
  assert.equal(row(font, "font-style")?.display, "斜体");
  assert.equal(row(font, "font-italic")?.value, "true");
  assert.equal(row(font, "font-default")?.value, "false");
  assert.equal(properties.length, 5);
  assert(!JSON.stringify(properties).includes(".ttf"));
  assert.equal(JSON.stringify(font), before);
});

test("missing and unsupported family names stay distinct and never claim a custom font", () => {
  const hidden = { ...font, familyName: null, familyNameStatus: "not-exposed" as const };
  const unsupported = { ...hidden, familyNameStatus: "unsupported" as const };
  assert.equal(row(hidden, "font-family")?.display, "未提供名称");
  assert.equal(row(unsupported, "font-family")?.display, "当前系统不支持读取名称");
  for (const value of [hidden, unsupported]) assert(!JSON.stringify(nodeFontPresentation(value)).includes("自定义"));
});

test("style enum determines italic while numeric weight and default status remain independent", () => {
  for (let style = 0; style <= 3; style++) {
    const value = { ...font, weight: null, style, usesDefaultTypeface: true };
    assert.equal(row(value, "font-style")?.display, ["普通", "粗体", "斜体", "粗斜体"][style]);
    assert.equal(row(value, "font-italic")?.value, String(Boolean(style & 2)));
    assert.equal(row(value, "font-weight")?.display, "未提供");
    assert.equal(row(value, "font-default")?.value, "true");
  }
  assert.equal(row({ ...font, style: null }, "font-italic")?.display, "未提供");
  assert.equal(row({ ...font, style: 1, weight: 325 }, "font-weight")?.value, "325");
});

test("invalid identity metadata, enums and mismatched family status are not presented as facts", () => {
  for (const patch of [
    { ref: "" }, { capturedAtMillis: NaN }, { capturedAtMillis: 0 }, { capturedAtMillis: 1.5 },
    { source: "snapshot" }, { basis: "glyph" }, { weight: 0 }, { weight: 1001 }, { weight: 300.5 }, { weight: Infinity },
    { style: -1 }, { style: 4 }, { style: NaN }, { usesDefaultTypeface: null }, { familyName: " " },
    { familyName: null }, { familyNameStatus: "unknown" }, { familyNameStatus: "not-exposed" },
  ]) assert.equal(nodeFontPresentation({ ...font, ...patch } as ViewFontResult), null, JSON.stringify(patch));
});
