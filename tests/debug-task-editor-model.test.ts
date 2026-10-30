import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { debugTaskDefinition } from "../shared/debug-task";
import type { DebugSessionState, UiSnapshot } from "../shared/types";
import { countDebugTaskConditions, countSnapshotSelectorMatches, createDebugTaskDraft, debugTaskDefinitionBlockedReason,
  debugTaskDefinitionError, debugTaskSessionBlockedReason, nextDebugTaskEditorId, restoreDebugTaskTemplate,
  selectorFromSelectedNode } from "../src/features/automation/debug-task-editor-model";

const definition = debugTaskDefinition.parse({ goal: "完整阶段", checkpoints: [{ id: "stage1", title: "准备", conditions: [
  { id: "condition1", state: "enabled", selector: { text: " READY " } }, { id: "condition2", state: "disabled", selector: { resourceId: "app:id/button" } },
] }], finalConditions: [{ id: "condition3", state: "absent", selector: { text: " OLD " } }, { id: "condition4", state: "visible", selector: { text: "DONE" } }] });
function session(): DebugSessionState { return { id: randomUUID(), serial: "device", packageName: "app", active: true, busy: false, expiresAt: new Date(Date.now() + 60_000).toISOString(), steps: [], evidencePath: null }; }
function fixture(): UiSnapshot {
  const root = makeNode("root"); root.text = null; root.resourceId = null; root.contentDesc = null;
  const target = makeNode("target", 1); target.text = " READY "; target.resourceId = "app:id/ready"; target.contentDesc = " 状态 "; root.children = [target];
  return { serial: "device", root, nodeCount: 2, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null };
}

test("selected node creates exact selector preserving whitespace and rejects missing or stale selections", () => {
  const snapshot = fixture(), node = snapshot.root!.children[0];
  const generated = selectorFromSelectedNode(snapshot, node);
  assert.deepEqual(generated.selector, { text: " READY ", resourceId: "app:id/ready", contentDesc: " 状态 ", className: "android.widget.TextView" });
  assert.equal(generated.error, null);
  assert.equal(countSnapshotSelectorMatches(snapshot, generated.selector!), 1);
  assert.equal(countSnapshotSelectorMatches(snapshot, { text: "READY" }), 0);
  assert.equal(countSnapshotSelectorMatches(snapshot, {}), null);
  assert.equal(countSnapshotSelectorMatches(null, { text: "READY" }), null);
  assert.ok(selectorFromSelectedNode(null, node).error);
  assert.ok(selectorFromSelectedNode(snapshot, null).error);
  assert.ok(selectorFromSelectedNode(snapshot, { ...node, text: "OLD" }).error);
  assert.ok(selectorFromSelectedNode(snapshot, makeNode("old")).error);
  node.text = "中".repeat(513); assert.ok(selectorFromSelectedNode(snapshot, node).error);
  node.text = node.resourceId = node.contentDesc = node.className = null; assert.ok(selectorFromSelectedNode(snapshot, node).error);
});

test("restoring and editing templates preserves every phase, state, selector and identifier", () => {
  const template = { id: randomUUID(), name: "全条件", createdAt: "2026-10-12T01:00:00Z", updatedAt: "2026-10-12T01:00:00Z", definition };
  const restored = restoreDebugTaskTemplate(template);
  assert.deepEqual(restored, definition); assert.notEqual(restored, definition);
  restored.goal = "新草稿"; restored.checkpoints[0].conditions[0].selector.text = "NEW";
  assert.equal(template.definition.goal, "完整阶段"); assert.equal(template.definition.checkpoints[0].conditions[0].selector.text, " READY ");
  assert.equal(countDebugTaskConditions(restored), 4);
  assert.equal(nextDebugTaskEditorId(restored, "condition"), "condition5");
  assert.equal(nextDebugTaskEditorId(restored, "stage"), "stage2");
  assert.equal(debugTaskDefinitionError(restored), null);
  assert.match(debugTaskDefinitionError(createDebugTaskDraft())!, /目标/);
  assert.match(debugTaskDefinitionError({ ...createDebugTaskDraft(), goal: "有目标" })!, /精确匹配/);
});

test("desktop requests require a current authorized idle session and freeze definitions before input", () => {
  const current = session(); assert.equal(debugTaskSessionBlockedReason(current), null);
  assert.equal(debugTaskDefinitionBlockedReason(current), null);
  assert.ok(debugTaskSessionBlockedReason(null));
  assert.ok(debugTaskSessionBlockedReason({ ...current, active: false }));
  assert.ok(debugTaskSessionBlockedReason({ ...current, expiresAt: "invalid" }));
  assert.ok(debugTaskSessionBlockedReason(current, Date.parse(current.expiresAt)));
  assert.match(debugTaskSessionBlockedReason({ ...current, busy: true })!, /等待/);
  current.steps = [{ id: 1, time: "2026-10-12T01:00:00Z", action: "tap_node", input: {}, status: "failed", dispatchState: "not_sent", message: "被拒绝" }];
  assert.match(debugTaskDefinitionBlockedReason(current)!, /首次输入前/);
  for (const action of ["perform_ui_step", "scroll_until"]) {
    current.steps[0].action = action;
    assert.match(debugTaskDefinitionBlockedReason(current)!, /首次输入前/);
  }
  assert.equal(debugTaskSessionBlockedReason(current), null);
  current.task = { id: randomUUID(), definedAt: "2026-10-12T01:00:00Z", definedStepId: 1, definition, checks: [] };
  assert.match(debugTaskDefinitionBlockedReason(current)!, /不能改写/);
});
