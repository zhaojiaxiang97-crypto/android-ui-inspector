import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { evaluateDebugTaskConditions } from "../shared/debug-task-checker";
import type { DebugTaskCondition, DebugTaskEvidence } from "../shared/debug-task";

const packageName = "com.example.task";
const condition = (state: DebugTaskCondition["state"] = "visible", text = "完成", id = state): DebugTaskCondition =>
  ({ id, selector: { text }, state });
function evidence(offset = 0): DebugTaskEvidence {
  const root = makeNode("0"), node = makeNode("0/0");
  root.package = node.package = packageName; root.children = [node]; node.text = "完成";
  node.bounds = { left: 10, top: 10, right: 40, bottom: 40, raw: "[10,10][40,40]" };
  node.enabled = node.visibleToUser = true; root.visibleToUser = false;
  const frame = { width: 100, height: 100, rotation: 0 as const };
  return { observation: { snapshotId: randomUUID(), capturedAt: new Date(1_700_000_000_000 + offset).toISOString(),
    component: `${packageName}/.Main`, windowId: "window", activityRecordId: "activity" }, snapshot: {
    serial: "fixture", root, nodeCount: 2, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null,
    captureMode: "fast", inspectionSource: "uiautomator", hierarchyDumpMode: "full",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 },
  } };
}
const evaluate = (a: DebugTaskEvidence | null, b: DebugTaskEvidence | null, conditions = [condition()]) =>
  evaluateDebugTaskConditions(conditions, a, b, packageName);

test("task checker deterministically proves only declared visible/enabled/disabled/absent page conditions", () => {
  const a = evidence(), b = evidence(350);
  for (const item of [a, b]) {
    const disabled = makeNode("0/1"); disabled.package = packageName; disabled.text = "未启用";
    disabled.visibleToUser = true; disabled.enabled = false; disabled.bounds = item.snapshot.root!.children[0].bounds;
    item.snapshot.root!.children.push(disabled); item.snapshot.nodeCount++;
  }
  const originals = JSON.stringify([a, b]);
  const result = evaluate(a, b, [condition(), condition("enabled"), condition("disabled", "未启用"), condition("absent", "错误")]);
  assert.equal(result.status, "passed"); assert.equal(result.conditions.length, 4);
  assert.ok(result.conditions.every(item => item.status === "passed"));
  assert.deepEqual(result.conditions[0], { conditionId: "visible", status: "passed", reason: "两次新观察均满足此页面条件。",
    firstMatchCount: 1, secondMatchCount: 1, firstNodeId: "0/0", secondNodeId: "0/0" });
  assert.equal(JSON.stringify([a, b]), originals);
});

test("two false observations fail, while disagreement and mixed incomplete evidence cannot pass or claim a definite failure", () => {
  const a = evidence(), b = evidence(350);
  assert.equal(evaluate(a, b, [condition("visible", "缺少")]).status, "failed");
  assert.equal(evaluate(a, b, [condition("disabled")]).status, "failed");
  assert.equal(evaluate(a, b, [condition("absent")]).status, "failed");
  b.snapshot.root!.children[0].enabled = false;
  const result = evaluate(a, b, [condition("visible", "缺少"), condition("enabled")]);
  assert.deepEqual(result.conditions.map(item => item.status), ["failed", "insufficient_evidence"]);
  assert.equal(result.status, "insufficient_evidence");
});

test("positive conditions require one visible screen intersection; duplicate eligible matches are insufficient", () => {
  const a = evidence(), b = evidence(350);
  const duplicate = structuredClone(b.snapshot.root!.children[0]); duplicate.id = "0/1";
  b.snapshot.root!.children.push(duplicate); b.snapshot.nodeCount++;
  assert.equal(evaluate(a, b).status, "insufficient_evidence");
  assert.equal(evaluate(a, b).conditions[0].secondMatchCount, 2);
  duplicate.visibleToUser = false; assert.equal(evaluate(a, b).status, "passed");
  for (const item of [a, b]) item.snapshot.root!.children[0].bounds = { left: 100, top: 0, right: 110, bottom: 10, raw: "offscreen" };
  assert.equal(evaluate(a, b).status, "failed");
  assert.equal(evaluate(a, b).conditions[0].firstMatchCount, 0);
  a.snapshot.root!.children[0].bounds!.left = 99; b.snapshot.root!.children[0].bounds!.left = 99;
  assert.equal(evaluate(a, b).status, "passed");
});

test("absence cannot be proved by compressed or unspecified dump coverage", () => {
  for (const mode of ["compressed", undefined] as const) {
    const a = evidence(), b = evidence(350); b.snapshot.hierarchyDumpMode = mode;
    const result = evaluate(a, b, [condition(), condition("absent", "不存在")]);
    assert.equal(result.conditions[0].status, "passed"); assert.equal(result.conditions[1].status, "insufficient_evidence");
    assert.equal(result.status, "insufficient_evidence");
  }
});

test("a matching visible node with unknown bounds cannot prove absence or a positive condition", () => {
  for (const bounds of [null, { left: 5, top: 5, right: 5, bottom: 10, raw: "empty" }]) {
    const a = evidence(), b = evidence(350);
    a.snapshot.root!.children[0].bounds = bounds; b.snapshot.root!.children[0].bounds = bounds;
    for (const state of ["visible", "absent", "enabled", "disabled"] as const) {
      const result = evaluate(a, b, [condition(state)]);
      assert.equal(result.status, "insufficient_evidence"); assert.equal(result.conditions[0].firstMatchCount, 1);
    }
  }
});

test("trees exceeding 20000 nodes do not create report fields outside the evidence schema", () => {
  const a = evidence(), b = evidence(350);
  b.snapshot.root!.children = Array.from({ length: 20_000 }, (_, index) => {
    const node = makeNode(`0/${index}`); node.package = packageName; node.text = "完成";
    node.visibleToUser = true; node.bounds = a.snapshot.root!.children[0].bounds; return node;
  });
  b.snapshot.nodeCount = 20_001;
  const result = evaluate(a, b);
  assert.equal(result.status, "insufficient_evidence"); assert.equal(result.conditions[0].secondMatchCount, 0);
});

test("both observations must have stable authorized scope, source, activity and checked display geometry", () => {
  const changes: ((item: DebugTaskEvidence) => void)[] = [
    item => { item.snapshot.serial = "other"; }, item => { item.snapshot.root!.package = "other"; },
    item => { item.observation.component = "com.other.app/.Main"; }, item => { item.observation.windowId = "other"; },
    item => { item.observation.activityRecordId = "other"; }, item => { item.observation.activityRecordId = null; },
    item => { item.snapshot.inspectionSource = "accessibility-helper"; }, item => { item.snapshot.inspectionSource = undefined; },
    item => { item.snapshot.captureMode = "deep"; }, item => { item.snapshot.captureGeometry = undefined; },
    item => { item.snapshot.captureGeometry!.hierarchyRotation = null; }, item => { item.snapshot.error = "capture failed"; },
    item => { const frame = { width: 200, height: 100, rotation: 0 as const };
      item.snapshot.captureGeometry = { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 }; },
  ];
  for (const change of changes) {
    const a = evidence(), b = evidence(350); change(b);
    assert.equal(evaluate(a, b).status, "insufficient_evidence");
  }
});

test("reused IDs, reversed time, incomplete trees, duplicate IDs and a missing observation remain insufficient", () => {
  for (const change of [
    (a: DebugTaskEvidence, b: DebugTaskEvidence) => { b.observation.snapshotId = a.observation.snapshotId; },
    (a: DebugTaskEvidence, b: DebugTaskEvidence) => { b.observation.capturedAt = a.observation.capturedAt; },
    (_a: DebugTaskEvidence, b: DebugTaskEvidence) => { b.observation.capturedAt = new Date(0).toISOString(); },
    (_a: DebugTaskEvidence, b: DebugTaskEvidence) => { b.snapshot.nodeCount++; },
    (_a: DebugTaskEvidence, b: DebugTaskEvidence) => { b.snapshot.root!.children[0].id = "0"; },
  ]) {
    const a = evidence(), b = evidence(350); change(a, b);
    assert.equal(evaluate(a, b).status, "insufficient_evidence");
  }
  const a = evidence();
  assert.equal(evaluate(a, null).conditions.length, 1);
  assert.equal(evaluate(a, null).status, "insufficient_evidence");
  assert.equal(evaluate(null, null).status, "insufficient_evidence");
});
