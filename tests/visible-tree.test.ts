import assert from "node:assert/strict";
import { test } from "node:test";
import { createTree, makeNode } from "../benchmarks/fixtures";
import { collapseTreeBranch, expandAncestors, indexTree, nearestVisibleId, scrollToTreeRow, TREE_ROW_HEIGHT, treeWindow, visibleTreeRows } from "../shared/visible-tree";
import { filterTree } from "../shared/tree-utils";

test("visible rows preserve preorder, levels and sibling metadata", () => {
  const root = createTree(21);
  const rows = visibleTreeRows(root, new Set([root.id, "0/1"]));
  assert.deepEqual(rows.map((row) => row.node.id), ["0", "0/0", "0/1", "0/1/0", "0/1/1", "0/1/2", "0/1/3", "0/2", "0/3"]);
  assert.deepEqual({ ...rows[4], node: undefined }, { node: undefined, parentId: "0/1", depth: 2, position: 2, setSize: 4 });
  assert.equal(visibleTreeRows(root, new Set()).length, 1);
  assert.equal(visibleTreeRows(root, new Set(), true).length, 21);
  assert.deepEqual(visibleTreeRows(null, new Set()), []);
});

test("revealing ancestors is immutable, exact and idempotent", () => {
  const root = createTree(13, "wide");
  root.children[10].children.push(makeNode("0/10/0"));
  const index = indexTree(root);
  const original = new Set(["0/1"]);
  const expanded = expandAncestors(index, original, "0/10/0");
  assert.deepEqual([...original], ["0/1"]);
  assert.deepEqual([...expanded].sort(), ["0", "0/1", "0/10"]);
  assert.equal(expandAncestors(index, expanded, "0/10/0"), expanded);
  assert.equal(expandAncestors(index, original, "missing"), original);
  assert.equal(expandAncestors(index, original, null), original);
});

test("collapsing a branch also clears every nested expansion", () => {
  const expanded = new Set(["0", "0/1", "0/1/0", "0/10"]);
  const collapsed = collapseTreeBranch(expanded, "0/1");
  assert.deepEqual([...collapsed].sort(), ["0", "0/10"]);
  assert.equal(collapseTreeBranch(collapsed, "0/1"), collapsed);
});

test("focus falls back to a visible ancestor without positional-prefix confusion", () => {
  const root = createTree(50);
  const index = indexTree(root);
  const visible = new Map(visibleTreeRows(root, new Set(["0"])).map((row, position) => [row.node.id, position]));
  assert.equal(nearestVisibleId("0/1/0", index, visible), "0/1");
  assert.equal(nearestVisibleId("missing", index, visible), null);
  assert.equal(nearestVisibleId("0/1/0", index, new Map()), null);
});

test("filter metadata describes retained siblings while index retains complete nodes", () => {
  const root = createTree(21);
  const filtered = filterTree(root, { query: "Node 6", interactiveOnly: false, identifiedOnly: false });
  const rows = visibleTreeRows(filtered, new Set(), true);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].setSize, 1);
  assert.equal(rows[2].position, 1);
  assert.equal(indexTree(root).get("0")!.node, root);
  assert.notEqual(filtered, root);
  assert.equal(root.children.length, 4);
});

test("deep trees can be indexed and revealed without recursive stack use", () => {
  const root = makeNode("deep-0");
  let parent = root;
  for (let i = 1; i < 20_000; i += 1) {
    const child = makeNode(`deep-${i}`, i);
    parent.children.push(child);
    parent = child;
  }
  const index = indexTree(root);
  const expanded = expandAncestors(index, new Set(), parent.id);
  const rows = visibleTreeRows(root, expanded);
  assert.equal(index.size, 20_000);
  assert.equal(rows.length, 20_000);
  assert.equal(rows[rows.length - 1].depth, 19_999);
});

test("virtual ranges clamp empty, negative and stale bottom scroll offsets", () => {
  assert.deepEqual(treeWindow(0, 9000, 450), { start: 0, end: 0, top: 0, totalHeight: 0, offset: 0 });
  assert.equal(treeWindow(3, -100, 450).top, 0);
  const top = treeWindow(25_000, 0, 450);
  assert.equal(top.start, 0);
  assert.equal(top.end, 21);
  const bottom = treeWindow(25_000, 1_000_000, 450);
  assert.equal(bottom.end, 25_000);
  assert.equal(bottom.top, 25_000 * TREE_ROW_HEIGHT - 450);
  assert.ok(bottom.end - bottom.start <= Math.ceil(450 / TREE_ROW_HEIGHT) + 16);
  assert.equal(treeWindow(5, bottom.top, 450).top, 0);
  assert.throws(() => treeWindow(5, 0, 450, 0));
});

test("every visible pixel has a mounted row at fractional offsets and viewport sizes", () => {
  for (const height of [300, 320, 450, 517.5]) {
    for (const offset of [0, 17.5, 32, 4567.8, 799_999]) {
      const range = treeWindow(25_000, offset, height);
      assert.ok(range.start * TREE_ROW_HEIGHT <= range.top);
      assert.ok(range.end * TREE_ROW_HEIGHT >= Math.min(range.totalHeight, range.top + height));
      assert.ok(range.end - range.start <= Math.ceil(height / TREE_ROW_HEIGHT) + 17);
    }
  }
});

test("row reveal scrolls minimally and clamps invalid or removed selections", () => {
  assert.equal(scrollToTreeRow(0, 1000, 1000, 320), 0);
  assert.equal(scrollToTreeRow(999, 1000, 0, 320), 35_680);
  assert.equal(scrollToTreeRow(4, 1000, 0, 320), 0);
  assert.equal(scrollToTreeRow(5000, 1000, 0, 320), 0);
  assert.equal(scrollToTreeRow(-1, 2, 10_000, 320), 0);
});
