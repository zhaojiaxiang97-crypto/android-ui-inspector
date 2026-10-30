import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_COLOR_FORMAT, inspectorColorDisplay, parseColorDisplayFormat } from "../shared/color-display";
import { DEFAULT_COLOR_ALIASES, parseColorAliasText } from "../shared/inspector-colors";

test("color display accepts only the three persistent choices and defaults to Hex", () => {
  assert.equal(DEFAULT_COLOR_FORMAT, "hex");
  for (const format of ["hex", "rgba", "raw"]) assert.equal(parseColorDisplayFormat(format), format);
  for (const value of [null, undefined, {}, [], "RGBA", "", "rgba "]) assert.equal(parseColorDisplayFormat(value), null);
});

test("display formatting keeps Android alpha and QML precision, aliases and original bytes", () => {
  const android = inspectorColorDisplay(" #80123456 ", "android-argb", "hex", DEFAULT_COLOR_ALIASES);
  assert.equal(android.value, "#12345680"); assert.equal(android.approximate, false);
  assert.equal(android.values.raw, " #80123456 ");
  assert.equal(android.values.rgba, `rgba(18, 52, 86, ${128 / 255})`);
  const aliases = parseColorAliasText("rgba(1,2,3,0.123456789) = 精确透明度").preference!;
  const precise = inspectorColorDisplay("rgba(1,2,3,0.123456789)", "qml-rgba", "hex", aliases);
  assert.equal(precise.alias, "精确透明度"); assert.equal(precise.approximate, true);
  assert.equal(precise.values.rgba, "rgba(1, 2, 3, 0.123456789)");
  const rgba = inspectorColorDisplay(precise.values.raw, "qml-rgba", "rgba", aliases);
  assert.equal(rgba.value, precise.values.rgba); assert.equal(rgba.approximate, false);
  assert.equal(inspectorColorDisplay("#00123456", "android-argb", "hex", aliases).value, "#12345600");
});

test("unknown source and invalid colors remain raw for every preference without a fabricated swatch", () => {
  for (const format of ["hex", "rgba", "raw"] as const) for (const [raw, encoding] of [["#80123456", undefined], ["#bad", "android-argb"], ["rgba(1,2,3,2)", "qml-rgba"]] as const) {
    const display = inspectorColorDisplay(raw, encoding, format, DEFAULT_COLOR_ALIASES);
    assert.equal(display.color, null); assert.equal(display.format, "raw"); assert.equal(display.value, raw);
    assert.equal(display.values.hex, ""); assert.equal(display.values.rgba, "");
  }
});
