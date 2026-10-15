import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { recoveryRouteFlags, recoveryRouteOptions, assertDefaultSdkResult, assertDefaultSdkStages } from "../scripts/small-recovery-route";

test("default recovery probe omits preference, and rejects conflicting flags", () => {
  assert.deepEqual(recoveryRouteOptions(true), {});
  assert.equal(Object.prototype.hasOwnProperty.call(recoveryRouteOptions(true), "preferVisibleSdk"), false);
  assert.deepEqual(recoveryRouteOptions(false), { preferVisibleSdk: true });
  assert.deepEqual(recoveryRouteFlags(["--default-route"]), { defaultRoute: true, requireTreeReady: false });
  assert.deepEqual(recoveryRouteFlags(["--require-tree-ready"]), { defaultRoute: false, requireTreeReady: true });
  for (const flags of [["--default-route", "--require-tree-ready"], ["--default-route", "--default-route"], ["--unknown"]])
    assert.throws(() => recoveryRouteFlags(flags));
  // Inspect the real healthy/cancel call option initializers, not an equivalent helper call.
  const source = ts.createSourceFile("probe.ts", readFileSync(new URL("../scripts/diagnostics/sdk/sdk-small-page-recovery-probe.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const objects: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "inspectPreferredDevice")
      objects.push(node.arguments[2] as ts.ObjectLiteralExpression);
    ts.forEachChild(node, visit);
  }; visit(source);
  assert.equal(objects.length, 2);
  for (const object of objects) {
    assert.ok(object.properties.some(prop => ts.isSpreadAssignment(prop) && prop.expression.getText(source) === "recoveryRouteOptions(defaultRoute)"));
    assert.ok(!object.properties.some(prop => ts.isPropertyAssignment(prop) && prop.name.getText(source) === "preferVisibleSdk"));
  }
});

const stages = ["导出属性", "SDK 抓取独立画面"];
const valid: any = { nodeCount: 98, attributes: { "sdk-visible-stream": "2", "sdk-ui-wake-version": "1", "sdk-visible-images": "70" },
  nodes: [{ encodedSha: "fixture", source: "SDK 独立图，不含子节点" }, { encodedSha: "supplement", source: "SDK 补图：独立图" }] };
test("default acceptance requires SDK image evidence and rejects compatibility batches", () => {
  assertDefaultSdkResult(valid, stages);
  for (const attributes of [{ "ddms-batch-layers": "0" }, { "ddms-batch-images": "71" }, { "ddms-batch-bytes": "1" },
    { "sdk-visible-stream": "1" }, { "sdk-ui-wake-version": undefined }, { "sdk-visible-images": "0" }])
    assert.throws(() => assertDefaultSdkResult({ ...valid, attributes: { ...valid.attributes, ...attributes } }, stages));
  for (const nodeCount of [0, 200, 500]) assert.throws(() => assertDefaultSdkResult({ ...valid, nodeCount }, stages));
  for (const source of [null, "DDMS 批量独立图", "SDK / DDMS"]) assert.throws(() => assertDefaultSdkResult({ ...valid, nodes: [{ encodedSha: "x", source }] }, stages));
  assert.throws(() => assertDefaultSdkResult({ ...valid, nodes: [] }, stages));
});
test("cancel route requires SDK stage and no DDMS image fallback", () => {
  assertDefaultSdkStages(stages);
  assert.throws(() => assertDefaultSdkStages(["DDMS 批量抓图"]));
  assert.throws(() => assertDefaultSdkStages([...stages, "DDMS 回退抓图"]));
});
