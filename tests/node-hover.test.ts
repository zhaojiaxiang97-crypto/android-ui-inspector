import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodeHoverStore, resolveVisibleHoverId, treeHoverGuide } from "../shared/node-hover";
import { indexTree, TREE_ROW_HEIGHT, visibleTreeRows } from "../shared/visible-tree";
import { createTree } from "../benchmarks/fixtures";

test("hover notifications are bounded by actual node/source changes", () => {
  const validIds = new Set(["0", "0/1"]);
  const store = createNodeHoverStore(validIds);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  assert.equal(store.getSnapshot(), null);
  assert.equal(store.getServerSnapshot(), null);
  store.publishHover("0/1", "tree");
  const first = store.getSnapshot();
  for (let move = 0; move < 1000; move++) store.publishHover("0/1", "tree");
  assert.equal(store.getSnapshot(), first);
  assert.equal(notifications, 1);
  store.publishHover("0/1", "canvas");
  assert.equal(notifications, 2);
  assert.deepEqual(store.getSnapshot(), { nodeId: "0/1", source: "canvas" });
  unsubscribe();
  store.clearHover("canvas");
  assert.equal(notifications, 2);
});

test("old leaves and invalid IDs only clear their matching source", () => {
  const store = createNodeHoverStore(["0", "0/1"]);
  store.publishHover("0/1", "tree");
  store.publishHover("0", "canvas");
  store.clearHover("tree");
  store.publishHover(null, "tree");
  store.publishHover("removed", "tree");
  assert.deepEqual(store.getSnapshot(), { nodeId: "0", source: "canvas" });
  store.publishHover("removed", "canvas");
  assert.equal(store.getSnapshot(), null);
  store.publishHover("0/1", "tree");
  store.clearHover("canvas");
  assert.deepEqual(store.getSnapshot(), { nodeId: "0/1", source: "tree" });
});

test("session disposal disables retained callbacks and membership is copied", () => {
  const ids = new Set(["0", "0/1"]);
  const old = createNodeHoverStore(ids);
  const publishOld = old.publishHover;
  ids.add("late-node");
  old.publishHover("late-node", "tree");
  assert.equal(old.getSnapshot(), null);
  publishOld("0/1", "tree");
  old.deactivate();
  const next = createNodeHoverStore(["0", "0/2"]);
  next.publishHover("0/2", "canvas");
  publishOld("0/1", "canvas");
  assert.equal(old.getSnapshot(), null);
  assert.deepEqual(next.getSnapshot(), { nodeId: "0/2", source: "canvas" });
});

test("visible canvas fallback respects complete parent paths and focused roots", () => {
  const visible = new Set(["0", "0/1", "0/10"]);
  assert.equal(resolveVisibleHoverId("0/10/3/2", visible), "0/10");
  assert.equal(resolveVisibleHoverId("0/100/3", visible), "0");
  assert.equal(resolveVisibleHoverId("0/1", visible), "0/1");
  const focused = new Set(["0/10", "0/10/2"]);
  assert.equal(resolveVisibleHoverId("0/10/2/4", focused), "0/10/2");
  assert.equal(resolveVisibleHoverId("0/1/0", focused), null);
  assert.equal(resolveVisibleHoverId(null, visible), null);
  assert.equal(resolveVisibleHoverId("outside/1", visible), null);
});

test("visible canvas fallback follows actual parents for imported arbitrary IDs", () => {
  const parents = new Map<string, string | null>([["root", null], ["branch", "root"], ["leaf/foreign", "branch"], ["sibling", "root"]]);
  assert.equal(resolveVisibleHoverId("leaf/foreign", new Set(["root", "branch"]), parents), "branch");
  assert.equal(resolveVisibleHoverId("sibling", new Set(["branch"]), parents), null);
  assert.equal(resolveVisibleHoverId("removed", new Set(["root"]), parents), null);
  assert.equal(resolveVisibleHoverId("leaf/foreign", new Set(["root"]), parents, new Set(["branch"])), null);
  assert.equal(resolveVisibleHoverId("leaf/foreign", new Set(["leaf/foreign"]), parents, new Set(["branch"])), "leaf/foreign");
});

test("tree guides connect only the hovered row to its immediate parent", () => {
  const root = createTree(21);
  const index = indexTree(root);
  const rows = visibleTreeRows(root, new Set(), true);
  const positions = new Map(rows.map((row, position) => [row.node.id, position]));
  const guide = treeHoverGuide(index, positions, "0/1/2", 0, rows.length)!;
  assert.equal(guide.nodeId, "0/1/2");
  assert.equal(guide.parentId, "0/1");
  assert.equal(guide.childY, positions.get("0/1/2")! * TREE_ROW_HEIGHT + TREE_ROW_HEIGHT / 2);
  assert.equal(guide.parentX, 29);
  assert.equal(guide.childX, 41);
  assert.equal(treeHoverGuide(index, positions, "0", 0, rows.length), null);
  assert.equal(treeHoverGuide(index, positions, "removed", 0, rows.length), null);
  const collapsed = new Map(visibleTreeRows(root, new Set(["0"])).map((row, position) => [row.node.id, position]));
  assert.equal(treeHoverGuide(index, collapsed, "0/1/2", 0, collapsed.size), null);
});

test("virtual guides are clipped and omitted for offscreen hovered rows", () => {
  const root = createTree(25_000, "wide");
  const index = indexTree(root);
  const positions = new Map(visibleTreeRows(root, new Set(["0"])).map((row, position) => [row.node.id, position]));
  const guide = treeHoverGuide(index, positions, "0/19999", 19990, 20020)!;
  assert.equal(guide.top, 19990 * TREE_ROW_HEIGHT);
  assert.equal(guide.height, 30 * TREE_ROW_HEIGHT);
  assert.equal(guide.parentVisible, false);
  assert.match(guide.path, /^M 17 0 V /);
  assert(guide.childY > 0 && guide.childY < guide.height);
  assert.equal(treeHoverGuide(index, positions, "0/1", 19990, 20020), null);
  assert.equal(treeHoverGuide(index, positions, "0/19999", 20, 20), null);
});

test("deep parent and child guides retain separate indentation columns", () => {
  const root = createTree(1);
  let parent = root;
  for (let depth = 1; depth <= 24; depth++) {
    const child = { ...root, id: `${parent.id}/0`, children: [] };
    parent.children = [child]; parent = child;
  }
  const index = indexTree(root), rows = visibleTreeRows(root, new Set(), true);
  const positions = new Map(rows.map((row, position) => [row.node.id, position]));
  const guide = treeHoverGuide(index, positions, parent.id, 0, rows.length)!;
  assert.equal(guide.parentX, 293);
  assert.equal(guide.childX, 305);
  assert.match(guide.path, /H 300$/);
});

test("deactivation clears once and StrictMode activation remains usable", () => {
  const store = createNodeHoverStore(["0"]);
  let notifications = 0;
  store.subscribe(() => notifications++);
  store.publishHover("0", "canvas");
  store.deactivate();
  store.deactivate();
  assert.equal(notifications, 2);
  store.publishHover("0", "tree");
  assert.equal(store.getSnapshot(), null);
  store.activate();
  store.publishHover("0", "tree");
  assert.deepEqual(store.getSnapshot(), { nodeId: "0", source: "tree" });
});

test("detailed hover guides follow the explicit row height", () => {
  const root = createTree(25_000, "wide"), index = indexTree(root);
  const positions = new Map(visibleTreeRows(root, new Set([root.id])).map((row, position) => [row.node.id, position]));
  const guide = treeHoverGuide(index, positions, "0/19999", 19990, 20020, 44)!;
  assert.equal(guide.top, 19990 * 44);
  assert.equal(guide.height, 30 * 44);
  assert.equal(guide.childY, (positions.get("0/19999")! - 19990) * 44 + 22);
  assert(guide.childY > 0 && guide.childY < guide.height);
});
