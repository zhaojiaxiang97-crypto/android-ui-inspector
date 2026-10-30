import assert from "node:assert/strict";
import { test } from "node:test";
import { layerImageProvenance, layerImagePresentation } from "../shared/layer-image-provenance";
import { makeNode } from "../benchmarks/fixtures";
import { attachViewLayerImages } from "../electron/capture/layer-images";
import { layerImageBaseline, changedLayerImages, mergeLayerImages } from "../shared/tree-utils";

const base = { collapsed: true, hasGroup: false, hiddenDescendants: false, canRequestGroup: true };
test("source presentation separates local reconstruction, unavailable content and verification", () => {
  for (const groupState of ["pending", "unavailable", "hidden-descendants", "not-live", "not-requested"]) {
    const hint = layerImagePresentation({ source: "local-composite", groupState });
    assert.equal(hint.label, "本地重建图");
    assert.match(hint.detail, /不保证与原生整组图逐像素一致/);
  }
  assert.match(layerImagePresentation({ source: "local-composite", groupState: "unavailable" }).detail, /原因未返回/);
  assert.match(layerImagePresentation({ source: "local-composite", groupState: "hidden-descendants" }).detail, /已排除隐藏/);
  const live = layerImagePresentation({ source: "live-group", groupState: "ready" });
  assert.equal(live.label, "原生整组图"); assert.match(live.detail, /不保证与原快照同帧/);
  assert.match(live.detail, /来源不代表逐像素校验通过/);
  assert.equal(layerImagePresentation({ source: "none", groupState: "pending" }).label, "仅边框");
});
test("folded provenance distinguishes live pixels from pending/unavailable/local fallback", () => {
  assert.deepEqual(layerImageProvenance({ ...base, hasGroup: true }), { source: "live-group", groupState: "ready" });
  for (const requestState of ["pending", "unavailable"] as const)
    assert.deepEqual(layerImageProvenance({ ...base, requestState }), { source: "local-composite", groupState: requestState });
  assert.equal(layerImageProvenance({ ...base, canRequestGroup: false }).groupState, "not-live");
  assert.equal(layerImageProvenance({ ...base, hasGroup: true, hiddenDescendants: true }).groupState, "hidden-descendants");
  assert.equal(layerImageProvenance({ ...base, hasGroup: true, hiddenDescendants: true }).source, "local-composite");
  assert.equal(layerImageProvenance({ ...base }).groupState, "not-requested");
});
test("old snapshots remain unknown, not inferred from SDK tree or native render role", () => {
  assert.deepEqual(layerImageProvenance({ ...base, collapsed: false }), { source: "unknown", groupState: "not-applicable" });
  assert.equal(layerImageProvenance({ ...base, collapsed: false, ownSource: "ddms" }).source, "ddms");
});
test("batch channel provenance follows validated image and survives progressive updates", () => {
  for (const source of ["ddms", "sdk", "unknown"] as const) {
    const root = makeNode("0"); root.children = [];
    root.bounds = { left: 0, top: 0, right: 10, bottom: 10, raw: "" };
    root.attributes = { "debug-layer-name": "View" };
    const tree = makeNode("activity"); tree.children = [root];
    const original = structuredClone(tree), baseline = layerImageBaseline(tree);
    assert.equal(attachViewLayerImages(tree, [{ name: "View", visible: true, x: 0, y: 0, width: 10, height: 10, imageDataUrl: "pixels" }], { x: 0, y: 0 }, source), 1);
    assert.equal(root.attributes["image-capture-source"], source);
    const merged = mergeLayerImages(original, changedLayerImages(tree, baseline)!);
    assert.equal(merged.children[0].attributes?.["image-capture-source"], source);
    const before = layerImageBaseline(tree); root.attributes["image-capture-source"] = "unknown";
    if (source !== "unknown") assert.equal(changedLayerImages(tree, before)?.length, 1, "source-only changes must be sent");
  }
});
