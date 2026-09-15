import assert from "node:assert/strict";
import { test } from "node:test";
import { subtreeImageNodes } from "../shared/layer-textures";
import type { UiNode } from "../shared/types";

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
});
