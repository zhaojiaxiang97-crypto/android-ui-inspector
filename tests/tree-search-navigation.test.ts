import type { UiNode } from "../shared/types";
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode as fixtureNode } from "../benchmarks/fixtures";
import { stepTreeSearchMatch, treeSearchMatches, treeSearchShortcut } from "../shared/tree-search-navigation";

const makeNode = (id: string): UiNode => ({ ...fixtureNode(id), text: null, resourceId: null, contentDesc: null, clickable: false, focusable: false, scrollable: false });
const filter = { query: "target", interactiveOnly: false, identifiedOnly: false };
test("match traversal excludes retained ancestors and preserves the original nodes in preorder", () => {
  const root = makeNode("0"), group = makeNode("0/0"), a = makeNode("0/0/0"), b = makeNode("0/1"), c = makeNode("0/2");
  root.children = [group, b, c]; group.children = [a]; a.text = "target"; b.resourceId = "app:id/target"; c.className = "custom.Target";
  const matches = treeSearchMatches(root, filter);
  assert.deepEqual(matches, [a, b, c]); assert.equal(matches[0], a);
  assert.equal(stepTreeSearchMatch(matches, root, -1), a);
  assert.equal(stepTreeSearchMatch(matches, a, -1), c);
  assert.equal(stepTreeSearchMatch(matches, c, 1), a);
  assert.equal(stepTreeSearchMatch(matches, { ...a }, 1), a);
  assert.equal(stepTreeSearchMatch([], a, 1), null);
  b.clickable = false; a.clickable = true; c.clickable = false;
  assert.deepEqual(treeSearchMatches(root, { ...filter, interactiveOnly: true }), [a]);
  assert.deepEqual(treeSearchMatches(group, filter), [a]);
});

test("tree search remains iterative at 512 levels and counts 25k repeated text matches", () => {
  const root = makeNode("root"); let parent = root;
  for (let i = 0; i < 511; i++) { const child = makeNode(`deep-${i}`); parent.children = [child]; parent = child; }
  parent.text = "target";
  assert.deepEqual(treeSearchMatches(root, filter), [parent]);
  root.children = Array.from({ length: 25_000 }, (_, i) => ({ ...makeNode(`wide-${i}`), text: "target" }));
  assert.equal(treeSearchMatches(root, filter).length, 25_000);
});

test("search shortcuts require one command modifier and honor reverse traversal", () => {
  const event = { key: "g", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  assert.equal(treeSearchShortcut(event), null);
  assert.equal(treeSearchShortcut({ ...event, ctrlKey: true }), 1);
  assert.equal(treeSearchShortcut({ ...event, metaKey: true, shiftKey: true, key: "G" }), -1);
  assert.equal(treeSearchShortcut({ ...event, metaKey: true, ctrlKey: true }), null);
  assert.equal(treeSearchShortcut({ ...event, ctrlKey: true, altKey: true }), null);
});
