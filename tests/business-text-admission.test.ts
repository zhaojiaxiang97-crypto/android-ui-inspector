import { test } from "node:test";
import assert from "node:assert/strict";
import { businessTextAdmission } from "../scripts/business-text-admission";
const fixture = () => ({ pid: 42, processInstance: "instance", refDebugCanvasVersion: 1,
  uiWakeVersion: 1, branchGeometryVersion: 1,
  root: { children: [{ text: "设置", ref: "TextView@1", className: "custom.EmojiTextView", hardwareAccelerated: true, children: [] }] } });
test("business admission requires real current SDK capabilities and explicit acceleration", () => {
  assert.equal(businessTextAdmission(fixture(), "设置", 42).eligible, true);
  for (const key of ["uiWakeVersion", "refDebugCanvasVersion", "branchGeometryVersion"]) {
    for (const value of [undefined, 0, 2, "1"]) {
      const tree: any = fixture(); tree[key] = value;
      assert.equal(businessTextAdmission(tree, "设置", 42).eligible, false);
    }
  }
  for (const value of [undefined, false, "true"]) {
    const tree: any = fixture(); tree.root.children[0].hardwareAccelerated = value;
    assert.equal(businessTextAdmission(tree, "设置", 42).eligible, false);
  }
});
test("business admission rejects changed identity, ambiguous targets and containers", () => {
  assert.equal(businessTextAdmission(fixture(), "设置", 43).eligible, false);
  assert.equal(businessTextAdmission(fixture(), "不存在", 42).eligible, false);
  const duplicate = fixture(); duplicate.root.children.push(duplicate.root.children[0]);
  assert.equal(businessTextAdmission(duplicate, "设置", 42).eligible, false);
  const container: any = fixture(); container.root.children[0].children = [{}];
  assert.equal(businessTextAdmission(container, "设置", 42).eligible, false);
  const noIdentity = fixture(); noIdentity.processInstance = "";
  assert.equal(businessTextAdmission(noIdentity, "设置", 42).eligible, false);
});
