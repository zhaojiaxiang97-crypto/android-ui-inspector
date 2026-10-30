import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { alphaMaskContains, createAlphaMask, scanAlphaSlice, type TextureAlphaMask } from "../src/features/layers/texture-alpha";
import { cameraRotation, paintedPixelAt, pickProjectedPlane, projectPlane, projectPoint } from "../src/features/layers/projection";
import { findPositionCandidates } from "../src/features/layers/position-select";
import { prepareScenePlanes } from "../src/features/layers/scene-planes";
import type { LayerCamera, ProjectedPlane, ScenePlane } from "../src/features/layers/types";

const camera: LayerCamera = { distance: 1100, azimuth: 31, elevation: -17, roll: 12, layerGap: 64, panX: 0, panY: 0 };
const pivot = { x: 150, y: 130, z: 0 };
function alpha(width: number, height: number, pixel: (x: number, y: number) => number) {
  const mask = createAlphaMask(width, height), pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[(y * width + x) * 4 + 3] = pixel(x, y);
  return { mask, rect: scanAlphaSlice(pixels, mask, 0, height) };
}
function plane(id: string): ScenePlane {
  const node = makeNode(id); node.text = id;
  return { id, node, rect: { left: 50, top: 30, width: 200, height: 200 }, source: { left: 0, top: 0, width: 100, height: 100 },
    textureSize: { width: 100, height: 100 }, textureSrc: id, kind: "native", z: 0, opacity: 1, hitTestable: true, hitPolicy: "content", outlinePolicy: "normal" };
}
function projected(p: ScenePlane, mask?: TextureAlphaMask, visible = true): ProjectedPlane {
  const result = projectPlane(p, pivot, camera, cameraRotation(camera));
  return { ...result, node: p.node!, painted: { plane: p, camera, pivot, kind: p.kind, visible, cornerDepths: result.corners.map(c => c.depth), alphaMask: mask } };
}
const point = (x: number, y: number) => projectPoint(x, y, 0, pivot, camera, cameraRotation(camera));

test("opaque corners do not conceal an interior hole; semi-transparent pixels still pick", () => {
  const front = plane("front"), back = plane("back");
  const ring = alpha(100, 100, (x, y) => x < 10 || y < 10 || x >= 90 || y >= 90 ? 255 : 0);
  assert.deepEqual(ring.rect, { left: 0, top: 0, width: 1, height: 1 });
  assert.equal(pickProjectedPlane(point(150, 130), [projected(front, ring.mask), projected(back)])?.node, back.node);
  assert.equal(pickProjectedPlane(point(60, 130), [projected(front, ring.mask), projected(back)])?.node, front.node);
  const translucent = alpha(100, 100, () => 1);
  assert.equal(pickProjectedPlane(point(150, 130), [projected(front, translucent.mask), projected(back)])?.node, front.node);
});

test("cropped source mapping remains correct after perspective and texture downsampling", () => {
  const p = plane("cropped"); p.source = { left: 20, top: 10, width: 60, height: 80 };
  const mask = alpha(50, 50, (x, y) => x >= 34 && x <= 38 && y >= 24 && y <= 26 ? 255 : 0).mask;
  const hit = point(50 + (72 - 20) / 60 * 200, 30 + (50 - 10) / 80 * 200);
  assert.equal(paintedPixelAt(projected(p, mask), hit), true);
  assert.equal(paintedPixelAt(projected(p, mask), point(150, 130)), false);
});

test("bit mask matches linear filtering for thin strokes and joins slices without losing pixels", () => {
  const mask = createAlphaMask(4, 4), first = new Uint8ClampedArray(32), second = new Uint8ClampedArray(32);
  first[3] = 255; second[(1 * 4 + 2) * 4 + 3] = 1;
  assert.deepEqual(scanAlphaSlice(first, mask, 0, 2), { left: 0, top: 0, width: .25, height: .25 });
  assert.deepEqual(scanAlphaSlice(second, mask, 2, 2), { left: .5, top: .75, width: .25, height: .25 });
  assert.equal(mask.bits.byteLength, 2);
  assert.equal(alphaMaskContains(mask, 0, 0), true);
  assert.equal(alphaMaskContains(mask, .25, .125), true);
  assert.equal(alphaMaskContains(mask, .375, .125), false);
  assert.equal(alphaMaskContains(mask, .625, .875), true);
  assert.equal(alphaMaskContains(mask, 1.01, .875), false);
});

test("pending/read-failed capture is not labelled empty; confirmed empty image is quiet", () => {
  const p = plane("pending"), contents = new Map([[p.id, null]]), textures = new Map([[p.id, {}]]);
  assert.equal(Boolean(prepareScenePlanes([p], contents, textures)[0].quietStructure), false);
  assert.equal(prepareScenePlanes([p], contents, textures, "images", new Map([[p.id, createAlphaMask(100, 100)]]))[0].quietStructure, true);
  const failed = prepareScenePlanes([p], new Map(), textures);
  assert.equal(failed[0].hitPolicy, "content");
  assert.equal(pickProjectedPlane(point(150, 130), [projected(failed[0]), projected(plane("back"))])?.node, p.node);
});

test("position list ranks visible pixels first and retains transparent, quiet and unknown layers", () => {
  const root = makeNode("root"); root.text = "页面";
  const back = plane("back"), front = plane("front"), container = plane("container"), unknown = plane("unknown");
  container.kind = "outline"; container.hitPolicy = "edge"; container.quietStructure = true; container.textureSrc = null;
  root.children = [back.node!, front.node!, container.node!, unknown.node!];
  const before = JSON.stringify(root), context = {};
  const ring = alpha(100, 100, (x, y) => x < 10 || y < 10 ? 255 : 0).mask;
  const planes = [projected(container, undefined, false), projected(front, ring), projected(unknown), projected(back, alpha(100, 100, () => 255).mask)];
  const duplicate = { ...planes[1], painted: { ...planes[1].painted!, plane: { ...front, hitPolicy: "edge" as const } } };
  const result = findPositionCandidates(context, root, point(150, 130), [duplicate, ...planes]);
  assert.equal(result.scope, "position");
  assert.deepEqual(result.candidates.map(c => [c.node.id, c.kind]), [["back", "painted"], ["unknown", "unconfirmed"], ["front", "transparent"], ["container", "structure"]]);
  assert.equal(result.candidates[3].path, "页面 › container");
  assert.equal(JSON.stringify(root), before);
  assert.equal(findPositionCandidates(context, root, point(150, 130), [projected(plane("absent"))]).total, 0);
});

test("wireframe remains edge-only regardless of alpha mask", () => {
  const p = plane("wireframe"), edge = prepareScenePlanes([p], new Map(), new Map(), "wireframe")[0];
  assert.equal(pickProjectedPlane(point(150, 130), [projected(edge, createAlphaMask(100, 100))]), undefined);
  assert.equal(pickProjectedPlane(point(50, 130), [projected(edge, createAlphaMask(100, 100))])?.node, p.node);
});
