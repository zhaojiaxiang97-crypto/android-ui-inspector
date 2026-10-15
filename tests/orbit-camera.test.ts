import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cameraForLayerPreset, cameraTransform, clampElevation, constrainOrbitCamera, matchesLayerPreset, orbitFromDrag, orbitFromKeys, parseOrbitParameter, wrapDegrees, type OrbitCamera } from "../shared/orbit-camera";

const camera: OrbitCamera = {
  distance: 1100,
  azimuth: 0,
  elevation: 0,
  roll: 0,
  layerGap: 32,
  panX: 0,
  panY: 0,
};

describe("orbit camera math", () => {
  test("layer presets restore framing while preserving custom perspective and horizontal-only rotation", () => {
    const current = { ...camera, azimuth: -65, elevation: 25, roll: 12, layerGap: 24, panX: 200, panY: -90, distance: 1560 };
    const expanded = cameraForLayerPreset(current, "exploded", "free");
    assert.equal(expanded.distance, current.distance);
    assert.equal(expanded.elevation, 0);
    assert.equal(cameraForLayerPreset(current, "stacked", "free").elevation, 0);
    assert.equal(expanded.panX, 0); assert.equal(expanded.panY, 0); assert.equal(expanded.roll, 0);
    assert.ok(expanded.layerGap > cameraForLayerPreset(current, "stacked", "free").layerGap);
    assert.equal(matchesLayerPreset(expanded, "exploded", "free"), true);
    assert.equal(matchesLayerPreset(orbitFromKeys(expanded, "ArrowRight"), "exploded", "free"), false);
    const horizontal = cameraForLayerPreset(current, "exploded", "horizontal");
    assert.equal(horizontal.elevation, 0); assert.equal(horizontal.roll, 0);
    assert.equal(matchesLayerPreset(horizontal, "exploded", "horizontal"), true);
    assert.equal(current.panX, 200);
  });

  test("exact display parameters accept endpoints and steps, preserving the existing unchanged default", () => {
    for (const value of [24, 32, 120, 240]) assert.deepEqual(parseOrbitParameter("layerGap", String(value), 96), { value, error: null });
    for (const value of [720, 1120, 1800]) assert.deepEqual(parseOrbitParameter("distance", String(value), 1100), { value, error: null });
    assert.deepEqual(parseOrbitParameter("distance", "1100.0", 1100), { value: 1100, error: null });
    assert.match(parseOrbitParameter("distance", "1100", 1120).error!, /步|每次/);
    assert.match(parseOrbitParameter("layerGap", "121", 96).error!, /每次增加 8/);
  });

  test("invalid display drafts report the reason without coercing or clamping them", () => {
    for (const text of ["", "  ", "NaN", "Infinity", "-Infinity", "1e309", "0x78", "120 px", "一百二十", "120.5", "-24", "248"])
      assert.equal(parseOrbitParameter("layerGap", text, 96).value, null, `accepted ${JSON.stringify(text)}`);
    for (const text of ["680", "1840", "721", "1120.5"]) assert.equal(parseOrbitParameter("distance", text, 1100).value, null);
    assert.deepEqual(parseOrbitParameter("layerGap", " 120.0 ", 96), { value: 120, error: null });
  });

  test("wraps yaw while preserving a stable front-facing range", () => {
    assert.equal(wrapDegrees(0), 0);
    assert.equal(wrapDegrees(180), 180);
    assert.equal(wrapDegrees(540), 180);
    assert.equal(wrapDegrees(-181), 179);
    assert.equal(wrapDegrees(Number.NaN), 0);
  });

  test("clamps pitch before the camera reaches a pole", () => {
    assert.equal(clampElevation(-120), -65);
    assert.equal(clampElevation(120), 65);
    assert.equal(clampElevation(22), 22);
  });

  test("drag can reach the back and top views without changing the world bounds", () => {
    const next = orbitFromDrag(camera, 400, -100);
    assert.equal(next.azimuth, 180);
    assert.equal(next.elevation, -45);
    assert.equal(next.layerGap, camera.layerGap);
  });

  test("keyboard orbit wraps horizontally and clamps vertically", () => {
    const left = orbitFromKeys({ ...camera, azimuth: -179 }, "ArrowLeft", 6);
    const up = orbitFromKeys({ ...camera, elevation: -63 }, "ArrowUp", 6);
    assert.equal(left.azimuth, 175);
    assert.equal(up.elevation, -65);
  });

  test("camera transform applies inverse orbit rotation", () => {
    assert.equal(cameraTransform({ azimuth: 90, elevation: 30, roll: 10 }), "rotateZ(-10deg) rotateY(-90deg) rotateX(-30deg)");
  });

  test("horizontal mode removes pitch and roll while preserving the rest of the view", () => {
    const tilted = { ...camera, distance: 1500, azimuth: -135, elevation: 36, roll: -18, layerGap: 80, panX: 123, panY: -45 };
    assert.deepEqual(constrainOrbitCamera(tilted, "horizontal"), { ...tilted, elevation: 0, roll: 0 });
    assert.deepEqual(tilted, { ...camera, distance: 1500, azimuth: -135, elevation: 36, roll: -18, layerGap: 80, panX: 123, panY: -45 });
    assert.equal(constrainOrbitCamera(tilted, "free"), tilted);
  });

  test("horizontal drag and keyboard keep yaw responsive and block vertical orbit", () => {
    const dragged = constrainOrbitCamera(orbitFromDrag({ ...camera, roll: 20 }, 80, 100), "horizontal");
    assert.equal(dragged.azimuth, 36);
    assert.equal(dragged.elevation, 0);
    assert.equal(dragged.roll, 0);
    const up = constrainOrbitCamera(orbitFromKeys(dragged, "ArrowUp"), "horizontal");
    assert.deepEqual(up, dragged);
    const right = constrainOrbitCamera(orbitFromKeys(up, "ArrowRight"), "horizontal");
    assert.deepEqual(right, { ...dragged, azimuth: 42 });
  });
});
