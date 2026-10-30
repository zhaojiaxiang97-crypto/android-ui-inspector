import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { emptyLayerIds } from "../shared/empty-layers";
import type { LayerRecord } from "../shared/layer-layout";
import { redundantStructureOutlines } from "../shared/layer-structure";
import type { UiNode } from "../shared/types";
import { buildBaseScenePlanes, buildSceneFraming, buildSceneHighlights, buildSceneLayout, buildScenePresentation, overflowSceneSelection,
  type BaseScenePlaneOptions, type ResolvedSceneVisual, type SceneLayoutOptions } from "../src/features/layers/scene-model";

const size = { width: 100, height: 100 };
function node(id: string, left = 0, top = 0, right = 100, bottom = 100): UiNode {
  return { ...makeNode(id), text: null, contentDesc: null, children: [],
    bounds: { left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` } };
}
function layoutOptions(root: UiNode, overrides: Partial<SceneLayoutOptions> = {}): SceneLayoutOptions {
  return { root, size, expandedNodeIds: new Set([root.id]), layoutHiddenIds: new Set(), focusedNode: null, focusKind: "layer",
    layerGap: 64, showInvisible: false, showOffscreen: false, structureMode: "regular", ...overrides };
}
function planeOptions(records: readonly LayerRecord[], overrides: Partial<BaseScenePlaneOptions> = {}): BaseScenePlaneOptions {
  return { parent: null, records, parentRole: null, roles: new Map(), visuals: new Map(), groupNodeIds: new Set(), size,
    renderScale: 2, renderOrigin: { left: 100, top: 200 }, suppressedOutlines: new Set(), showOffscreen: false, ...overrides };
}
function nativeFixture() {
  const root = node("root"), painted = node("painted", 10, 20, 80, 90);
  painted.layerImageDataUrl = "native-image";
  painted.layerImageSize = { width: 140, height: 140 };
  painted.layerCapturePlacement = { screen: { left: -10, top: 30, width: 60, height: 50 },
    source: { left: 4, top: 6, width: 120, height: 100 }, opacity: 0.4, hidden: false };
  root.children = [painted];
  const record = buildSceneLayout(layoutOptions(root)).records[0];
  const visual: ResolvedSceneVisual = { kind: "native", textureSrc: "resolved-native-key", textureSize: painted.layerImageSize,
    source: { left: 0, top: 0, width: 140, height: 140 } };
  const options = planeOptions([record], { roles: new Map([[record.id, "surface"]]), visuals: new Map([[record.id, visual]]) });
  return { root, painted, record, visual, options };
}

test("scene layout applies the default empty filter before packing in both structure modes", () => {
  const root = { ...node("root"), layerImageEmpty: true }, wrapper = { ...node("wrapper"), layerImageEmpty: true };
  const painted = { ...node("painted"), layerImageDataUrl: "pixels", layerImageSize: size };
  wrapper.children = [painted]; root.children = [wrapper];
  const expandedNodeIds = new Set([root.id, wrapper.id]), before = JSON.stringify(root);
  const layoutHiddenIds = emptyLayerIds(root, expandedNodeIds);
  for (const structureMode of ["regular", "complete"] as const) {
    const layout = buildSceneLayout(layoutOptions(root, { expandedNodeIds, layoutHiddenIds, structureMode }));
    assert.equal(layout.parent, null);
    assert.deepEqual(layout.records.map(record => [record.id, record.z]), [[painted.id, 0]]);
    assert.equal(layout.records[0].node, painted);
    assert.equal(layout.truncated, false);
  }
  assert.equal(JSON.stringify(root), before);
});

test("complete structure keeps empty layout levels and regular mode keeps its compact contours", () => {
  const root = { ...node("root"), layerImageEmpty: true }, wrapper = { ...node("wrapper"), layerImageEmpty: true };
  const painted = { ...node("painted"), layerImageDataUrl: "pixels", layerImageSize: size };
  root.children = [wrapper]; wrapper.children = [painted];
  const expandedNodeIds = new Set([root.id, wrapper.id]);
  const regular = buildSceneLayout(layoutOptions(root, { expandedNodeIds }));
  const complete = buildSceneLayout(layoutOptions(root, { expandedNodeIds, structureMode: "complete" }));
  assert.equal(regular.records[0].isCompact, true);
  assert.equal(complete.records[0].isCompact, false);
  assert.equal(regular.parent?.z, -64);
  assert.equal(complete.parent?.z, -128);
  assert.deepEqual(complete.records.map(record => [record.id, record.z]), [[wrapper.id, -64], [painted.id, 0]]);
  const regularPlanes = buildBaseScenePlanes(planeOptions(regular.records, { parent: regular.parent, parentRole: "outline",
    suppressedOutlines: redundantStructureOutlines([regular.parent!, ...regular.records]) }));
  assert.equal(regularPlanes[0].outlinePolicy, "none");
  assert.equal(regularPlanes[1].opacity, 0.42);
  const completePlanes = buildBaseScenePlanes(planeOptions(complete.records, { parent: complete.parent, parentRole: "outline" }));
  assert.equal(completePlanes[0].outlinePolicy, "normal");
  assert.equal(completePlanes[0].opacity, 0.65);
  assert.equal(completePlanes[1].opacity, 0.78);
});

test("overview and branch caps retain an out-of-range selection while ordinary selection reuses geometry", () => {
  const root = node("root");
  root.children = Array.from({ length: 520 }, (_, index) => ({ ...node(`child-${index}`, 0, 0, 10, 10), index }));
  const selected = root.children[519], options = layoutOptions(root);
  const overview = buildSceneLayout(options);
  assert.equal(overview.records.length, 512);
  assert.equal(overview.omittedCount, 8);
  assert.equal(overflowSceneSelection(overview, root), null);
  assert.equal(overflowSceneSelection(overview, root.children[0]), null);
  assert.equal(overflowSceneSelection(overview, selected), selected);
  const selectedOverview = buildSceneLayout(options, overflowSceneSelection(overview, selected));
  assert.equal(selectedOverview.records.length, 512);
  assert.equal(selectedOverview.records.at(-1)?.node, selected);
  assert.equal(overview.records.some(record => record.node === selected), false);
  const branchOptions = { ...options, focusedNode: root, focusKind: "branch" as const };
  const branch = buildSceneLayout(branchOptions, selected);
  assert.equal(branch.parent, null);
  assert.equal(branch.parentId, null);
  assert.equal(branch.records.length, 512);
  assert.equal(branch.records[0].node, root);
  assert.equal(branch.records[0].hitTestable, true);
  assert.equal(branch.records.at(-1)?.node, selected);
  assert.equal(branch.candidateCount, 521);
  assert.equal(branch.omittedCount, 9);
});

test("single focus ignores other selection and folding while retaining the source node identity", () => {
  const root = node("root"), focused = node("focused"), child = node("child");
  focused.children = [child]; root.children = [focused];
  const before = JSON.stringify(root), options = layoutOptions(root, { focusedNode: focused });
  const single = buildSceneLayout(options, child);
  assert.equal(single.parent, null);
  assert.equal(single.records.length, 1);
  assert.equal(single.records[0].node, focused);
  assert.equal(single.records[0].isSelected, false);
  assert.equal(single.records[0].isCollapsed, true);
  assert.equal(single.records[0].z, 0);
  assert.equal(buildSceneLayout({ ...options, layoutHiddenIds: new Set([focused.id]) }).records.length, 0);
  assert.equal(JSON.stringify(root), before);
});

test("branch and single focus inherit invisible ancestors and retain diagnostic bounds", () => {
  const root = { ...node("root"), visibleToUser: false }, focused = node("focused", 10, 10, 80, 80), child = node("child", 20, 20, 40, 40);
  focused.children = [child]; root.children = [focused];
  for (const focusKind of ["branch", "layer"] as const) {
    const options = layoutOptions(root, { focusedNode: focused, focusKind, expandedNodeIds: new Set([root.id, focused.id]) });
    assert.equal(buildSceneLayout(options).records.length, 0);
    const visible = buildSceneLayout({ ...options, showInvisible: true });
    assert.equal(visible.records.length, focusKind === "branch" ? 2 : 1);
    for (const record of visible.records) assert.equal(record.isDeviceInvisible, true);
    const planes = buildBaseScenePlanes(planeOptions(visible.records));
    assert.equal(planes[0].node, focused);
    assert.equal(planes[0].kind, "invisible");
    assert.equal(planes[0].hitPolicy, "edge");
    assert.deepEqual(planes[0].rect, { left: 120, top: 220, width: 140, height: 140 });
  }
});

test("framing fits a focused offscreen branch without changing screen framing", () => {
  const root = node("root"), focused = node("offscreen", 120, 20, 200, 80); root.children = [focused];
  const options = layoutOptions(root, { showOffscreen: true });
  const framingOptions = { size, focusedNode: null, framingScope: "screen" as const, origin: { left: 10, top: 20 }, renderScale: 2 };
  const screen = buildSceneFraming(buildSceneLayout(options), framingOptions);
  assert.deepEqual(screen.center, { x: 50, y: 50, z: -64 });
  assert.equal(screen.frames.length, 1);
  const branch = buildSceneLayout({ ...options, focusedNode: focused, focusKind: "branch" });
  const focus = buildSceneFraming(branch, { ...framingOptions, focusedNode: focused });
  assert.deepEqual({ ...focus.center, z: Math.abs(focus.center.z) }, { x: 160, y: 50, z: 0 });
  assert.deepEqual(focus.renderOrigin, { left: -210, top: 20 });
  assert.deepEqual({ ...focus.pivot, z: Math.abs(focus.pivot.z) }, { x: 110, y: 120, z: 0 });
});

test("capture placement clips pixels and source coordinates but retains real layout and resolved texture", () => {
  const { root, painted, options, visual } = nativeFixture(), before = JSON.stringify(root);
  const planes = buildBaseScenePlanes(options), plane = planes[0];
  assert.equal(plane.node, painted);
  assert.equal(plane.kind, "native");
  assert.equal(plane.textureSrc, visual.textureSrc);
  assert.equal(plane.textureSize, visual.textureSize);
  assert.deepEqual(plane.layoutRect, { left: 120, top: 240, width: 140, height: 140 });
  assert.deepEqual(plane.rect, { left: 100, top: 260, width: 100, height: 100 });
  assert.deepEqual(plane.source, { left: 24, top: 6, width: 100, height: 100 });
  assert.deepEqual(plane.quickSelect?.screen, { left: 10, top: 20, width: 70, height: 70 });
  assert.equal(plane.opacity, 0.4);
  assert.equal(plane.outlineOpacity, 1);
  assert.equal(plane.hitPolicy, "content");
  assert.equal(JSON.stringify(root), before);
  assert.deepEqual(buildBaseScenePlanes(options), planes);
});

test("offscreen inspection restores full layout pixels and keeps capture opacity", () => {
  const { painted, options, visual } = nativeFixture();
  painted.layerCapturePlacement!.hidden = true;
  assert.deepEqual(buildBaseScenePlanes(options), []);
  const full = buildBaseScenePlanes({ ...options, showOffscreen: true })[0];
  assert.deepEqual(full.rect, full.layoutRect);
  assert.equal(full.source, visual.source);
  assert.equal(full.opacity, 0.4);
  painted.layerCapturePlacement!.hidden = false;
  painted.layerCapturePlacement!.screen.left = 120;
  assert.deepEqual(buildBaseScenePlanes(options), []);
});

test("folded composites use group opacity only when group pixels were resolved", () => {
  const { painted, record, options, visual } = nativeFixture();
  painted.attributes = { "effective-alpha": "0.25" };
  const collapsed = { ...record, isCollapsed: true };
  const composite: ResolvedSceneVisual = { ...visual, kind: "composite", textureSrc: "resolved-composite-key" };
  const compositeOptions = { ...options, records: [collapsed], visuals: new Map([[record.id, composite]]) };
  const local = buildBaseScenePlanes(compositeOptions)[0];
  const grouped = buildBaseScenePlanes({ ...compositeOptions, groupNodeIds: new Set([record.id]) })[0];
  assert.equal(local.opacity, 1);
  assert.equal(grouped.opacity, 0.25);
  assert.equal(grouped.kind, "composite");
  assert.equal(grouped.textureSrc, composite.textureSrc);
  assert.deepEqual(grouped.rect, grouped.layoutRect);
  assert.equal(grouped.source, composite.source);
  assert.equal(grouped.quickSelect?.collapsed, true);
});

test("selection and hover reuse base geometry and highlight layout instead of capture pixels", () => {
  const { record, options } = nativeFixture();
  const base = buildBaseScenePlanes(options), before = JSON.stringify(base);
  const selected = buildSceneHighlights(base, { selectedRecord: record, hoveredRecord: record, selectedNodeId: record.id });
  assert.equal(selected.length, 2);
  assert.equal(selected[0], base[0]);
  assert.equal(selected[1].id, `${record.id}:selection`);
  assert.equal(selected[1].rect, base[0].layoutRect);
  assert.equal(selected[1].textureSrc, null);
  assert.equal(selected[1].node, null);
  assert.equal(selected[1].hitTestable, false);
  assert.equal(selected[1].hitPolicy, "none");
  assert.equal(selected[1].opacity, 1);
  const hovered = buildSceneHighlights(base, { selectedRecord: null, hoveredRecord: record, selectedNodeId: null });
  assert.equal(hovered[0], base[0]);
  assert.equal(hovered[1].id, `${record.id}:hover`);
  assert.equal(hovered[1].z, base[0].z);
  assert.equal(JSON.stringify(base), before);
  assert.equal(record.isSelected, false);
});

test("parent highlighting and presentation preserve node depth identity across suffixes", () => {
  const { record, options } = nativeFixture(), parent = { ...record, z: -64 };
  const base = buildBaseScenePlanes({ ...options, records: [], parent, parentRole: "surface" });
  assert.equal(base[0].id, `${record.id}:parent`);
  const planes = buildSceneHighlights(base, { selectedRecord: parent, hoveredRecord: null, selectedNodeId: parent.id });
  const center = { x: 50, y: 50, z: -64 }, pivot = { x: 200, y: 300, z: -128 };
  const presentation = buildScenePresentation(planes, { center, pivot, renderScale: 2 });
  assert.deepEqual([...presentation.depths], [[parent.id, -64]]);
  assert.equal(presentation.center, center);
  assert.equal(presentation.pivot, pivot);
  assert.equal(presentation.scale, 2);
  assert.equal(planes[0], base[0]);
  assert.equal(planes[1].rect, base[0].layoutRect);
});
