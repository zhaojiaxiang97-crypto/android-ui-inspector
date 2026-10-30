import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_APPEARANCE, parseAppearancePreference, readAppearancePreference, resolveAppearance } from "../shared/appearance";

test("appearance only accepts the three supported choices from local storage", () => {
  for (const value of ["dark", "light", "system"] as const) {
    assert.equal(parseAppearancePreference(value), value);
    assert.equal(readAppearancePreference(value), value);
  }
  for (const value of [null, undefined, true, 0, {}, [], "auto", "Dark", " light ", '"system"', "x".repeat(8192)]) {
    assert.equal(parseAppearancePreference(value), null);
  }
});

test("first use and corrupt preferences preserve the existing dark default", () => {
  assert.equal(DEFAULT_APPEARANCE, "dark");
  for (const raw of [null, "", "null", "{}", "auto", "system\n"]) {
    assert.equal(readAppearancePreference(raw), "dark");
  }
});

test("system appearance follows the OS while explicit choices remain stable", () => {
  assert.equal(resolveAppearance("system", true), "dark");
  assert.equal(resolveAppearance("system", false), "light");
  for (const systemDark of [true, false]) {
    assert.equal(resolveAppearance("light", systemDark), "light");
    assert.equal(resolveAppearance("dark", systemDark), "dark");
  }
});
