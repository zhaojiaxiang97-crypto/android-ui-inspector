import assert from "node:assert/strict";
import { test } from "node:test";
import { canUseSdkSingleTextCapture } from "../electron/sdk/sdk-hybrid";
import type { UiNode } from "../shared/types";

const fixture = () => {
  const root = { attributes: { "tree-source": "debug-sdk", "sdk-branch-geometry-version": "1",
    "sdk-process-instance": "12345678-1234-1234-1234-123456789abc", "sdk-ref-debug-canvas-version": "1" } } as unknown as UiNode;
  const node = { className: "custom.EmojiTextView", children: [], visibleToUser: true,
    attributes: { "view-ref": "custom.EmojiTextView@abc", "sdk-hardwareAccelerated": "true" }, bounds: { left: 1, top: 2, right: 10, bottom: 20 } } as unknown as UiNode;
  return { root, node };
};
test("SDK text rollout requires verified SDK binding and modern evidence capability", () => {
  const { root, node } = fixture();
  assert.equal(canUseSdkSingleTextCapture(root, node), true);
  for (const key of ["tree-source", "sdk-branch-geometry-version", "sdk-process-instance", "sdk-ref-debug-canvas-version"]) {
    const broken = { ...root, attributes: { ...root.attributes, [key]: "invalid" } };
    assert.equal(canUseSdkSingleTextCapture(broken, node), false);
  }
  assert.equal(canUseSdkSingleTextCapture({ ...root, attributes: {} }, node), false);
  const old = { ...root, attributes: { ...root.attributes } };
  delete old.attributes["sdk-ref-debug-canvas-version"];
  assert.equal(canUseSdkSingleTextCapture(old, node), false);
});
test("SDK text rollout requires explicit hardware acceleration; missing/false/invalid stay legacy", () => {
  const { root, node } = fixture();
  for (const value of [undefined, "false", "1", "TRUE", "unknown"]) {
    const attributes = { ...node.attributes };
    if (value === undefined) delete attributes["sdk-hardwareAccelerated"];
    else attributes["sdk-hardwareAccelerated"] = value;
    assert.equal(canUseSdkSingleTextCapture(root, { ...node, attributes }), false);
  }
});
test("SDK text rollout leaves containers, special layers and missing geometry on legacy route", () => {
  const { root, node } = fixture();
  for (const patch of [{ children: [node] }, { className: null }, { className: "android.view.SurfaceView" },
    { className: "android.widget.ImageView" }, { attributes: {} }, { bounds: null }, { visibleToUser: false }]) {
    assert.equal(canUseSdkSingleTextCapture(root, { ...node, ...patch } as UiNode), false);
  }
});
