import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { assessCaptureGeometry, boundsPercent, clientToScreen, clipBounds, findNodeAtPoint, isCaptureGeometry } from "../shared/screen-coordinates";
import type { CaptureGeometry, PixelSize, UiBounds } from "../shared/types";

const bounds = (left: number, top: number, right: number, bottom: number): UiBounds => ({ left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` });
const size = { width: 1080, height: 2400 };
const frame = { ...size, rotation: 0 as const };
const geometry: CaptureGeometry = { hierarchyRotation: 0, beforeScreenshot: frame, afterScreenshot: frame, screenshotSize: size };

for (const [width, height] of [[720, 1280], [1080, 2400], [1440, 3200], [1280, 720], [2400, 1080], [3200, 1440], [2560, 1600], [1600, 2560], [1000, 1000]]) {
  test(`CSS-to-image mapping at ${width}x${height}, fractional offsets and zoomed layouts`, () => {
    for (const scale of [0.07, 0.25, 0.5, 1, 1.25, 1.5, 2]) {
      const rect = { left: 137.125, top: -28.75, width: width * scale, height: height * scale };
      for (const [fx, fy] of [[0, 0], [0.2, 0.7], [0.5, 0.5], [0.999, 0.999]]) {
        const point = clientToScreen(rect.left + fx * rect.width, rect.top + fy * rect.height, rect, { width, height });
        assert.ok(point);
        assert.ok(Math.abs(point.x - width * fx) < 1e-8);
        assert.ok(Math.abs(point.y - height * fy) < 1e-8);
      }
      assert.equal(clientToScreen(rect.left - 1, rect.top, rect, { width, height }), null);
      assert.equal(clientToScreen(rect.left + rect.width, rect.top, rect, { width, height }), null);
      assert.equal(clientToScreen(rect.left, rect.top + rect.height, rect, { width, height }), null);
    }
  });
}

test("invalid dimensions, coordinates and zero-size image boxes do not map", () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 };
  for (const invalid of [0, -1, NaN, Infinity]) {
    assert.equal(clientToScreen(1, 1, { ...rect, width: invalid }, size), null);
    assert.equal(clientToScreen(1, 1, rect, { ...size, height: invalid }), null);
  }
  assert.equal(clientToScreen(NaN, 1, rect, size), null);
  assert.equal(clientToScreen(1, Infinity, rect, size), null);
  assert.equal(clientToScreen(1, 1, { ...rect, left: Infinity }, size), null);
});

test("clip the rectangle before converting to percent, including subpixel-width nodes", () => {
  assert.deepEqual(boundsPercent(bounds(-100, -200, 540, 1200), size), { left: "0%", top: "0%", width: "50%", height: "50%" });
  assert.deepEqual(boundsPercent(bounds(540, 1200, 2000, 3000), size), { left: "50%", top: "50%", width: "50%", height: "50%" });
  assert.deepEqual(clipBounds(bounds(-100, -200, 2000, 3000), size), { left: 0, top: 0, right: 1080, bottom: 2400 });
  assert.ok(boundsPercent(bounds(10, 20, 11, 21), size));
  for (const invalid of [bounds(0, 0, 0, 10), bounds(20, 20, 10, 30), bounds(-20, -20, -10, -10), bounds(1080, 0, 1200, 10), bounds(NaN, 0, 1, 1), bounds(0, 0, Infinity, 1)]) {
    assert.equal(boundsPercent(invalid, size), null);
  }
});

test("half-open edges, hidden/empty bounds, inset roots and boundless ancestors", () => {
  const root = makeNode("0"); root.bounds = null;
  const left = makeNode("0/0"); left.bounds = bounds(0, 100, 540, 500);
  const right = makeNode("0/1"); right.bounds = bounds(540, 100, 1080, 500);
  const hidden = makeNode("0/2"); hidden.bounds = bounds(540, 100, 550, 110); hidden.visibleToUser = false;
  const empty = makeNode("0/3"); empty.bounds = bounds(540, 100, 540, 100);
  root.children = [left, right, hidden, empty];
  assert.equal(findNodeAtPoint(root, 539.99, 100, size), left);
  assert.equal(findNodeAtPoint(root, 540, 100, size), right);
  assert.equal(findNodeAtPoint(root, 540, 500, size), null);
  assert.equal(findNodeAtPoint(root, 1080, 100, size), null);
  assert.equal(findNodeAtPoint(root, 540, 0, size), null);
  root.bounds = bounds(0, 800, 1080, 2000);
  assert.equal(findNodeAtPoint(root, 540, 100, size), right);
});

test("overlapping nodes prefer smallest visible area, then depth, then later XML order", () => {
  const root = makeNode("0"); root.bounds = bounds(0, 0, 1080, 2400);
  const first = makeNode("0/0"); first.bounds = bounds(0, 0, 500, 500);
  const second = makeNode("0/1"); second.bounds = first.bounds;
  const deep = makeNode("0/0/0"); deep.bounds = first.bounds;
  root.children = [first, second];
  assert.equal(findNodeAtPoint(root, 10, 10, size), second);
  first.children = [deep];
  assert.equal(findNodeAtPoint(root, 10, 10, size), deep);
  second.bounds = bounds(-100, 0, 20, 20);
  assert.equal(findNodeAtPoint(root, 10, 10, size), second);
});

test("deep hit testing is iterative and returns the original leaf", () => {
  const root = makeNode("0"); root.bounds = null;
  let leaf = root;
  for (let i = 0; i < 12_000; i++) {
    const next = makeNode(`node-${i}`); next.bounds = bounds(0, 0, 10, 10);
    leaf.children = [next]; leaf = next;
  }
  assert.equal(findNodeAtPoint(root, 5, 5, size), leaf);
});

test("orientation is checked by metadata, never guessed from aspect ratio", () => {
  assert.equal(assessCaptureGeometry(geometry, size).status, "checked");
  for (const rotation of [0, 1, 2, 3] as const) {
    const naturalLandscape: PixelSize = { width: 2560, height: 1600 };
    const display = { ...naturalLandscape, rotation };
    assert.equal(assessCaptureGeometry({ hierarchyRotation: rotation, beforeScreenshot: display, afterScreenshot: display, screenshotSize: naturalLandscape }).status, "checked");
  }
});

test("detects 90/180/270 degree transitions, frame size changes and wrong decoded image", () => {
  for (const rotation of [1, 2, 3]) {
    assert.equal(assessCaptureGeometry({ ...geometry, afterScreenshot: { ...frame, rotation } }).status, "mismatch");
  }
  assert.equal(assessCaptureGeometry({ ...geometry, hierarchyRotation: 1 }).status, "mismatch");
  assert.equal(assessCaptureGeometry({ ...geometry, afterScreenshot: { ...frame, width: 720 } }).status, "mismatch");
  assert.equal(assessCaptureGeometry(geometry, { width: 2400, height: 1080 }).status, "mismatch");
  assert.equal(assessCaptureGeometry({ ...geometry, beforeScreenshot: null, afterScreenshot: { ...frame, rotation: 2 } }).status, "mismatch");
});

test("old snapshots and partial/invalid diagnostics are distinguished and validated", () => {
  assert.equal(assessCaptureGeometry(undefined).status, "unverified");
  assert.equal(assessCaptureGeometry({ ...geometry, beforeScreenshot: null }).status, "unverified");
  assert.equal(assessCaptureGeometry({ ...geometry, hierarchyRotation: null }).status, "unverified");
  assert.equal(isCaptureGeometry(JSON.parse(JSON.stringify(geometry))), true);
  for (const invalid of [null, {}, { ...geometry, hierarchyRotation: 90 }, { ...geometry, screenshotSize: { width: 0, height: 1 } }, { ...geometry, afterScreenshot: { ...frame, height: 0.5 } }]) {
    assert.equal(isCaptureGeometry(invalid), false);
    assert.equal(assessCaptureGeometry(invalid).status, "mismatch");
  }
});
