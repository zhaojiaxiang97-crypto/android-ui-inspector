import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_ORBIT_CAMERA, type OrbitCamera } from "../shared/orbit-camera";
import { createCanvasCamera } from "../src/features/layers/canvas-camera";
import { LAYER_MOTION_DURATION } from "../src/features/layers/motion";

function harness() {
  let nextId = 0, now = 0, reduced = false;
  const pending = new Map<number, () => void>(), delivered = new Map<number, () => void>();
  const paints: OrbitCamera[] = [], commits: OrbitCamera[] = [], progress: number[] = [];
  const camera = createCanvasCamera(DEFAULT_ORBIT_CAMERA, "free", {
    paint: value => paints.push({ ...value }), commit: value => commits.push({ ...value }), progress: value => progress.push(value),
  }, {
    request: callback => { const id = ++nextId; pending.set(id, callback); delivered.set(id, callback); return id; },
    cancel: id => { pending.delete(id); }, now: () => now, reducedMotion: () => reduced,
  });
  return { camera, paints, commits, progress, pending,
    flush: (time: number) => { now = time; const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback()); },
    replay: (id: number) => delivered.get(id)!(), reduce: () => { reduced = true; },
  };
}

describe("canvas camera controller", () => {
  test("drag updates coalesce into one paint and never commit React state before release", () => {
    const h = harness();
    h.camera.schedule({ ...h.camera.read(), panX: 12 });
    h.camera.schedule({ ...h.camera.read(), panX: 39, azimuth: 31 });
    assert.equal(h.pending.size, 1); assert.equal(h.paints.length, 0); assert.equal(h.commits.length, 0);
    h.flush(16);
    assert.equal(h.paints.length, 1); assert.equal(h.paints[0].panX, 39);
    assert.equal(h.commits.length, 0);
    h.camera.commit(h.camera.read());
    assert.equal(h.commits.length, 1); assert.deepEqual(h.commits[0], h.paints.at(-1)!);
  });

  test("commit invalidates an old drag callback even if the browser delivers it later", () => {
    const h = harness();
    h.camera.schedule({ ...h.camera.read(), panX: 12 });
    const old = [...h.pending.keys()][0];
    h.camera.commit({ ...h.camera.read(), panX: 99 });
    const paints = h.paints.length;
    h.camera.schedule({ ...h.camera.read(), panX: 150 });
    h.replay(old);
    assert.equal(h.paints.length, paints); assert.equal(h.pending.size, 1);
    h.flush(16); assert.equal(h.paints.at(-1)!.panX, 150);
  });

  test("animation exposes its destination once while read and paint follow the same actual frame", () => {
    const h = harness(), target = { ...DEFAULT_ORBIT_CAMERA, azimuth: 90, panX: 100 };
    h.camera.animate(target, true);
    assert.deepEqual(h.commits, [target]);
    h.flush(LAYER_MOTION_DURATION / 2);
    assert.equal(h.commits.length, 1); assert.deepEqual(h.camera.read(), h.paints.at(-1)!);
    assert.notEqual(h.camera.read().azimuth, target.azimuth);
    h.camera.repaint(target);
    assert.deepEqual(h.camera.read(), h.paints.at(-1)!); assert.notEqual(h.camera.read().azimuth, target.azimuth);
    h.flush(LAYER_MOTION_DURATION);
    assert.deepEqual(h.camera.read(), target); assert.equal(h.progress.at(-1), 1); assert.equal(h.pending.size, 0);
  });

  test("interrupt commits the drawn frame and rejects a delayed animation callback", () => {
    const h = harness();
    h.camera.animate({ ...DEFAULT_ORBIT_CAMERA, azimuth: 80 }, true);
    h.flush(50); const actual = { ...h.camera.read() }, old = [...h.pending.keys()][0];
    h.camera.interrupt();
    assert.deepEqual(h.commits.at(-1), actual);
    const count = h.paints.length; h.replay(old);
    assert.equal(h.paints.length, count); assert.equal(h.pending.size, 0);
  });

  test("context cancellation retains the actual frame until the next context publishes it", () => {
    const h = harness(), target = { ...DEFAULT_ORBIT_CAMERA, azimuth: 100 };
    h.camera.animate(target, true); h.flush(70);
    const actual = { ...h.camera.read() }, old = [...h.pending.keys()][0], count = h.commits.length;
    h.camera.cancelPending();
    assert.equal(h.commits.length, count); // Cleanup itself does not update React on unmount.
    h.camera.repaint(target); assert.deepEqual(h.camera.read(), actual);
    h.camera.interrupt(); assert.deepEqual(h.commits.at(-1), actual);
    const paintCount = h.paints.length; h.replay(old);
    assert.equal(h.paints.length, paintCount); assert.equal(h.pending.size, 0);
    h.camera.animate({ ...actual, azimuth: 120 }, true); h.flush(300);
    assert.equal(h.camera.read().azimuth, 120);
  });

  test("unmount cancels both queues and stale callbacks cannot paint or commit", () => {
    const h = harness();
    h.camera.animate({ ...DEFAULT_ORBIT_CAMERA, azimuth: 70 }, true);
    h.camera.schedule({ ...h.camera.read(), panX: 80 });
    const queued = [...h.pending.keys()], paints = h.paints.length, commits = h.commits.length;
    h.camera.cancelPending(); queued.forEach(h.replay);
    assert.equal(h.pending.size, 0); assert.equal(h.paints.length, paints); assert.equal(h.commits.length, commits);
  });

  test("horizontal mode constrains a live animation and every later scheduling path", () => {
    const h = harness();
    h.camera.animate({ ...DEFAULT_ORBIT_CAMERA, elevation: 50, roll: 25 }, true); h.flush(50);
    const old = [...h.pending.keys()][0]; h.camera.setRotationMode("horizontal"); h.replay(old);
    assert.equal(h.camera.read().elevation, 0); assert.equal(h.camera.read().roll, 0);
    h.camera.schedule({ ...h.camera.read(), elevation: 35, roll: -20 }); h.flush(100);
    assert.equal(h.paints.at(-1)!.elevation, 0); assert.equal(h.paints.at(-1)!.roll, 0);
    h.camera.animate({ ...h.camera.read(), elevation: 60, roll: 40 }, true); h.flush(400);
    assert.equal(h.camera.read().elevation, 0); assert.equal(h.camera.read().roll, 0);
  });

  test("reduced motion finishes a pending animation and skips new animation frames", () => {
    const h = harness(), target = { ...DEFAULT_ORBIT_CAMERA, azimuth: 30 };
    h.camera.animate(target, true); const old = [...h.pending.keys()][0];
    h.reduce(); h.camera.finishMotion(); assert.deepEqual(h.camera.read(), target);
    const count = h.paints.length; h.replay(old); assert.equal(h.paints.length, count);
    h.camera.animate({ ...target, azimuth: 60 }, true);
    assert.equal(h.camera.read().azimuth, 60); assert.equal(h.pending.size, 0);
  });
});
