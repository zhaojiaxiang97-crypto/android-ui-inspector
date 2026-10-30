import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore -- Node probe helper is intentionally plain JS.
import { descendantPlaneIds, branchChildrenRemoved, visibleNativeBranchIds } from "../scripts/lib/layer-branch-check";

test("only displayed descendants qualify, not the parent or adjacent sibling IDs", () => {
  assert.deepEqual(descendantPlaneIds("0/1", [{ id: "0/1" }, { id: "0/1/2" }, { id: "0/10/2" }, { id: "0/1/2/3" }]), ["0/1/2", "0/1/2/3"]);
});
test("same plane count after replacement still proves child removal", () => {
  assert.equal(branchChildrenRemoved(["0/1/2"], [{ id: "0/1" }, { id: "0/9" }]), true);
  assert.equal(branchChildrenRemoved(["0/1/2"], [{ id: "0/1/2" }]), false);
});
test("an empty branch never passes a fold assertion", () => {
  assert.equal(branchChildrenRemoved([], []), false);
});

test("native branch candidates come from scene planes, not virtualized tree rows", () => {
  assert.deepEqual(visibleNativeBranchIds([{ id: "0/1", mode: "none" }, { id: "0/1/0", mode: "native" }, { id: "0/2", mode: "none" }, { id: "0/2/0", mode: "isolated" }]), ["0/1"]);
  assert.deepEqual(visibleNativeBranchIds([{ id: "0/1/0", mode: "native" }]), []);
});
