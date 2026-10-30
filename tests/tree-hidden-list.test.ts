import assert from "node:assert/strict";
import { test } from "node:test";
import { createTree, makeNode } from "../benchmarks/fixtures";
import { manuallyHiddenLayers } from "../shared/tree-hidden-state";
import { indexTree } from "../shared/visible-tree";

test("manual hidden list preserves exact nodes and hiding order; reasons use the actual closest parent", () => {
  const root = { ...makeNode("root"), text: "窗口" }, parent = { ...makeNode("parent"), text: "同名" };
  const child = { ...makeNode("child"), text: "同名" }, sibling = { ...makeNode("sibling"), text: "同名" };
  root.children = [parent, sibling]; parent.children = [child];
  const hidden = new Set(["child", "sibling", "parent", "root", "removed"]), index = indexTree(root);
  const before = JSON.stringify(root), entries = manuallyHiddenLayers(index, hidden);
  assert.deepEqual(entries.map(item => item.node), [child, sibling, parent, root]);
  assert.deepEqual(entries.map(item => item.hiddenAncestor), [parent, root, root, null]);
  assert.equal(entries[0].path, `窗口 (${root.className}) > 同名 (${parent.className}) > 同名 (${child.className})`);
  assert.equal(JSON.stringify(root), before);
  assert.equal(hidden.size, 5);
  hidden.delete(parent.id);
  assert.equal(manuallyHiddenLayers(index, hidden)[0].hiddenAncestor, root);
});

test("list includes only manual records, leaves visibility and image status alone, and replaces same-ID identities", () => {
  const root = createTree(4, "wide"), node = root.children[0];
  node.visibleToUser = false; node.layerImageStatus = "unavailable";
  assert.equal(manuallyHiddenLayers(indexTree(root), new Set()).length, 0);
  const entries = manuallyHiddenLayers(indexTree(root), new Set([node.id]));
  assert.equal(entries.length, 1); assert.equal(entries[0].node, node);
  const replacement = { ...node, text: "新的控件" }, next = { ...root, children: [replacement, ...root.children.slice(1)] };
  assert.equal(manuallyHiddenLayers(indexTree(next), new Set([node.id]))[0].node, replacement);
  assert.equal(node.visibleToUser, false); assert.equal(node.layerImageStatus, "unavailable");
});

test("deep paths are iterative and full; 25k hidden records keep exact count without rendering a path table", () => {
  const deep = Array.from({ length: 512 }, (_, i) => ({ ...makeNode(`opaque-${i}`, i), text: `第 ${i} 层`, className: null }));
  deep.forEach((node, i) => { if (deep[i + 1]) node.children = [deep[i + 1]]; });
  const entries = manuallyHiddenLayers(indexTree(deep[0]), new Set(deep.map(node => node.id)));
  assert.equal(entries.length, 512); assert.equal(entries[511].hiddenAncestor, deep[510]);
  assert.equal(entries[511].path.split(" > ").length, 512); assert.ok(entries[511].path.endsWith("第 511 层"));
  const wide = createTree(25_000, "wide"), index = indexTree(wide), hidden = new Set(index.keys());
  const all = manuallyHiddenLayers(index, hidden);
  assert.equal(all.length, 25_000); assert.equal(all[24_999].node, wide.children.at(-1));
  assert.equal(all[24_999].hiddenAncestor, wide);
});
