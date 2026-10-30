import { test } from "node:test";
import assert from "node:assert/strict";
import { makeNode } from "../benchmarks/fixtures";
import { findTreeSearchSuggestions, indexTreeSearchSuggestions, MAX_TREE_SEARCH_CANDIDATES_SCANNED, MAX_TREE_SEARCH_SUGGESTIONS } from "../src/features/inspection/tree-search-suggestions";

test("tree suggestions use snapshot text, resource IDs and classes, keeping categories distinct and exact names first", () => {
  const root = { ...makeNode("0"), text: null, className: null, resourceId: null };
  root.children = [
    { ...makeNode("0/0"), text: "提交按钮", resourceId: "app:id/submit_more", className: "app.SubmitButton" },
    { ...makeNode("0/1"), text: "提交", resourceId: "app:id/submit", className: "android.widget.Button" },
    { ...makeNode("0/2"), text: "提交", resourceId: "app:id/submit", className: "android.widget.Button" },
    { ...makeNode("0/3"), text: "<Button>", resourceId: null, className: "app.LongButton" },
  ];
  const source = JSON.stringify(root), index = indexTreeSearchSuggestions(root);
  assert.deepEqual(findTreeSearchSuggestions(index, "提交").items.map(item => [item.value, item.occurrences]), [["提交", 2], ["提交按钮", 1]]);
  assert.equal(findTreeSearchSuggestions(index, " SUBMIT ").items[0].value, "app:id/submit");
  assert.equal(findTreeSearchSuggestions(index, "Button").items[0].value, "android.widget.Button");
  assert.equal(findTreeSearchSuggestions(index, "<Button>").items[0].kind, "text");
  assert.equal(findTreeSearchSuggestions(index, "idontexist").items.length, 0);
  assert.equal(findTreeSearchSuggestions(index, " ").items.length, 0);
  assert.equal(JSON.stringify(root), source);
});

test("suggestion lookup caps work/results and finds exact late entries without re-reading the tree", () => {
  const root = { ...makeNode("0"), text: null, className: null, resourceId: null };
  root.children = Array.from({ length: 12_000 }, (_, i) => ({ ...makeNode(`0/${i}`), text: `prefix ${i} abxbc xyabc`, className: null, resourceId: null }));
  root.children.push({ ...makeNode("late"), text: "abcxy", className: null, resourceId: null });
  const index = indexTreeSearchSuggestions(root);
  Object.defineProperty(root, "children", { get() { throw new Error("Search traversed the source tree again"); } });
  assert.equal(findTreeSearchSuggestions(index, "prefix").items.length, MAX_TREE_SEARCH_SUGGESTIONS);
  assert.equal(findTreeSearchSuggestions(index, "abcxy").items[0].value, "abcxy");
  const broad = findTreeSearchSuggestions(index, "abxyabc");
  assert.ok(broad.scanned <= MAX_TREE_SEARCH_CANDIDATES_SCANNED);
  assert.equal(broad.limited, true);
  assert.equal(broad.items.length, 0);
});

test("a replacement root does not retain values from an earlier snapshot with reused node IDs", () => {
  const root = { ...makeNode("0"), text: "上一份快照的控件", resourceId: null, className: null };
  const old = indexTreeSearchSuggestions(root), next = indexTreeSearchSuggestions({ ...root, text: "新控件" });
  assert.equal(findTreeSearchSuggestions(old, "上一份").items.length, 1);
  assert.equal(findTreeSearchSuggestions(next, "上一份").items.length, 0);
  assert.equal(findTreeSearchSuggestions(next, "新").items[0].value, "新控件");
});
