import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyLayerIds } from "../shared/empty-layers";
import { buildLayerOverview } from "../shared/layer-layout";
import { makeNode } from "../benchmarks/fixtures";
import type { UiNode } from "../shared/types";

const node = (id: string): UiNode => ({ ...makeNode(id), children: [], bounds: { left: 0, top: 0, right: 200, bottom: 200, raw: "fixture" } });
const empty = (id: string): UiNode => ({ ...node(id), layerImageEmpty: true });
const size = { width: 200, height: 200 };

test("empty wrappers disappear before packing/capping while their content and tree remain", () => {
  const root = empty("root"), wrapper = empty("wrapper"), child = node("painted");
  wrapper.children = [child]; root.children = [wrapper];
  const expanded = new Set([root.id, wrapper.id]), before = JSON.stringify(root);
  const hiddenIds = emptyLayerIds(root, expanded);
  assert.deepEqual([...hiddenIds].sort(), [root.id, wrapper.id].sort());
  for (const compactStructure of [true, false]) {
    const layout = buildLayerOverview(root, wrapper, size, { expandedIds: expanded, hiddenIds, maxLayers: 1, compactStructure });
    assert.deepEqual(layout.records.map(r => r.id), [child.id]);
    assert.equal(layout.records[0].z, 0); assert.equal(layout.parent, null);
    assert.equal(layout.truncated, false);
  }
  assert.equal(JSON.stringify(root), before);
});

test("folded empty wrappers keep visible, missing and failed descendants or a saved group image", () => {
  for (const state of ["captured", "failed", "unavailable"] as const) {
    const root = empty("root"), child = { ...node("child"), layerImageStatus: state };
    root.children = [child]; assert.equal(emptyLayerIds(root, new Set()).has(root.id), false);
  }
  const root = empty("root"); root.children = [empty("child")];
  assert.equal(emptyLayerIds(root, new Set()).has(root.id), true);
  assert.equal(emptyLayerIds(root, new Set(), new Set([root.id])).has(root.id), false);
  assert.equal(emptyLayerIds(root, new Set([root.id]), new Set([root.id])).has(root.id), true);
});

test("only confirmed empty pixels and skip-draw are hidden, not partial transparency or capture problems", () => {
  const root = node("root"), structural = { ...node("structural"), attributes: { "skip-draw": "true" } };
  const failed = { ...empty("failed"), layerImageStatus: "failed" as const };
  const ambiguous = { ...empty("ambiguous"), layerImageStatus: "ambiguous" as const };
  const semi = { ...node("semi"), layerImageDataUrl: "image", layerImageEmpty: false, attributes: { alpha: "0.2" } };
  root.children = [empty("transparent"), structural, failed, ambiguous, semi, node("unknown")];
  assert.deepEqual([...emptyLayerIds(root, new Set([root.id]))].sort(), ["structural", "transparent"]);
});

test("a long fully empty folded branch stays empty without recursive traversal", () => {
  const root = empty("root"); let parent = root;
  for (let i = 0; i < 4000; i++) { const child = empty(String(i)); parent.children = [child]; parent = child; }
  assert.equal(emptyLayerIds(root, new Set()).size, 4001);
});
