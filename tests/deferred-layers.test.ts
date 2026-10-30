import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { deferredLayerIds, hasAvailableLayerImages, hasDeferredLayerImages } from "../shared/deferred-layers";
import { emptyLayerIds } from "../shared/empty-layers";
import { nodePresentationStatus } from "../shared/node-presentation-status";
import type { UiNode } from "../shared/types";
import { buildBaseScenePlanes, buildSceneFraming, buildSceneLayout, deferredGroupCandidates, type SceneLayoutOptions } from "../src/features/layers/scene-model";
import { hasOwnVisualStyle } from "../src/features/layers/presentation";
import { layerOutlinePolicy, prepareScenePlanes } from "../src/features/layers/scene-planes";

const size = { width: 100, height: 100 };
function node(id: string, patch: Partial<UiNode> = {}): UiNode {
  return { ...makeNode(id), text: id, children: [], attributes: {}, layerImageStatus: "deferred",
    bounds: { left: 0, top: 0, right: 100, bottom: 100, raw: "" }, ...patch };
}
function options(root: UiNode, expandedNodeIds: ReadonlySet<string> = new Set([root.id]), overrides: Partial<SceneLayoutOptions> = {}): SceneLayoutOptions {
  return { root, size, expandedNodeIds, layoutHiddenIds: deferredLayerIds(root, expandedNodeIds), focusedNode: null,
    focusKind: "branch", layerGap: 64, showInvisible: false, showOffscreen: false, structureMode: "regular", ...overrides };
}
const pixels = { layerImageDataUrl: "pixels", layerImageSize: size, layerImageStatus: "captured" as const };

test("pending capture remains distinct from empty and terminal missing-image facts", () => {
  const pending = node("pending"), before = JSON.stringify(pending);
  assert.equal(nodePresentationStatus(pending).ownImage.code, "deferred");
  assert.equal(pending.layerImageEmpty, undefined);
  assert.equal(emptyLayerIds(pending, new Set()).size, 0);
  assert.equal(hasDeferredLayerImages(pending), true);
  assert.equal(hasAvailableLayerImages(pending), false);
  for (const layerImageStatus of ["failed", "ambiguous", "unavailable", undefined] as const)
    assert.equal(deferredLayerIds(node("diagnostic", { layerImageStatus }), new Set()).size, 0);
  assert.equal(JSON.stringify(pending), before);
});

test("pending wrappers never consume depth, framing, cap or selectable planes", () => {
  const painted = node("painted", { ...pixels, bounds: { left: 30, top: 30, right: 60, bottom: 60, raw: "" } });
  const wrappers = Array.from({ length: 600 }, (_, index) => node(`pending-${index}`));
  const root = node("root", { children: [...wrappers, painted] });
  const settings = options(root), layout = buildSceneLayout(settings, wrappers[0]);
  assert.equal(layout.parent, null);
  assert.deepEqual(layout.records.map(record => [record.id, record.z]), [[painted.id, 0]]);
  assert.equal(layout.candidateCount, 1); assert.equal(layout.truncated, false);
  const framed = buildSceneFraming(layout, { size, focusedNode: null, framingScope: "all", origin: { left: 0, top: 0 }, renderScale: 1 });
  assert.deepEqual(framed.frames, [{ bounds: { left: 30, top: 30, right: 60, bottom: 60 }, z: 0 }]);
  const planes = buildBaseScenePlanes({ parent: layout.parent, records: layout.records, parentRole: null,
    roles: new Map(), visuals: new Map(), groupNodeIds: new Set(), size, renderScale: 1,
    renderOrigin: { left: 0, top: 0 }, suppressedOutlines: new Set(), showOffscreen: false });
  assert.deepEqual(prepareScenePlanes(planes, new Map(), new Map()).filter(plane => plane.hitTestable).map(plane => plane.node?.id), [painted.id]);
  const complete = buildSceneLayout(options(root, settings.expandedNodeIds, { layoutHiddenIds: new Set(), structureMode: "complete" }));
  assert.equal(complete.records.length, 512); assert.equal(complete.truncated, true);
  assert.ok(complete.records.some(record => record.node === wrappers[0]));
});

test("expanded pending parents keep captured children and pending single focus stays empty", () => {
  const painted = node("painted", pixels), wrapper = node("wrapper", { children: [painted] }), root = node("root", { children: [wrapper] });
  const expanded = new Set([root.id, wrapper.id]), before = JSON.stringify(root);
  const layout = buildSceneLayout(options(root, expanded));
  assert.equal(layout.parent, null); assert.deepEqual(layout.records.map(record => record.id), [painted.id]);
  const focused = buildSceneLayout(options(root, expanded, { focusedNode: wrapper, focusKind: "layer" }));
  assert.equal(focused.records.length, 0);
  const branch = buildSceneLayout(options(root, expanded, { focusedNode: wrapper }));
  assert.deepEqual(branch.records.map(record => record.id), [painted.id]);
  assert.equal(JSON.stringify(root), before);
});

test("folded pending branches retain actual descendant pixels, valid own groups and terminal diagnostics", () => {
  const child = node("child"), root = node("root", { children: [child] }), folded = new Set<string>();
  assert.equal(deferredLayerIds(root, folded).has(root.id), true);
  for (const childState of [pixels, { layerImageStatus: "failed" as const }, { layerImageStatus: "ambiguous" as const },
    { layerImageStatus: "unavailable" as const }, { layerImageStatus: undefined }]) {
    root.children = [node("child", childState)];
    assert.equal(deferredLayerIds(root, folded).has(root.id), false);
  }
  root.children = [child];
  assert.equal(deferredLayerIds(root, folded, new Set([root.id])).has(root.id), false);
  assert.equal(deferredLayerIds(root, new Set([root.id]), new Set([root.id])).has(root.id), true);
  assert.equal(deferredLayerIds(root, folded, new Set([child.id])).has(root.id), true,
    "a saved child group is not part of a parent's local composite");
  assert.equal(deferredLayerIds(root, folded, new Set([root.id]), new Set([child.id])).has(root.id), true);
  root.children = [node("child", { ...pixels, visibleToUser: false })];
  assert.equal(deferredLayerIds(root, folded).has(root.id), true);
  assert.equal(hasAvailableLayerImages(root), false);
  assert.equal(hasAvailableLayerImages(root, new Set([root.id]), new Set([root.children[0].id])), false);
});

test("empty folded wrappers around pending children do not become phantom visible layers", () => {
  const pending = node("pending"), empty = node("empty", { layerImageStatus: "captured", layerImageEmpty: true, children: [pending] });
  assert.equal(emptyLayerIds(empty, new Set()).has(empty.id), false);
  assert.equal(deferredLayerIds(empty, new Set()).has(empty.id), true);
  assert.equal(nodePresentationStatus(empty).ownImage.code, "empty");
  empty.children = [node("captured", pixels)];
  assert.equal(deferredLayerIds(empty, new Set()).has(empty.id), false);
  assert.equal(hasAvailableLayerImages(empty), true);
});

test("device-invisible captured pixels cannot unlock an otherwise empty pending scene", () => {
  const invisible = node("invisible", { ...pixels, attributes: { "effective-alpha": "0" } });
  const root = node("root", { children: [invisible, node("pending")] });
  assert.equal(hasDeferredLayerImages(root), true);
  assert.equal(hasAvailableLayerImages(root), false);
  assert.equal(hasAvailableLayerImages(root, new Set([invisible.id])), false);
  assert.deepEqual(buildSceneLayout(options(root)).records, []);
  invisible.children = [node("child", pixels)];
  assert.equal(hasAvailableLayerImages(root), false, "invisible ancestors hide descendant pixels");
  invisible.attributes = {};
  invisible.layerCapturePlacement = { hidden: true, opacity: 1, screen: { left: 0, top: 0, ...size }, source: { left: 0, top: 0, ...size } };
  assert.equal(hasAvailableLayerImages(root), false);
  assert.equal(hasAvailableLayerImages(root, new Set(), new Set(), true), true);
  invisible.layerCapturePlacement.opacity = 0;
  assert.equal(hasAvailableLayerImages(root, new Set(), new Set(), true), false);
});

test("complete structure exposes pending geometry without claiming screenshot pixels or failure", () => {
  const pending = node("pending", { clickable: true, className: "android.widget.Button" }), root = node("root", { children: [pending] });
  const layout = buildSceneLayout(options(root, new Set([root.id]), { layoutHiddenIds: new Set(), structureMode: "complete" }));
  const record = layout.records[0];
  assert.equal(hasOwnVisualStyle(record, size, new Set(), new Map()), false);
  assert.equal(layerOutlinePolicy(record, false), "normal");
  pending.children = [node("failed", { layerImageStatus: "failed" })];
  assert.equal(layerOutlinePolicy({ ...record, isCollapsed: true }, false), "required");
  pending.children = [node("pending-child")];
  assert.equal(layerOutlinePolicy({ ...record, isCollapsed: true }, false), "normal");
  Object.assign(pending, pixels);
  const loaded = buildSceneLayout(options(root));
  assert.equal(loaded.records[0].node, pending);
  assert.equal(hasAvailableLayerImages(root), true);
});

test("pending group candidates obey folding, focus, visibility and manual hiding independently of planes", () => {
  const folded = node("folded", { children: [node("child")] }), outside = node("outside", { children: [node("off-child")],
    bounds: { left: 200, top: 0, right: 300, bottom: 100, raw: "" } });
  const root = node("root", { attributes: { "tree-source": "debug-sdk" }, children: [folded, outside] });
  const settings = options(root), pending = deferredLayerIds(root, settings.expandedNodeIds);
  assert.equal(buildSceneLayout(settings).records.length, 0);
  assert.deepEqual(deferredGroupCandidates(settings, pending, new Set()).map(item => item.id), [folded.id]);
  assert.deepEqual(deferredGroupCandidates(settings, pending, new Set(["child"])), []);
  assert.deepEqual(deferredGroupCandidates({ ...settings, focusedNode: outside, showOffscreen: true }, pending, new Set()).map(item => item.id), [outside.id]);
  folded.visibleToUser = false;
  assert.deepEqual(deferredGroupCandidates(settings, pending, new Set()), []);
});

test("group demand keeps a selected pending branch beyond its working-set cap", () => {
  const children = Array.from({ length: 520 }, (_, index) => node(`fold-${index}`, { children: [node(`child-${index}`)] }));
  const root = node("root", { attributes: { "tree-source": "debug-sdk" }, children });
  const settings = options(root), pending = deferredLayerIds(root, settings.expandedNodeIds), selected = children.at(-1)!;
  const candidates = deferredGroupCandidates(settings, pending, new Set(), selected.id);
  assert.equal(candidates.length, 512);
  assert.equal(candidates.at(-1), selected);
  assert.equal(buildSceneLayout(settings, selected).records.length, 0);
});
