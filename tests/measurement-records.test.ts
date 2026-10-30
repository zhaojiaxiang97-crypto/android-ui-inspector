import assert from "node:assert/strict";
import { test } from "node:test";
import { measurementRecords } from "../src/features/layers/useLayerMeasurement";
import type { UiNode } from "../shared/types";
import { makeNode } from "../benchmarks/fixtures";

test("bounds-only measurements preserve visible descendants without independent images", () => {
  const root = makeNode("root"), branch = makeNode("branch"), child = makeNode("child"), missing = { ...makeNode("missing"), bounds: null };
  root.children = [branch, missing]; branch.children = [child];
  const original = JSON.stringify(root);
  assert.deepEqual(measurementRecords(root, new Set()).map(value => value.id), ["root", "branch", "child"]);
  // Hiding a single presentation layer does not hide its expanded children.
  assert.deepEqual(measurementRecords(root, new Set(["branch"])).map(value => value.id), ["root", "child"]);
  assert.equal(JSON.stringify(root), original);
});

test("device-invisible ancestors exclude all descendants from measurement", () => {
  for (const patch of [{ visibleToUser: false }, { attributes: { alpha: "0" } }, { attributes: { "effective-alpha": "0" } }] as Partial<UiNode>[]) {
    const root = makeNode("root"), branch = { ...makeNode("branch"), ...patch }, child = makeNode("child");
    root.children = [branch]; branch.children = [child];
    assert.deepEqual(measurementRecords(root, new Set()).map(value => value.id), ["root"]);
  }
});

test("focus restricts measurements to the current branch or single layer", () => {
  const root = makeNode("root"), branch = makeNode("branch"), child = makeNode("child"), sibling = makeNode("sibling");
  root.children = [branch, sibling]; branch.children = [child];
  assert.deepEqual(measurementRecords(root, new Set(), { node: branch, kind: "branch" }).map(value => value.id), ["branch", "child"]);
  assert.deepEqual(measurementRecords(root, new Set(), { node: branch, kind: "layer" }).map(value => value.id), ["branch"]);
});
