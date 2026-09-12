import assert from "node:assert/strict";
import { test } from "node:test";
import { createTree, makeNode } from "../benchmarks/fixtures";
import { filterTree, flattenNodes, selectionInBranch, type TreeFilter } from "../shared/tree-utils";

const noFilter: TreeFilter = { query: "", interactiveOnly: false, identifiedOnly: false };

test("fixture sizes and flattened preorder are deterministic", () => {
  for (const size of [1, 1_000, 25_000]) {
    for (const shape of ["balanced", "wide"] as const) {
      assert.equal(flattenNodes(createTree(size, shape)).size, size);
    }
  }
  assert.deepEqual([...flattenNodes(createTree(7)).keys()], ["0", "0/0", "0/0/0", "0/0/1", "0/1", "0/2", "0/3"]);
});

test("no filter and all-matching filters preserve node references", () => {
  const root = createTree(100);
  assert.equal(filterTree(root, noFilter), root);
  assert.equal(filterTree(root, { ...noFilter, query: "  ANDROID.  " }), root);
});

test("sparse search keeps ancestors, sibling order and original tree", () => {
  const root = createTree(10);
  const before = JSON.stringify(root);
  const first = root.children[0].children[0];
  const second = root.children[1].children[0];
  first.text = "unique match";
  second.contentDesc = "unique match";
  const expectedOriginal = JSON.stringify(root);
  const filtered = filterTree(root, { ...noFilter, query: "UNIQUE MATCH" });
  assert.ok(filtered);
  assert.deepEqual([...flattenNodes(filtered).keys()], ["0", "0/0", first.id, "0/1", second.id]);
  assert.equal(filtered.children[0].children[0], first);
  assert.equal(JSON.stringify(root), expectedOriginal);
  assert.notEqual(before, expectedOriginal);
});

test("parent matches do not automatically retain unrelated descendants", () => {
  const root = createTree(6);
  root.text = "only-parent";
  assert.deepEqual(filterTree(root, { ...noFilter, query: "only-parent" })?.children, []);
  assert.equal(filterTree(root, { ...noFilter, query: "no-such-node" }), null);
});

test("query, interactive and identified filters combine on the same node", () => {
  const root = makeNode("0");
  root.text = null;
  root.resourceId = null;
  root.contentDesc = null;
  root.clickable = root.focusable = root.scrollable = false;
  const child = makeNode("0/0", 1);
  child.text = "wanted";
  root.children.push(child);
  assert.equal(filterTree(root, { query: "wanted", interactiveOnly: true, identifiedOnly: true }), null);
  child.scrollable = true;
  assert.equal(filterTree(root, { query: "wanted", interactiveOnly: true, identifiedOnly: true }), root);
  child.text = null;
  assert.equal(filterTree(root, { ...noFilter, identifiedOnly: true }), null);
});

test("deep input is traversed without recursive stack overflow", () => {
  const root = makeNode("deep-0");
  let parent = root;
  for (let index = 1; index < 20_000; index += 1) {
    const child = makeNode(`deep-${index}`, index);
    parent.children.push(child);
    parent = child;
  }
  parent.text = "deepest-match";
  assert.equal(flattenNodes(root).size, 20_000);
  assert.equal(filterTree(root, { ...noFilter, query: "deepest-match" }), root);
  assert.equal(filterTree(root, { ...noFilter, query: "no-such-node" }), null);
});

test("selection invalidates only its exact slash-separated branch", () => {
  assert.equal(selectionInBranch("0/1", "0/1"), "0/1");
  assert.equal(selectionInBranch("0/1", "0/1/2"), "0/1/2");
  assert.equal(selectionInBranch("0/1", "0/10/2"), null);
  assert.equal(selectionInBranch("0/1/2", "0/1"), null);
  assert.equal(selectionInBranch("0/1", null), null);
});
