import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cameraTransform, clampElevation, constrainOrbitCamera, orbitFromDrag, orbitFromKeys, wrapDegrees, type OrbitCamera } from "../shared/orbit-camera";

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
    assert.equal(cameraTransform({ azimuth: 90, elevation: 30, roll: 10 }), "rotateZ(-10deg) rotateX(-30deg) rotateY(-90deg)");
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
