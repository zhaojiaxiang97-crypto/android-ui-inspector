import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { manuallyHiddenAncestor } from "../shared/tree-hidden-state";
import { indexTree } from "../shared/visible-tree";

test("hidden reason uses actual nearest ancestors without confusing the selected item or a sibling", () => {
  const root = makeNode("opaque-root"), parent = makeNode("opaque-parent"), child = makeNode("opaque-child"), sibling = makeNode("opaque-sibling");
  root.children = [parent, sibling]; parent.children = [child];
  const index = indexTree(root), hidden = new Set([root.id, parent.id, child.id, sibling.id]);
  assert.equal(manuallyHiddenAncestor(index, child, hidden), parent);
  assert.equal(manuallyHiddenAncestor(index, parent, hidden), root);
  assert.equal(manuallyHiddenAncestor(index, root, hidden), null);
  assert.equal(manuallyHiddenAncestor(index, { ...child }, hidden), null);
  hidden.delete(parent.id); assert.equal(manuallyHiddenAncestor(index, child, hidden), root);
  hidden.delete(root.id); assert.equal(manuallyHiddenAncestor(index, child, hidden), null);
});
