import assert from "node:assert/strict";
import { test } from "node:test";
import { subtreeImageNodes, textureDimensions } from "../shared/layer-textures";
import type { UiNode } from "../shared/types";

test("texture allocations obey pixel/dimension limits and preserve small images", () => {
  assert.deepEqual(textureDimensions(32, 16, 10_000), { width: 32, height: 16 });
  const size = textureDimensions(10_000, 5_000, 200_000, 1024);
  assert.ok(size.width * size.height <= 200_000 && size.width <= 1024);
  assert.ok(Math.abs(size.width / size.height - 2) < 0.02);
  assert.throws(() => textureDimensions(NaN, 10));
  assert.throws(() => textureDimensions(0, 10));
  assert.throws(() => textureDimensions(10, 10, 0.5));
  assert.deepEqual(textureDimensions(100_000, 1, 100), { width: 100, height: 1 });
  assert.deepEqual(textureDimensions(1, 100_000, 100), { width: 1, height: 100 });
});

test("collapsed texture includes own background and ordered descendants, never siblings or hidden subtrees", () => {
  const node = (id: string, children: UiNode[] = []): UiNode => ({
    id, index: 0, className: "View", package: "test", text: null, resourceId: null, contentDesc: null,
    bounds: { left: 0, top: 0, right: 10, bottom: 10, raw: "[0,0][10,10]" },
    clickable: false, enabled: true, focusable: false, focused: false, scrollable: false, selected: false,
    visibleToUser: true, layerImageDataUrl: id, layerImageSize: { width: 10, height: 10 }, children,
  });
  const front = node("front"); front.attributes = { "drawing-order": "2" };
  const back = node("back"); back.attributes = { "drawing-order": "1" };
  const hidden = node("hidden", [node("hidden-child")]); hidden.visibleToUser = false;
  const parent = node("parent", [front, hidden, back]);
  const root = node("root", [parent, node("sibling")]);
  assert.deepEqual(subtreeImageNodes(root.children[0]).map((item) => item.id), ["parent", "back", "front"]);
  assert.equal(parent.layerImageDataUrl, "parent");
  assert.deepEqual(subtreeImageNodes(parent, new Set(["parent", "front"])).map((item) => item.id), ["back"], "hiding a plane excludes only its own image, not its children");
  parent.layerImageEmpty = true;
  assert.deepEqual(subtreeImageNodes(parent).map((item) => item.id), ["back", "front"], "transparent parent must retain its visible descendants");
  back.layerImageEmpty = front.layerImageEmpty = true;
  assert.deepEqual(subtreeImageNodes(parent), [], "fully transparent collapsed branches only need an outline");
});
