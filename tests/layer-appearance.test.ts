import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_LAYER_APPEARANCE, parseLayerAppearance } from "../src/features/layers/appearance";

describe("layer appearance preferences", () => {
  test("empty layers default off, migrate old settings and persist independently", () => {
    assert.equal(DEFAULT_LAYER_APPEARANCE.showEmpty, false);
    assert.equal(parseLayerAppearance({ showOutlines: true, structureMode: "complete" }).showEmpty, false);
    const saved = { ...DEFAULT_LAYER_APPEARANCE, showEmpty: true, showInvisible: true, structureMode: "complete" };
    assert.deepEqual(parseLayerAppearance(JSON.parse(JSON.stringify(saved))), saved);
    for (const showEmpty of [undefined, null, "true", 1, [], {}]) {
      assert.deepEqual(parseLayerAppearance({ ...saved, showEmpty }), { ...saved, showEmpty: false });
    }
  });
  test("structure density round trips and invalid stored values retain the other preferences", () => {
    for (const structureMode of ["regular", "complete"] as const) {
      const stored = { ...DEFAULT_LAYER_APPEARANCE, structureMode, showOutlines: false };
      assert.deepEqual(parseLayerAppearance(JSON.parse(JSON.stringify(stored))), stored);
    }
    for (const structureMode of [null, "dense", 1, true, {}]) {
      assert.deepEqual(parseLayerAppearance({ structureMode, showOutlines: false }), { ...DEFAULT_LAYER_APPEARANCE, showOutlines: false });
    }
  });
  test("old saved preferences retain their appearance and default to free rotation", () => {
    assert.deepEqual(parseLayerAppearance({ showOutlines: false, highlightStrength: "strong" }), {
      showOutlines: false, showEmpty: false, showInvisible: false, showOffscreen: false, highlightStrength: "strong", rotationMode: "free", structureMode: "regular",
    });
  });

  test("horizontal rotation survives JSON storage alongside existing preferences", () => {
    const saved = { showOutlines: false, showEmpty: false, showInvisible: false, showOffscreen: false, highlightStrength: "medium", rotationMode: "horizontal", structureMode: "complete" };
    assert.deepEqual(parseLayerAppearance(JSON.parse(JSON.stringify(saved))), saved);
    assert.deepEqual(parseLayerAppearance({ ...saved, rotationMode: "free" }), { ...saved, rotationMode: "free" });
  });

  test("invalid rotation values fall back without resetting valid appearance", () => {
    for (const rotationMode of [undefined, null, true, "vertical", [], {}]) {
      assert.deepEqual(parseLayerAppearance({ showOutlines: false, highlightStrength: "medium", rotationMode }), {
        showOutlines: false, showEmpty: false, showInvisible: false, showOffscreen: false, highlightStrength: "medium", rotationMode: "free", structureMode: "regular",
      });
    }
    for (const saved of [null, undefined, true, [], "broken", 42]) {
      assert.deepEqual(parseLayerAppearance(saved), DEFAULT_LAYER_APPEARANCE);
    }
  });

  test("invisible layouts are opt-in and invalid values retain the other settings", () => {
    assert.equal(parseLayerAppearance({ showInvisible: true }).showInvisible, true);
    for (const showInvisible of [undefined, null, "true", 1, [], {}]) {
      assert.deepEqual(parseLayerAppearance({ showInvisible, showOutlines: false, rotationMode: "horizontal" }), {
        ...DEFAULT_LAYER_APPEARANCE, showOutlines: false, rotationMode: "horizontal",
      });
    }
  });

  test("offscreen layers are opt-in, persist independently and reject invalid stored values", () => {
    const saved = { ...DEFAULT_LAYER_APPEARANCE, showOffscreen: true };
    assert.deepEqual(parseLayerAppearance(JSON.parse(JSON.stringify(saved))), saved);
    assert.equal(parseLayerAppearance({ showInvisible: true }).showOffscreen, false);
    assert.equal(parseLayerAppearance({ showOffscreen: true }).showInvisible, false);
    for (const showOffscreen of [undefined, null, "true", 1, [], {}]) {
      assert.deepEqual(parseLayerAppearance({ showOffscreen, showOutlines: false }), { ...DEFAULT_LAYER_APPEARANCE, showOutlines: false });
    }
  });
});
