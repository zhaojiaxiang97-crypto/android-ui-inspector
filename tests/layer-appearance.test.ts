import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_LAYER_APPEARANCE, parseLayerAppearance } from "../src/features/layers/appearance";

describe("layer appearance preferences", () => {
  test("old saved preferences retain their appearance and default to free rotation", () => {
    assert.deepEqual(parseLayerAppearance({ showOutlines: false, highlightStrength: "strong" }), {
      showOutlines: false, highlightStrength: "strong", rotationMode: "free",
    });
  });

  test("horizontal rotation survives JSON storage alongside existing preferences", () => {
    const saved = { showOutlines: false, highlightStrength: "medium", rotationMode: "horizontal" };
    assert.deepEqual(parseLayerAppearance(JSON.parse(JSON.stringify(saved))), saved);
    assert.deepEqual(parseLayerAppearance({ ...saved, rotationMode: "free" }), { ...saved, rotationMode: "free" });
  });

  test("invalid rotation values fall back without resetting valid appearance", () => {
    for (const rotationMode of [undefined, null, true, "vertical", [], {}]) {
      assert.deepEqual(parseLayerAppearance({ showOutlines: false, highlightStrength: "medium", rotationMode }), {
        showOutlines: false, highlightStrength: "medium", rotationMode: "free",
      });
    }
    for (const saved of [null, undefined, true, [], "broken", 42]) {
      assert.deepEqual(parseLayerAppearance(saved), DEFAULT_LAYER_APPEARANCE);
    }
  });
});
