import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { parseTreeRowMode, treeRowSubtitle } from "../shared/tree-row-mode";

test("tree density preference accepts only supported modes", () => {
  for (const value of [null, undefined, {}, "DETAIL", "detailed ", true, "<script>"]) assert.equal(parseTreeRowMode(value), null);
  assert.equal(parseTreeRowMode("compact"), "compact");
  assert.equal(parseTreeRowMode("detailed"), "detailed");
});

test("detailed rows prefer existing ID, use type fallback and avoid repeating the name", () => {
  const node = { ...makeNode("0"), text: "同名控件", resourceId: "app:id/long_identifier_尾部", className: "android.widget.TextView" };
  assert.deepEqual(treeRowSubtitle(node), { text: node.resourceId, resource: true });
  assert.deepEqual(treeRowSubtitle({ ...node, resourceId: null }), { text: node.className, resource: false });
  assert.deepEqual(treeRowSubtitle({ ...node, text: null, contentDesc: null }), { text: node.className, resource: false });
  assert.equal(treeRowSubtitle({ ...node, text: "TextView", resourceId: null }), null);
  assert.equal(treeRowSubtitle({ ...node, text: null, contentDesc: null, resourceId: null, className: null }), null);
  assert.equal(node.text, "同名控件");
});
