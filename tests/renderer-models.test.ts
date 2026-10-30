import assert from "node:assert/strict";
import { test } from "node:test";
import { addSnapshotDiffs, diffSummary, formatSnapshotTime } from "../src/features/history/model";
import { adbTapCommand, findNodePath, nodeJson, uiSelectorForNode, xpathForNode } from "../src/features/inspection/locators";
import { cameraRotation, pointInQuad, projectPlane, projectPoint } from "../src/features/layers/projection";
import type { LayerCamera, ScenePlane } from "../src/features/layers/types";
import type { StoredSnapshot, UiNode } from "../shared/types";

function node(id: string, children: UiNode[] = []): UiNode {
  return { id, index: 0, className: "android.view.View", package: "sample.app", text: null, resourceId: null,
    contentDesc: null, bounds: null, clickable: false, enabled: true, focusable: false, focused: false,
    scrollable: false, selected: false, visibleToUser: true, children };
}
function saved(id: string, root: UiNode, serial = "fixture"): StoredSnapshot {
  return { id, savedAt: "2026-10-07T00:00:00Z", capturedAt: "2026-10-07T00:00:00Z", snapshot: { serial, root, nodeCount: 1, xmlSize: 0,
    rawXml: null, screenshotDataUrl: null, error: null, warning: null } };
}

test("history model records changed values and added/removed nodes without mutating records", () => {
  const before = node("0", [node("0/0"), node("0/1")]);
  const after = node("0", [{ ...node("0/0"), text: "new", enabled: false }, node("0/2")]);
  const inputs = [saved("one", before), saved("two", after)], original = JSON.stringify(inputs);
  const [first, second] = addSnapshotDiffs(inputs);
  assert.equal(first.diff, null);
  assert.deepEqual(second.diff && [second.diff.added, second.diff.removed, second.diff.changed, second.diff.unchanged], [1, 1, 1, 1]);
  assert.deepEqual(second.diff?.changes[0].details, [{ field: "text", previous: null, current: "new" }, { field: "enabled", previous: "true", current: "false" }]);
  assert.equal(diffSummary(second.diff!), "+1 / -1 / 1 项属性变化");
  assert.equal(JSON.stringify(inputs), original);
});

test("history only compares adjacent snapshots from the same device, bounds detail output", () => {
  const previous = node("0"), current = node("0", Array.from({ length: 240 }, (_, i) => node(`0/${i}`)));
  assert.equal(addSnapshotDiffs([saved("one", previous), saved("two", current, "other")])[1].diff, null);
  const diff = addSnapshotDiffs([saved("one", previous), saved("two", current)])[1].diff!;
  assert.equal(diff.added, 240); assert.equal(diff.changes.length, 200);
  assert.equal(formatSnapshotTime("invalid-date"), "invalid-date");
});

test("locators preserve quoted text and structural paths", () => {
  const child = { ...node("0/2"), text: `a'b"c` }, root = node("0", [child]);
  assert.equal(xpathForNode(root, child), `//android.view.View[@text=concat('a',"'",'b"c')]`);
  assert.deepEqual(findNodePath(root, child.id), [root, child]);
  assert.equal(findNodePath(root, "absent"), null);
  assert.equal(xpathForNode(root, { ...child, text: null }), "//android.view.View/android.view.View[3]");
  assert.ok(uiSelectorForNode(child).includes(`.text(${JSON.stringify(child.text)})`));
  assert.equal(nodeJson(child), JSON.stringify(child, null, 2));
});

test("locator commands use bounds centers but do not dispatch anything", () => {
  assert.equal(adbTapCommand("fixture", node("0")), "当前节点没有有效 bounds");
  const target = { ...node("0"), bounds: { left: 10, top: 20, right: 51, bottom: 81, raw: "[10,20][51,81]" } };
  assert.equal(adbTapCommand("fixture device", target), 'adb -s "fixture device" shell input tap 31 51');
  assert.ok(uiSelectorForNode({ ...target, resourceId: "sample.app:id/action", text: "ignored" }).includes('.resourceId("sample.app:id/action")'));
});

const camera: LayerCamera = { distance: 1000, azimuth: 0, elevation: 0, roll: 0, layerGap: 64, panX: 0, panY: 0 };
const pivot = { x: 100, y: 100, z: 0 };
test("projection keeps the pivot stationary and expands nearer planes", () => {
  assert.deepEqual(projectPoint(100, 100, 0, pivot, camera, cameraRotation(camera)), { x: 100, y: 100, depth: 0 });
  assert.equal(projectPoint(150, 100, 500, pivot, camera, cameraRotation(camera)).x, 200);
  const rotated = { ...camera, azimuth: -90 };
  const point = projectPoint(100, 100, 50, pivot, rotated, cameraRotation(rotated));
  assert.ok(Math.abs(point.x - 150) < 1e-9);
});

test("plane projection and hit testing share corner order across viewing direction", () => {
  const plane: ScenePlane = { id: "0", node: null, rect: { left: 90, top: 90, width: 20, height: 20 },
    source: { left: 0, top: 0, width: 20, height: 20 }, textureSrc: null, textureSize: { width: 20, height: 20 },
    z: 0, kind: "outline", opacity: 1, hitTestable: true };
  const projected = projectPlane(plane, pivot, camera, cameraRotation(camera));
  assert.equal(projected.depth, 0);
  assert.equal(pointInQuad({ x: 100, y: 100 }, projected.corners), true);
  assert.equal(pointInQuad({ x: 80, y: 100 }, projected.corners), false);
  assert.equal(pointInQuad({ x: 90, y: 90 }, [...projected.corners].reverse()), true);
});
