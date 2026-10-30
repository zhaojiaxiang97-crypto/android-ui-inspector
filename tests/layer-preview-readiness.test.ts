import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore -- shared pure JS probe also runs directly under Node.
import { layerPreviewReadiness } from "../scripts/lib/layer-preview-readiness";

test("received batch count does not gate eligible scene textures", () => {
  const result = layerPreviewReadiness(["a", "b", "empty", "hidden", "a"], [{ id: "a", key: "v1" }, { id: "b", key: "v2" }],
    [{ id: "a", key: "v1", drawn: true }, { id: "b", key: "v2", drawn: false }]);
  assert.deepEqual(result, { ready: true, eligible: 2, drawn: 1, excluded: 2, missing: [] });
});
test("missing and stale image or clipping identities never satisfy readiness", () => {
  for (const committed of [[], [{ id: "a", key: "v1#old-clip", drawn: true }], [{ id: "other", key: "v2#new-clip", drawn: true }]]) {
    assert.deepEqual(layerPreviewReadiness(["a"], [{ id: "a", key: "v2#new-clip" }], committed).missing, ["a"]);
  }
});
test("no eligible surface cannot falsely prove image presentation", () => {
  assert.equal(layerPreviewReadiness(["hidden"], [], []).ready, false);
});
