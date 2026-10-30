import { test } from "node:test";
import assert from "node:assert/strict";
import { debugTreeBranchCopyValue } from "../src/features/inspection/debug-tree-reading";
import { debugFieldCopyValue, isDebugMetadata, type DebugTreeNode } from "../shared/debug-metadata";

test("independent reader branch copying retains ordered keys, types, descendants and complete Unicode values", () => {
  const branch: DebugTreeNode = { key: "root", label: "同名", type: "string", value: "{不是JSON：🦊}", children: [
    { key: "empty", label: "同名", type: "string", value: "", children: [] },
    { key: "zero", label: "同名", type: "number", value: 0, children: [] },
    { key: "off", label: "同名", type: "boolean", value: false, children: [] },
    { key: "nil", label: "同名", type: "null", value: null, children: [] },
  ] };
  const before = JSON.stringify(branch), copied = debugTreeBranchCopyValue(branch);
  assert.equal(copied, before);
  assert.deepEqual(JSON.parse(copied), branch);
  assert.equal(debugFieldCopyValue(branch), "{不是JSON：🦊}");
  assert(isDebugMetadata({ version: 2, source: "debug-sdk-explicit", status: "captured", groups: [{ key: "state", label: "页面状态", fields: [{ key: "tree", label: "分层信息", type: "tree", value: [branch] }] }] }));
  assert.equal(JSON.stringify(branch), before);
});
