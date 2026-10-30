import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { layerPlaneNodeId, MAX_MOTION_PLANES, mixCamera, motionProgress, sampleLayerMotion, type LayerMotionFrame } from "../src/features/layers/motion";
import type { ScenePlane } from "../src/features/layers/types";

const parents = new Map<string, string | null>([["root", null], ["child", "root"], ["leaf", "child"]]);
function plane(id: string, z: number, source = id): ScenePlane {
  return { id, node: null, kind: "native", z, rect: { left: 10, top: 20, width: 40, height: 50 }, source: { left: 0, top: 0, width: 40, height: 50 },
    textureSrc: source, textureSize: { width: 40, height: 50 }, opacity: 1, hitTestable: true };
}
function frame(planes: ScenePlane[], scale = 1): LayerMotionFrame {
  return { planes, presentation: { depths: new Map(planes.map(item => [layerPlaneNodeId(item.id), item.z / scale])),
    center: { x: 20, y: 30, z: 0 }, pivot: { x: 20, y: 30, z: 0 }, scale } };
}

describe("layer motion", () => {
  test("new layers begin at actual parent IDs, including IDs without slashes", () => {
    const from = frame([plane("root", -100)]), target = frame([plane("root", -100), plane("child", 0), plane("leaf", 100)]);
    const sample = sampleLayerMotion({ from, started: 0 }, target, parents, 0);
    assert.equal(sample.presentation.depths.get("child"), -100);
    assert.equal(sample.presentation.depths.get("leaf"), -100);
    assert.equal(sampleLayerMotion({ from, started: 0 }, target, parents, 1).presentation.depths.get("leaf"), 100);
  });

  test("folded descendants return to their parent without retaining a hit target", () => {
    const from = frame([plane("root", -100), plane("child", 100)]), target = frame([{ ...plane("root:parent", 0, "folded"), kind: "composite" }]);
    const start = sampleLayerMotion({ from, started: 0 }, target, parents, 0), halfway = sampleLayerMotion({ from, started: 0 }, target, parents, .5);
    const retired = halfway.planes.find(item => item.id === "child:motion")!;
    assert.equal(start.planes.find(item => item.id === "child:motion")?.z, 100);
    assert.ok(retired.z > 0 && retired.z < 100);
    assert.equal(retired.hitTestable, false);
    assert.equal(retired.node, null);
    assert.equal(sampleLayerMotion({ from, started: 0 }, target, parents, 1).planes.length, 1);
  });

  test("reversing begins at the currently painted geometry and source", () => {
    const expanded = frame([plane("root", -100), plane("child", 100)]), collapsed = frame([{ ...plane("root:parent", 0, "folded"), kind: "composite" }]);
    const shrinking = sampleLayerMotion({ from: expanded, started: 0 }, collapsed, parents, .3);
    const reverse = sampleLayerMotion({ from: shrinking, started: 50 }, expanded, parents, 0);
    assert.equal(reverse.planes.find(item => item.id === "child")?.z, shrinking.planes.find(item => item.id === "child:motion")?.z);
    assert.equal(reverse.planes.find(item => item.id === "root")?.z, shrinking.planes.find(item => item.id === "root:motion")?.z);
    assert.equal(reverse.presentation.scale, shrinking.presentation.scale);
  });

  test("pending folded pixels retain already painted children at the parent depth", () => {
    const from = frame([plane("root", -100), plane("child", 100)]), target = frame([{ ...plane("root:parent", 0, "folded"), kind: "composite" }]);
    const pending = sampleLayerMotion({ from, started: 0 }, target, parents, 1, () => false);
    assert.equal(pending.planes.find(item => item.id === "child:motion")?.z, 0);
    assert.equal(pending.planes.find(item => item.id === "child:motion")?.opacity, 1);
    assert.equal(sampleLayerMotion({ from: pending, started: 0 }, target, parents, 1).planes.length, 1);
  });

  test("transparent content retains a smoothly fading layout border during expansion and collapse", () => {
    const root = plane("root", -100), child = {...plane("child", 100), opacity:0, outlineOpacity:1};
    const collapsed = frame([root]), expanded = frame([root, child]);
    const opening = sampleLayerMotion({from:collapsed, started:0}, expanded, parents, .5).planes.find(p => p.id === 'child')!;
    assert.equal(opening.opacity, 0); assert.equal(opening.outlineOpacity, .875);
    const closing = sampleLayerMotion({from:expanded, started:0}, collapsed, parents, .5).planes.find(p => p.id === 'child:motion')!;
    assert.equal(closing.opacity, 0); assert.equal(closing.outlineOpacity, .125);
    assert.equal(closing.hitTestable, false);
    assert.equal(sampleLayerMotion({from:expanded, started:0}, collapsed, parents, 1).planes.length, 1);
  });

  test("switching own/group textures keeps one layout contour while old pixels retire", () => {
    const own = {...plane('root', -100), outlineOpacity:1};
    const group = {...plane('root:parent', 0, 'group'), kind:'composite' as const, outlineOpacity:1};
    for (const ready of [true,false]) {
      const sample = sampleLayerMotion({from:frame([own]), started:0}, frame([group]), parents, .5, () => ready);
      assert.equal(sample.planes.find(p => p.id === group.id)?.outlineOpacity, 1);
      assert.equal(sample.planes.find(p => p.id === 'root:motion')?.outlineOpacity, 0);
      assert.ok(sample.planes.find(p => p.id === 'root:motion')!.opacity > 0, 'outgoing pixels disappeared before the group was ready');
    }
  });

  test("depth, centering and scale follow the same motion frame", () => {
    const from = frame([plane("root", 0)], 1), target = frame([{ ...plane("root", 200), rect: { left: 100, top: 200, width: 80, height: 100 } }], 2);
    target.presentation.pivot = { x: 100, y: 150, z: 0 };
    const sample = sampleLayerMotion({ from, started: 0 }, target, parents, .5), result = sample.planes[0];
    assert.equal(sample.presentation.scale, 1.875);
    assert.equal(result.z, 87.5 * 1.875);
    assert.equal(result.rect.width, 75);
    assert.equal(result.rect.height, 93.75);
  });

  test("repeated reversals keep the drawn layer union bounded", () => {
    const from = frame(Array.from({ length: 511 }, (_, index) => plane(`old-${index}`, index)));
    const target = frame([plane("root:parent", 0)]);
    const tree = new Map([...parents, ...from.planes.map(item => [item.id, "root"] as const)]);
    let sampled = sampleLayerMotion({ from, started: 0 }, target, tree, .2, () => false);
    for (let repeat = 0; repeat < 10; repeat++) sampled = sampleLayerMotion({ from: sampled, started: 0 }, target, tree, .2, () => false);
    assert.ok(sampled.planes.length <= MAX_MOTION_PLANES);
    assert.equal(new Set(sampled.planes.map(item => item.id)).size, sampled.planes.length);
  });

  test("finite progress and camera interpolation have exact endpoints", () => {
    const camera = { distance: 1100, azimuth: 40, elevation: 12, roll: 0, layerGap: 96, panX: 0, panY: 0 }, other = { ...camera, azimuth: -20, elevation: -30, panX: 80 };
    assert.equal(motionProgress(100, 50), 0);
    assert.equal(motionProgress(100, 320), 1);
    assert.deepEqual(mixCamera(camera, other, 0), camera);
    assert.deepEqual(mixCamera(camera, other, 1), other);
    const halfway = mixCamera(camera, other, .5);
    assert.equal(halfway.azimuth, -12.5);
    assert.equal(halfway.panX, 70);
  });
});
