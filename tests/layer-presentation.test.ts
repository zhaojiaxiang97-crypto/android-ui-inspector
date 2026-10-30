import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { buildLayerOverview, type LayerRecord } from "../shared/layer-layout";
import { redundantStructureOutlines } from "../shared/layer-structure";
import { layerOutlinePolicy, outlineIsVisible, prepareScenePlanes } from "../src/features/layers/scene-planes";
import { cameraRotation, pickProjectedPlane, projectPlane } from "../src/features/layers/projection";
import type { LayerCamera, ProjectedPlane, ScenePlane } from "../src/features/layers/types";

const rect = { left: 10, top: 20, width: 100, height: 80 }, size = { width: 100, height: 80 };
const camera: LayerCamera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
const pivot = { x: 0, y: 0, z: 0 };
const plane = (id = "image"): ScenePlane => ({ id, node: makeNode(id), rect, layoutRect: rect,
  source: { left: 0, top: 0, ...size }, textureSize: size, textureSrc: "pixels", kind: "native", z: 0,
  opacity: 1, hitTestable: true, outlinePolicy: "normal", hitPolicy: "content" });
const textures = new Map([["pixels", {}]]);
const alpha = new Map([["pixels", { left: .2, top: .25, width: .6, height: .5 }]]);
function project(p: ScenePlane, visible = true): ProjectedPlane {
  const projected = projectPlane(p, pivot, camera, cameraRotation(camera));
  return { node: p.node!, ...projected, painted: { plane: p, visible, kind: p.kind, camera, pivot,
    cornerDepths: projected.corners.map(point => point.depth) } };
}

test("alpha margins trim content and mapping without generating a second layout border", () => {
  const original = plane(); original.quickSelect = { collapsed: true, screen: { left: 300, top: 400, width: 200, height: 160 } };
  const before = JSON.stringify(original), result = prepareScenePlanes([original], alpha, textures);
  assert.equal(result.filter(p => p.kind === "outline").length, 1);
  const [content, border] = result;
  assert.deepEqual(content.rect, { left: 30, top: 40, width: 60, height: 40 });
  assert.deepEqual(content.quickSelect?.screen, { left: 340, top: 440, width: 120, height: 80 });
  assert.deepEqual(border.rect, rect);
  assert.equal(border.node, original.node);
  assert.equal(border.hitPolicy, "edge");
  assert.equal(JSON.stringify(original), before);
  const empty = prepareScenePlanes([original], new Map([["pixels", null]]), textures);
  assert.deepEqual(empty.map(p => p.kind), ["outline"]);
});

test("placement and selection keep the original layout, including wireframe and transparent images", () => {
  const original = { ...plane(), rect: { left: 20, top: 30, width: 50, height: 40 } };
  const selection: ScenePlane = { ...original, id: "image:selection", node: null, kind: "selection", hitTestable: false };
  for (const mode of ["images", "wireframe"] as const) {
    const result = prepareScenePlanes([original, selection], alpha, textures, mode);
    assert.deepEqual(result.find(p => p.kind === "selection")?.rect, rect);
    assert.equal(result.find(p => p.kind === "selection")?.textureSrc, null);
    assert.equal(result.find(p => p.kind === "outline")?.highlighted, true);
    assert.deepEqual(result.find(p => p.kind === "outline")?.rect, rect);
  }
});

test("real content wins over container edges and blank interiors; hidden strokes do not intercept", () => {
  const image = plane("back"), front = { ...plane("front"), kind: "outline" as const, textureSrc: null, hitPolicy: "edge" as const };
  assert.equal(pickProjectedPlane({ x: 50, y: 50 }, [project(front), project(image)])?.node, image.node);
  assert.equal(pickProjectedPlane({ x: 10, y: 50 }, [project(front), project(image)])?.node, image.node);
  assert.equal(pickProjectedPlane({ x: 50, y: 50 }, [project(front)]), undefined);
  assert.equal(pickProjectedPlane({ x: 10, y: 50 }, [project(front, false)]), undefined);
  assert.equal(pickProjectedPlane({ x: 10, y: 50 }, [project(front)])?.node, front.node);
  // Without confirmed alpha data, retain the front painted rectangle.
  assert.equal(pickProjectedPlane({ x: 50, y: 50 }, [project(plane("front-content")), project(image)])?.node.id, "front-content");
});

function chain() {
  const root = makeNode("root"), a = makeNode("a"), b = makeNode("b"), c = makeNode("c");
  root.children = [a]; a.children = [b]; b.children = [c];
  for (const node of [root, a, b, c]) { node.bounds = { left: 0, top: 0, right: 100, bottom: 100, raw: "same" }; node.attributes = { "skip-draw": "true" }; }
  const layout = buildLayerOverview(root, root, { width: 100, height: 100 });
  return { root, a, b, c, records: [layout.parent!, ...layout.records] };
}

test("empty and structural states obey the outline switch, failures and missing folded images stay locatable", () => {
  const { records } = chain(), record = records[1];
  assert.equal(layerOutlinePolicy(record, false), "normal");
  record.node.layerImageEmpty = true;
  assert.equal(layerOutlinePolicy(record, false), "normal");
  for (const layerImageStatus of ["failed", "ambiguous"] as const) {
    record.node.layerImageStatus = layerImageStatus;
    assert.equal(layerOutlinePolicy(record, false), "required");
  }
  record.node.layerImageStatus = "captured";
  assert.equal(layerOutlinePolicy({ ...record, isCollapsed: true }, false), "required");
  assert.equal(layerOutlinePolicy({ ...record, isCollapsed: true }, true), "normal");
  assert.equal(outlineIsVisible({ ...plane(), outlinePolicy: "normal" }, false), false);
  assert.equal(outlineIsVisible({ ...plane(), outlinePolicy: "required" }, false), true);
  assert.equal(prepareScenePlanes([plane()], new Map(), new Map())[0].outlinePolicy, "required");
});

test("only same-range continuous structural ancestors lose duplicate strokes, never nodes or depths", () => {
  const { records } = chain(), before = JSON.stringify(records);
  assert.deepEqual([...redundantStructureOutlines(records)], ["root", "a", "b"]);
  assert.equal(JSON.stringify(records), before);
  for (const edit of [
    (r: LayerRecord) => { r.isCollapsed = true; },
    (r: LayerRecord) => { r.node.layerImageStatus = "failed"; },
    (r: LayerRecord) => { r.node.layerImageStatus = "ambiguous"; },
    (r: LayerRecord) => { r.node.attributes = {}; },
    (r: LayerRecord) => { r.node.layerImageDataUrl = "real"; r.node.layerImageSize = size; },
    (r: LayerRecord) => { r.node.attributes!['background-color'] = '#ff0000'; },
    (r: LayerRecord) => { r.node.attributes!['clip-children'] = 'true'; },
    (r: LayerRecord) => { r.node.attributes!['alpha'] = '.5'; },
    (r: LayerRecord) => { r.sourceBounds = { ...r.sourceBounds, left: -10 }; },
    (r: LayerRecord) => { r.node.layerCapturePlacement = { screen: rect, source: rect, opacity: 1, hidden: false }; },
  ]) {
    const current = chain().records; edit(current[2]);
    const hidden = redundantStructureOutlines(current);
    assert(!hidden.has("a") && !hidden.has("b"));
  }
  const sibling = chain(); sibling.a.children = [sibling.b, sibling.c]; sibling.records[3].parentId = "a";
  assert(!redundantStructureOutlines(sibling.records).has("a"));
  assert(!redundantStructureOutlines(sibling.records).has("b"));
});

test("layout borders remain readable independently of captured image alpha", () => {
  const original = {...plane(), opacity:.25, outlineOpacity:1};
  const before = JSON.stringify(original);
  const result = prepareScenePlanes([original], alpha, textures);
  assert.equal(result.find(p => p.kind === 'native')?.opacity, .25);
  assert.equal(result.find(p => p.kind === 'outline')?.opacity, 1);
  assert.equal(JSON.stringify(original), before);
});
