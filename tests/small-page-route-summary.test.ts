import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import type { UiSnapshot } from "../shared/types";
import { compareSmallPageRoutes, smallPageRouteSummary } from "../scripts/small-page-route-summary";

test("cross-route comparison matches refs instead of transient row IDs", () => {
  const node = makeNode("first"); node.attributes = { "view-ref": "Example@abc" }; node.layerImageStatus = "captured";
  node.layerImageDataUrl = "data:image/png;base64,AA==";
  const snapshot = { root: node, error: null, nodeCount: 1 } as UiSnapshot;
  const a = smallPageRouteSummary(snapshot);
  node.id = "different-sdk-row";
  assert.deepEqual(compareSmallPageRoutes(a, smallPageRouteSummary(snapshot)).differences, []);
  node.layerImageDataUrl = "data:image/png;base64,AQ==";
  assert.equal(compareSmallPageRoutes(a, smallPageRouteSummary(snapshot)).differences[0].kind, "encoded-image");
  delete node.layerImageDataUrl; node.layerImageStatus = "failed";
  assert.equal(compareSmallPageRoutes(a, smallPageRouteSummary(snapshot)).differences[0].kind, "coverage-or-status");
  node.attributes["view-ref"] = "Example@def";
  assert.equal(compareSmallPageRoutes(a, smallPageRouteSummary(snapshot)).differences.length, 2);
  node.children = [{ ...node, children: [] }];
  assert.throws(() => smallPageRouteSummary(snapshot), /duplicate View ref/);
});

test("codec differences stay separate from empty, size and geometry regressions", () => {
  const node = makeNode("first"); node.attributes = { "view-ref": "Example@abc" };
  node.layerImageStatus = "captured"; node.layerImageEmpty = true;
  node.layerImageSize = { width: 10, height: 20 }; node.layerImageDataUrl = "data:image/png;base64,AA==";
  const snapshot = { root: node, error: null, nodeCount: 1 } as UiSnapshot;
  const before = smallPageRouteSummary(snapshot);
  node.layerImageDataUrl = "data:image/webp;base64,AQ==";
  const structural = () => compareSmallPageRoutes(before, smallPageRouteSummary(snapshot)).differences.filter(x => x.kind !== "encoded-image");
  assert.deepEqual(structural(), [], "codec digests cannot stand in for decoded pixels");
  node.layerImageEmpty = false;
  assert.equal(structural()[0].kind, "coverage-or-status");
  node.layerImageEmpty = true; node.layerImageSize.width = 11;
  assert.equal(structural()[0].kind, "image-size");
  node.layerImageSize.width = 10; node.bounds!.left++;
  assert.equal(structural()[0].kind, "geometry-or-type");
});
