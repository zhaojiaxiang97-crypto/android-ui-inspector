import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { buildLayerLayout, buildLayerOverview, layerRenderBounds } from "../shared/layer-layout";
import { collapsedTextureKey, hasOwnVisualStyle, visualFor } from "../src/features/layers/presentation";
import { layerFraming } from "../src/features/layers/framing";

const size = { width: 100, height: 100 };
function node(id: string, left: number, top: number, right: number, bottom: number) {
  return { ...makeNode(id), bounds: { left, top, right, bottom, raw: "fixture" } };
}

test("full layout retains negative, partial and beyond-screen bounds without mutating the snapshot", () => {
  const root = node("root", 0, 0, 100, 100);
  const left = node("left", -100, 0, 0, 100), bottom = node("bottom", 10, 120, 90, 220);
  const right = node("right", 120, -10, 220, 110), partial = node("partial", -10, -20, 40, 40);
  root.children = [left, bottom, right, partial];
  const before = JSON.stringify(root);
  assert.deepEqual(buildLayerOverview(root, right, size).records.map(r => r.id), [partial.id]);
  const full = buildLayerOverview(root, right, size, { showOffscreen: true });
  assert.deepEqual(full.records.map(r => r.id), root.children.map(n => n.id));
  for (const record of full.records) {
    const { left, top, right, bottom } = record.node.bounds!;
    assert.deepEqual(record.renderBounds, { left, top, right, bottom });
  }
  assert.equal(full.records.find(r => r.isSelected)?.node, right);
  const focused = buildLayerLayout(root, left, size, { showOffscreen: true, includeParents: false, includeChildren: false });
  assert.equal(focused.records[0].node, left);
  assert.equal(focused.records[0].renderBounds.left, -100);
  assert.equal(buildLayerOverview(left, left, size, { showOffscreen: true }).parent?.renderBounds.left, -100);
  assert.equal(JSON.stringify(root), before);
});

test("offscreen option respects folding and keeps a selected node beyond the render cap", () => {
  const root = node("root", 0, 0, 100, 100), branch = node("branch", -100, 0, 0, 100);
  branch.children = Array.from({ length: 12 }, (_, i) => node(`leaf-${i}`, -90, i * 5, -60, i * 5 + 4));
  root.children = [branch];
  const selected = branch.children[11];
  const folded = buildLayerOverview(root, selected, size, { showOffscreen: true, expandedIds: new Set([root.id]) });
  assert.deepEqual(folded.records.map(r => [r.id, r.isCollapsed]), [[branch.id, true]]);
  const expanded = buildLayerOverview(root, selected, size, { showOffscreen: true, maxLayers: 3 });
  assert.equal(expanded.records.length, 3);
  assert.equal(expanded.records.at(-1)?.node, selected);
  assert.equal(expanded.omittedCount, 10);
});

test("ancestor clipping may be bypassed, actual hidden and zero-alpha layouts stay opt-in", () => {
  const root = node("root", 0, 0, 100, 100), clipped = node("clipped", -80, 10, -20, 90);
  clipped.layerCapturePlacement = { screen: { left: 0, top: 10, width: 0, height: 80 },
    source: { left: 80, top: 0, width: 0, height: 80 }, hidden: true, opacity: 1 };
  const hidden = { ...node("hidden", 110, 10, 190, 90), visibleToUser: false };
  hidden.children = [node("hidden-child", 120, 20, 180, 80)];
  const transparent = { ...node("transparent", 10, 120, 90, 180), layerCapturePlacement: { ...clipped.layerCapturePlacement, opacity: 0 } };
  root.children = [clipped, hidden, transparent];
  const full = buildLayerOverview(root, root, size, { showOffscreen: true });
  assert.deepEqual(full.records.map(r => [r.id, r.isDeviceInvisible]), [[clipped.id, false]]);
  const all = buildLayerOverview(root, root, size, { showOffscreen: true, showInvisible: true });
  assert.deepEqual(all.records.map(r => [r.id, r.isDeviceInvisible]), [[clipped.id, false], [hidden.id, true], ["hidden-child", true], [transparent.id, true]]);
});

test("full layout rejects empty, reversed, missing and non-finite geometry", () => {
  assert.equal(layerRenderBounds(null, size, true), null);
  for (const coordinates of [[0, 0, 0, 10], [2, 0, 1, 10], [0, 2, 10, 1], [0, 0, Infinity, 10], [NaN, 0, 10, 10]]) {
    const [l, t, r, b] = coordinates;
    assert.equal(layerRenderBounds(node("invalid", l, t, r, b).bounds, size, true), null);
  }
});

test("offscreen bitmaps retain full UVs while absent pixels remain outlines", () => {
  const root = node("root", 0, 0, 100, 100), leaf = node("leaf", -20, 10, 40, 50);
  leaf.className = "android.widget.TextView"; leaf.text = "offscreen"; root.children = [leaf];
  const clipped = buildLayerOverview(root, leaf, size).records[0];
  const full = buildLayerOverview(root, leaf, size, { showOffscreen: true }).records[0];
  assert.equal(hasOwnVisualStyle(clipped, size, new Set(), new Map()), true);
  assert.equal(hasOwnVisualStyle(full, size, new Set(), new Map()), false);
  leaf.layerImageDataUrl = "own-image"; leaf.layerImageSize = { width: 60, height: 40 };
  assert.equal(hasOwnVisualStyle(full, size, new Set(), new Map()), true);
  assert.deepEqual(visualFor(full, size, "", null).source, { left: 0, top: 0, width: 60, height: 40 });
  assert.deepEqual(visualFor(clipped, size, "", null).source, { left: 20, top: 0, width: 40, height: 40 });
});

test("folded texture cache changes when full-layout composition changes its canvas origin", () => {
  const root = node("root", 0, 0, 100, 100), branch = node("branch", -20, 0, 80, 100);
  branch.children = [node("leaf", -10, 20, 60, 80)]; root.children = [branch];
  const options = { expandedIds: new Set([root.id]) };
  const clipped = buildLayerOverview(root, branch, size, options).records[0];
  const full = buildLayerOverview(root, branch, size, { ...options, showOffscreen: true }).records[0];
  const oldKey = collapsedTextureKey(clipped, "", null), newKey = collapsedTextureKey(full, "", null);
  assert.notEqual(oldKey, newKey);
  assert.equal(collapsedTextureKey({ ...full, renderBounds: { ...full.renderBounds } }, "", null), newKey);
});

test("screen framing ignores distant branches and clips partial bounds only for the camera", () => {
  const root = node("root", 0, 0, 100, 100), distant = node("distant", -5000, 0, -4900, 100);
  root.children = [distant, node("partial", -20, 80, 20, 200), node("current", 20, 20, 80, 80)];
  const layout = buildLayerOverview(root, root, size, { showOffscreen: true });
  const records = [layout.parent!, ...layout.records], before = JSON.stringify(records);
  const screen = layerFraming(records, size, true), all = layerFraming(records, size, false);
  assert.equal(screen.center.x, 50); assert.equal(screen.center.y, 50);
  assert.equal(screen.frames.length, 3);
  assert.equal(all.center.x, -2450); assert.equal(all.center.y, 100);
  assert.equal(all.frames.length, 4);
  const focus = layerFraming([layout.records.find(r => r.id === distant.id)!], size, false);
  assert.equal(focus.center.x, -4950);
  assert.equal(JSON.stringify(records), before);
  assert.deepEqual(layerFraming([], size, true).center, { x: 50, y: 50, z: 0 });
});

test("offscreen preload branches cannot exhaust the render cap before current-page nodes", () => {
  const root = node("root", 0, 0, 100, 100);
  root.children = Array.from({ length: 10 }, (_, i) => node(`preload-${i}`, -100, i * 5, -50, i * 5 + 4));
  const selected = root.children[9], current = node("current", 0, 0, 100, 100);
  root.children.push(current);
  const result = buildLayerOverview(root, selected, size, { showOffscreen: true, maxLayers: 2 });
  assert.deepEqual(result.records.map(r => r.id), [selected.id, current.id]);
  assert.equal(result.records[0].isSelected, true);
  assert.equal(result.omittedCount, 9);
});
