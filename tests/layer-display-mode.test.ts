import assert from "node:assert/strict";
import { test } from "node:test";
import { pointHitsProjectedPlane, projectPlane, cameraRotation } from "../src/features/layers/projection";
import { DEFAULT_LAYER_APPEARANCE, parseLayerAppearance } from "../src/features/layers/appearance";
import type { LayerCamera, ProjectedPlane, ScenePlane } from "../src/features/layers/types";
import { makeNode } from "../benchmarks/fixtures";

const camera: LayerCamera = { distance: 1100, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
const pivot = { x: 0, y: 0, z: 0 };
function projected(id: string, rect: ScenePlane["rect"], edgeOnly = true): ProjectedPlane {
  const plane: ScenePlane = { id, node: makeNode(id), rect, source: rect, textureSrc: "own", textureSize: { width: 200, height: 200 }, z: 0, kind: "outline", opacity: 1, hitTestable: true };
  const projected = projectPlane(plane, pivot, camera, cameraRotation(camera));
  return { node: plane.node!, ...projected, painted: { plane, camera, pivot, cornerDepths: projected.corners.map(point => point.depth), kind: "outline", visible: true, edgeOnly } };
}

test("wireframe projected edges select while blank interiors pass through to a rear edge", () => {
  const front = projected("front", { left: 10, top: 10, width: 180, height: 180 });
  const back = projected("back", { left: 50, top: 50, width: 100, height: 100 });
  const pick = (x: number, y: number) => [front, back].find(plane => pointHitsProjectedPlane({ x, y }, plane))?.node.id;
  assert.equal(pick(10, 100), "front");
  assert.equal(pick(50, 100), "back");
  assert.equal(pick(100, 100), undefined);
  assert.equal(pick(4, 100), undefined);
  assert.equal(pick(16, 100), "front");
  assert.equal(pick(17, 100), undefined);
});

test("image mode retains full-plane picking and invisible layouts remain edge-only", () => {
  const plane = projected("normal", { left: 10, top: 10, width: 180, height: 180 }, false);
  assert.equal(pointHitsProjectedPlane({ x: 100, y: 100 }, plane), true);
  plane.painted!.plane.deviceInvisible = true;
  assert.equal(pointHitsProjectedPlane({ x: 100, y: 100 }, plane), false);
  assert.equal(pointHitsProjectedPlane({ x: 10, y: 100 }, plane), true);
});

test("wireframe edge selection uses the actual tilted projection", () => {
  const plane = projected("tilted", { left: 20, top: 20, width: 160, height: 120 });
  const tilted = { ...camera, azimuth: 42, elevation: 18, roll: 7 };
  plane.corners = projectPlane(plane.painted!.plane, pivot, tilted, cameraRotation(tilted)).corners;
  const center = { x: plane.corners.reduce((sum, point) => sum + point.x, 0) / 4, y: plane.corners.reduce((sum, point) => sum + point.y, 0) / 4 };
  const edge = { x: (plane.corners[0].x + plane.corners[1].x) / 2, y: (plane.corners[0].y + plane.corners[1].y) / 2 };
  assert.equal(pointHitsProjectedPlane(center, plane), false);
  assert.equal(pointHitsProjectedPlane(edge, plane), true);
});

test("workspace wireframe mode cannot enter saved appearance or reset prior preferences", () => {
  const saved = { ...DEFAULT_LAYER_APPEARANCE, showOutlines: false, highlightStrength: "strong" as const };
  assert.deepEqual(parseLayerAppearance({ ...saved, displayMode: "wireframe" }), saved);
});
