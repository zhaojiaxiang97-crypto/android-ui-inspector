import assert from "node:assert/strict";
import { test } from "node:test";
import { createTree, makeNode } from "../benchmarks/fixtures";
import type { UiNode, UiSnapshot } from "../shared/types";
import { diagnoseSelectorMatches, exactSelectorMatchNode, SELECTOR_DIAGNOSTIC_LIMITS, uniqueSnapshotNode } from "../src/features/automation/selector-match-diagnostics";

function fixture(...children: UiNode[]): UiSnapshot {
  const root = makeNode("root"); root.text = root.resourceId = root.contentDesc = null;
  root.children = children;
  return { serial: "fixture-device", root, nodeCount: children.length + 1, rawXml: null, xmlSize: 0,
    screenshotDataUrl: null, error: null, warning: null, inspectionSource: "uiautomator" };
}
function node(id: string, changes: Partial<UiNode> = {}) { return Object.assign(makeNode(id, 1), { text: " READY ", resourceId: "app:id/ready", contentDesc: " 状态 " }, changes); }

test("exact matches require every filled field and preserve case and whitespace", () => {
  const target = node("target"), differentText = node("text", { text: "READY" }), differentClass = node("class", { className: "Button" });
  const snapshot = fixture(target, differentText, differentClass), before = structuredClone(snapshot);
  const selector = { text: " READY ", resourceId: "app:id/ready", contentDesc: " 状态 ", className: "android.widget.TextView" };
  const result = diagnoseSelectorMatches(snapshot, selector);
  assert.equal(result.status, "ready"); assert.equal(result.exactCount, 1); assert.equal(result.exact[0].node, target);
  assert.deepEqual(result.exact[0].mismatches, []); assert.equal(result.referenceCount, 2);
  assert.equal(exactSelectorMatchNode(snapshot, selector, "target"), target);
  assert.equal(exactSelectorMatchNode(snapshot, selector, "text"), null);
  assert.equal(diagnoseSelectorMatches(snapshot, { text: "ready" }).exactCount, 0);
  assert.deepEqual(snapshot, before); assert.deepEqual(selector, result.selector);
});

test("hidden and disabled candidates remain attribute matches, independent of Checker verdict", () => {
  const target = node("disabled", { visibleToUser: false, enabled: false, clickable: false });
  const result = diagnoseSelectorMatches(fixture(target), { text: " READY " });
  assert.equal(result.exactCount, 1); assert.equal(result.exact[0].node.enabled, false); assert.equal(result.exact[0].node.visibleToUser, false);
  assert.ok(!("verdict" in result));
});

test("duplicate resources and omitted fields explain ambiguity without inventing a stable identity", () => {
  const snapshot = fixture(node("a"), node("b", { text: "OTHER" }));
  const result = diagnoseSelectorMatches(snapshot, { resourceId: "app:id/ready" });
  assert.equal(result.exactCount, 2); assert.equal(result.exact.every(candidate => candidate.navigable), true);
  assert.match(result.ambiguity.join(" "), /不能唯一定位/); assert.match(result.ambiguity.join(" "), /重复资源 ID/);
  assert.match(result.ambiguity.join(" "), /未限制：文字、描述、类名/);
  assert.deepEqual(result.exact[0].refinements, ["text", "contentDesc", "className"]);
  const classOnly = diagnoseSelectorMatches(fixture(node("one")), { className: "android.widget.TextView" });
  assert.equal(classOnly.exactCount, 1); assert.match(classOnly.ambiguity.join(" "), /类名不保证唯一/);
});

test("zero matches can have bounded references with per-field reasons but never navigation", () => {
  const target = node("near", { text: "READY", className: "Button", contentDesc: null });
  const snapshot = fixture(target), result = diagnoseSelectorMatches(snapshot, { text: " READY ", resourceId: "app:id/ready", className: "TextView", contentDesc: "状态" });
  assert.equal(result.exactCount, 0); assert.equal(result.referenceCount, 1);
  const candidate = result.references[0]; assert.equal(candidate.node, target); assert.equal(candidate.matchedFields, 1);
  assert.deepEqual(candidate.mismatches.map(item => item.field), ["text", "contentDesc", "className"]);
  assert.equal(candidate.mismatches[0].expected, " READY "); assert.equal(candidate.mismatches[0].actual, "READY");
  assert.match(candidate.mismatches[0].similarity!, /空白/); assert.equal(candidate.mismatches[1].actual, null);
  assert.equal(candidate.navigable, false); assert.equal(exactSelectorMatchNode(snapshot, { text: " READY " }, "near"), null);
  assert.equal(diagnoseSelectorMatches(fixture(node("far", { text: "完全不同" })), { text: "READY" }).referenceCount, 0);
});

test("case, substring and single-edit hints remain references", () => {
  const snapshot = fixture(node("case", { text: "ready" }), node("partial", { text: "READY NOW" }), node("edit", { text: "READX" }));
  const result = diagnoseSelectorMatches(snapshot, { text: "READY" });
  assert.equal(result.exactCount, 0); assert.equal(result.references.length, 3);
  assert.match(result.references[0].mismatches[0].similarity!, /大小写/);
  assert.match(result.references[1].mismatches[0].similarity!, /部分字符/);
  assert.match(result.references[2].mismatches[0].similarity!, /一个字符/);
});

test("references rank matched attributes first and keep preorder for ties", () => {
  const snapshot = fixture(node("fuzzy", { text: "ready", resourceId: "app:id/other" }), node("exact-field", { text: "completely different" }), node("tie", { text: "different too" }));
  const result = diagnoseSelectorMatches(snapshot, { text: "READY", resourceId: "app:id/ready" });
  assert.deepEqual(result.references.map(candidate => candidate.node.id), ["exact-field", "tie", "fuzzy"]);
});

test("empty, malformed and unknown selector fields are rejected before reading a tree", () => {
  const snapshot = fixture(node("target"));
  for (const selector of [null, undefined, [], "READY", {}, { text: undefined }, { text: "" }, { text: 123 }, { text: "中".repeat(513) }, { text: "READY", index: 1 }]) {
    const result = diagnoseSelectorMatches(snapshot, selector);
    assert.equal(result.status, "invalid-selector"); assert.equal(result.exactCount, 0); assert.equal(result.visitedNodes, 0);
    assert.equal(exactSelectorMatchNode(snapshot, selector, "target"), null);
  }
  assert.equal(diagnoseSelectorMatches(null, {}).status, "invalid-selector");
});

test("missing, error and inconsistent snapshots cannot produce matches or navigation", () => {
  const snapshot = fixture(node("target"));
  for (const invalid of [null, { ...snapshot, root: null, nodeCount: 0 }, { ...snapshot, error: "offline" }, { ...snapshot, nodeCount: 99 }, { ...snapshot, nodeCount: -1 }, { ...snapshot, nodeCount: 1.5 }]) {
    const result = diagnoseSelectorMatches(invalid, { text: " READY " });
    assert.equal(result.status, "unavailable"); assert.equal(result.exact.length, 0);
    assert.equal(uniqueSnapshotNode(invalid, "target"), null); assert.equal(exactSelectorMatchNode(invalid, { text: " READY " }, "target"), null);
  }
});

test("global duplicate node IDs block navigation even if only one duplicate matches", () => {
  const target = node("same"), unrelated = node("same", { text: "OTHER", resourceId: "app:id/other" }), unique = node("unique");
  const snapshot = fixture(target, unrelated, unique), result = diagnoseSelectorMatches(snapshot, { text: " READY " });
  assert.equal(result.exactCount, 2); assert.equal(result.exact[0].navigable, false); assert.match(result.exact[0].navigationReason!, /重复/);
  assert.equal(uniqueSnapshotNode(snapshot, "same"), null); assert.equal(exactSelectorMatchNode(snapshot, { text: " READY " }, "same"), null);
  assert.equal(uniqueSnapshotNode(snapshot, "unique"), unique); assert.equal(result.exact[1].navigable, true);
});

test("missing and oversized node IDs cannot navigate", () => {
  for (const id of ["", "x".repeat(2049)]) {
    const snapshot = fixture(node(id)), result = diagnoseSelectorMatches(snapshot, { text: " READY " });
    assert.equal(result.status, "ready"); assert.equal(result.exactCount, 1); assert.equal(result.exact[0].navigable, false);
    assert.equal(uniqueSnapshotNode(snapshot, id), null); assert.equal(exactSelectorMatchNode(snapshot, { text: " READY " }, id), null);
  }
  assert.equal(uniqueSnapshotNode(fixture(node("target")), "missing"), null);
});

test("missing, reversed and empty bounds can be read but cannot navigate", () => {
  const base = node("target").bounds!;
  for (const bounds of [null, { ...base, right: base.left }, { ...base, bottom: base.top - 1 }]) {
    const target = node("target", { bounds }), snapshot = fixture(target), result = diagnoseSelectorMatches(snapshot, { text: " READY " });
    assert.equal(result.status, "ready"); assert.equal(result.exactCount, 1); assert.equal(result.exact[0].navigable, false);
    assert.match(result.exact[0].navigationReason!, /位置/);
    assert.equal(uniqueSnapshotNode(snapshot, "target"), target); assert.equal(exactSelectorMatchNode(snapshot, { text: " READY " }, "target"), null);
  }
});

test("invalid fields, nonfinite bounds, cycles and excessive depth reject the complete tree", () => {
  const badBounds = fixture(node("target", { bounds: { ...node("target").bounds!, right: Number.NaN } }));
  const badField = fixture(node("target")); (badField.root!.children[0] as unknown as { text: number }).text = 123;
  const cyclic = fixture(); cyclic.root!.children.push(cyclic.root!);
  const deep = fixture(); let leaf = deep.root!; for (let i = 0; i < 202; i++) { const child = node(`depth-${i}`); leaf.children = [child]; leaf = child; } deep.nodeCount = 203;
  for (const snapshot of [badBounds, badField, cyclic, deep]) {
    assert.equal(diagnoseSelectorMatches(snapshot, { text: " READY " }).status, "unavailable");
    assert.equal(uniqueSnapshotNode(snapshot, "target"), null);
  }
});

test("old snapshots stay readable and report unknown source and geometry", () => {
  const snapshot = fixture(node("target")); delete snapshot.inspectionSource;
  const result = diagnoseSelectorMatches(snapshot, { text: " READY " });
  assert.equal(result.status, "ready"); assert.equal(result.exactCount, 1);
  assert.match(result.warnings.join(" "), /旧快照/); assert.match(result.warnings.join(" "), /坐标系未核对/);
});

test("20,000-node trees are counted fully while rendering and references stay bounded", () => {
  const tree = createTree(SELECTOR_DIAGNOSTIC_LIMITS.nodes, "wide");
  const snapshot = { ...fixture(), root: tree, nodeCount: SELECTOR_DIAGNOSTIC_LIMITS.nodes };
  for (const child of tree.children) { child.className = "Button"; child.text = "READY"; }
  const result = diagnoseSelectorMatches(snapshot, { className: "Button" });
  assert.equal(result.status, "ready"); assert.equal(result.visitedNodes, 20_000); assert.equal(result.exactCount, 19_999);
  assert.equal(result.exact.length, SELECTOR_DIAGNOSTIC_LIMITS.matches);
  const last = tree.children.at(-1)!; assert.equal(exactSelectorMatchNode(snapshot, { className: "Button" }, last.id), last);
  const referenceResult = diagnoseSelectorMatches(snapshot, { text: "ready" });
  assert.equal(referenceResult.exactCount, 0); assert.equal(referenceResult.referenceCount, 19_999);
  assert.equal(referenceResult.references.length, SELECTOR_DIAGNOSTIC_LIMITS.references);
});

test("over-limit trees never report partial match counts or navigation", () => {
  const snapshot = { ...fixture(), root: createTree(20_001, "wide"), nodeCount: 20_001 };
  const result = diagnoseSelectorMatches(snapshot, { className: "android.widget.TextView" });
  assert.equal(result.status, "unavailable"); assert.equal(result.exactCount, 0); assert.equal(result.visitedNodes, 0);
  assert.match(result.reason!, /上限/); assert.equal(uniqueSnapshotNode(snapshot, "0"), null);
});

test("lookup rechecks mutated attributes, IDs and snapshot errors before navigating", () => {
  const target = node("target"), snapshot = fixture(target), selector = { text: " READY " };
  assert.equal(exactSelectorMatchNode(snapshot, selector, "target"), target);
  target.text = "CHANGED"; assert.equal(exactSelectorMatchNode(snapshot, selector, "target"), null);
  target.text = " READY "; snapshot.root!.children.push(node("target", { text: "OTHER" })); snapshot.nodeCount++;
  assert.equal(exactSelectorMatchNode(snapshot, selector, "target"), null);
  snapshot.root!.children.pop(); snapshot.nodeCount--; snapshot.error = "stale";
  assert.equal(uniqueSnapshotNode(snapshot, "target"), null);
});
