import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { compareCaptureSources } from "../shared/capture-source-comparison";
import type { InspectionSource, UiSnapshot } from "../shared/types";

function snapshot(source: InspectionSource, serial = "fixture"): UiSnapshot {
  const root = makeNode("root", 0);
  const first = makeNode("first", 5), second = makeNode("second", 10);
  root.children = [first, second];
  return { serial, root, nodeCount: 3, xmlSize: 0, rawXml: null, screenshotDataUrl: null,
    error: null, warning: null, inspectionSource: source };
}
test("unique resource IDs detect meaningful cross-source deviations without leaking labels", () => {
  const left = snapshot("uiautomator"), right = snapshot("accessibility-helper");
  right.root!.children[0].visibleToUser = false;
  right.root!.children[0].bounds!.left = 5;
  right.root!.children.pop();
  const result = compareCaptureSources(left, right);
  assert.equal(result.left.nodes, 3);
  assert.equal(result.right.nodes, 2);
  assert.equal(result.pairedUniqueResourceIds, 2);
  assert.equal(result.onlyLeftUniqueResourceIds, 1);
  assert.equal(result.visibleMismatch, 1);
  assert.equal(result.boundsMismatch, 1);
  assert.equal(result.actionIdentity, "new-verified-same-source-observation-required");
  assert.equal(JSON.stringify(result).includes("com.example.benchmark:id/item_5"), false);
});
test("duplicates are ambiguous and never accepted as unique controls", () => {
  const left = snapshot("uiautomator"), right = snapshot("debug-view");
  left.root!.children[1].resourceId = left.root!.children[0].resourceId;
  const result = compareCaptureSources(left, right);
  assert.equal(result.left.ambiguousResourceIds, 1);
  assert.equal(result.pairedUniqueResourceIds, 1);
  assert.equal(result.onlyRightUniqueResourceIds, 2);
});
test("same backend and mismatched device are ineligible for cross-source comparison", () => {
  assert.throws(() => compareCaptureSources(snapshot("uiautomator"), snapshot("uiautomator")));
  assert.throws(() => compareCaptureSources(snapshot("uiautomator"), snapshot("debug-view", "other")));
});
