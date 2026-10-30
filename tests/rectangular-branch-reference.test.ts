import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { rectangularBranchReference } from "../benchmarks/rectangular-branch-reference";

const node = (id: string, left = 0, top = 0, right = 100, bottom = 100) => ({ ...makeNode(id),
  bounds: { left, top, right, bottom, raw: "" }, layerImageDataUrl: "test", layerImageSize: { width: right - left, height: bottom - top },
  attributes: {} as Record<string, string> });

test("rectangular reference clips descendants to parent rather than child's rectangle", () => {
  const root = node("0"), parent = node("0/0", 20, 10, 80, 90), child = node("0/0/0", 0, 0, 100, 100);
  root.children = [parent]; parent.children = [child]; parent.attributes["clip-children"] = "true";
  assert.deepEqual(rectangularBranchReference(root).map(e => e.clip), [
    { left: 0, top: 0, right: 100, bottom: 100 }, { left: 0, top: 0, right: 100, bottom: 100 },
    { left: 20, top: 10, right: 80, bottom: 90 }]);
});

test("padding clips children, not parent own; nested intersections and empty clips survive", () => {
  const root = node("0"), parent = node("0/0", 10, 10, 90, 90), child = node("0/0/0", 0, 0, 100, 100);
  root.children = [parent]; parent.children = [child];
  root.attributes = { "clip-to-padding": "true", "padding-left": "20", "padding-top": "30", "padding-right": "25", "padding-bottom": "15" };
  parent.attributes = { "clip-to-padding": "true", "padding-left": "80", "padding-top": "0", "padding-right": "0", "padding-bottom": "0" };
  const entries = rectangularBranchReference(root);
  assert.deepEqual(entries[0].clip, { left: 0, top: 0, right: 100, bottom: 100 });
  assert.deepEqual(entries[1].clip, { left: 20, top: 30, right: 75, bottom: 85 });
  assert.deepEqual(entries[2].clip, { left: 90, top: 30, right: 90, bottom: 85 });
});

test("zero padding without clip-children leaves overflow visible and hidden subtrees excluded", () => {
  const root = node("0"), parent = node("0/0", 20, 20, 80, 80), child = node("0/0/0");
  root.children = [parent]; parent.children = [child];
  parent.attributes = { "clip-to-padding": "true", "padding-left": "0", "padding-top": "0", "padding-right": "0", "padding-bottom": "0" };
  assert.deepEqual(rectangularBranchReference(root)[2].clip, { left: 0, top: 0, right: 100, bottom: 100 });
  parent.visibleToUser = false;
  assert.deepEqual(rectangularBranchReference(root).map(e => e.node.id), ["0"]);
});

test("missing padding, transforms, opacity and unknown clip flags fail closed", () => {
  const cases: Record<string, string>[] = [{ "clip-to-padding": "true" }, { "rotation": "5" }, { alpha: "0.5" }, { "clip-children": "unknown" }, { "clip-to-outline": "true" }];
  for (const attrs of cases) {
    const root = node("0"); root.children = [node("0/0")]; root.attributes = attrs;
    assert.throws(() => rectangularBranchReference(root));
  }
  for (const value of ["", "NaN", "-1"]) {
    const root = node("0"); root.children = [node("0/0")];
    root.attributes = { "clip-to-padding": "true", "padding-left": value, "padding-top": "0", "padding-right": "0", "padding-bottom": "0" };
    assert.throws(() => rectangularBranchReference(root), /padding evidence/);
  }
});
