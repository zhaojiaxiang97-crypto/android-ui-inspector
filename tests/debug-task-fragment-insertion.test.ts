import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { debugTaskDefinition, type DebugTaskDefinition } from "../shared/debug-task";
import { debugTaskFragment, type DebugTaskFragment } from "../shared/debug-task-templates";
import { createDebugTaskDraft, insertDebugTaskFragment } from "../src/features/automation/debug-task-editor-model";

const metadata = { id: randomUUID(), name: "片段", createdAt: "2026-10-12T01:00:00Z", updatedAt: "2026-10-12T01:00:00Z" };
const condition = { id: "condition2", selector: { text: " READY ", resourceId: "app:id/ready", className: "android.widget.TextView" }, state: "disabled" as const };
const piece = debugTaskFragment.parse({ ...metadata, kind: "condition", condition });
const stage = debugTaskFragment.parse({ ...metadata, kind: "stage", stage: { id: "stage1", title: "准备", conditions: [condition,
  { id: "old", selector: { contentDesc: " Loading " }, state: "absent" }] } });
function fixture(): DebugTaskDefinition { return debugTaskDefinition.parse({ goal: "达到完成状态", finalConditions: [{ id: "condition1", state: "visible", selector: { text: "DONE" } }],
  checkpoints: [{ id: "existing", title: "开始", conditions: [{ id: "start", state: "enabled", selector: { text: "START" } }] }] }); }

test("condition fragments get fresh IDs on each insertion and preserve exact selector/state", () => {
  const original = fixture(), frozen = JSON.stringify(original), saved = JSON.stringify(piece);
  const first = insertDebugTaskFragment(original, piece), second = insertDebugTaskFragment(first.definition, piece);
  assert.equal(first.error, null); assert.equal(second.error, null);
  const added = second.definition.finalConditions.slice(1);
  assert.equal(added.length, 2); assert.notEqual(added[0].id, added[1].id);
  assert.ok(added.every(item => item.id !== condition.id));
  assert.deepEqual(added.map(item => item.selector), [condition.selector, condition.selector]);
  assert.ok(added.every(item => item.state === "disabled"));
  assert.equal(JSON.stringify(original), frozen); assert.equal(JSON.stringify(piece), saved);
  const intoStage = insertDebugTaskFragment(original, piece, "existing");
  assert.equal(intoStage.definition.checkpoints[0].conditions.length, 2); assert.equal(intoStage.definition.finalConditions.length, 1);
  assert.equal(debugTaskDefinition.safeParse(second.definition).success, true);
});

test("stage insertion regenerates stage and all condition IDs and keeps order", () => {
  const original = fixture(), saved = JSON.stringify(stage), result = insertDebugTaskFragment(original, stage);
  assert.equal(result.error, null); assert.equal(result.definition.checkpoints.length, 2);
  const added = result.definition.checkpoints[1];
  assert.notEqual(added.id, "stage1"); assert.equal(added.title, "准备");
  assert.deepEqual(added.conditions.map(({ selector, state }) => ({ selector, state })), [
    { selector: condition.selector, state: "disabled" }, { selector: { contentDesc: " Loading " }, state: "absent" },
  ]);
  assert.ok(added.conditions.every(item => !["condition2", "old"].includes(item.id)));
  assert.equal(new Set([...result.definition.finalConditions, ...result.definition.checkpoints.flatMap(item => item.conditions)].map(item => item.id)).size, 4);
  const again = insertDebugTaskFragment(result.definition, stage);
  assert.notEqual(again.definition.checkpoints[2].id, added.id);
  assert.equal(debugTaskDefinition.safeParse(again.definition).success, true);
  assert.equal(JSON.stringify(stage), saved);
});

test("capacity and stale target failures retain the exact original draft", () => {
  const ten = Array.from({ length: 10 }, (_, index) => ({ id: `final${index}`, selector: { text: "DONE" }, state: "visible" as const }));
  const five = Array.from({ length: 5 }, (_, index) => ({ id: `stage${index}`, title: "阶段", conditions: [{ id: `start${index}`, selector: { text: "START" }, state: "visible" as const }] }));
  const byteHeavy = fixture(); byteHeavy.finalConditions = Array.from({ length: 8 }, (_, index) => ({ id: `big${index}`, selector: { text: "中".repeat(440) }, state: "visible" }));
  const bigPiece = debugTaskFragment.parse({ ...metadata, kind: "condition", condition: { ...condition, selector: { text: "中".repeat(512), resourceId: "x".repeat(512) } } });
  const cases: [DebugTaskDefinition, DebugTaskFragment, string | null, RegExp][] = [
    [{ ...fixture(), finalConditions: ten }, piece, null, /10/],
    [{ ...fixture(), checkpoints: [{ id: "existing", title: "阶段", conditions: ten }] }, piece, "existing", /10/],
    [{ ...fixture(), checkpoints: five }, stage, null, /5/],
    [{ ...fixture(), finalConditions: ten, checkpoints: [{ id: "existing", title: "阶段", conditions: ten.map(item => ({ ...item, id: "stage_" + item.id })) }] }, stage, null, /20/],
    [byteHeavy, bigPiece, null, /12KB/], [fixture(), piece, "removed-stage", /不存在/],
  ];
  for (const [draft, fragment, target, reason] of cases) {
    const before = JSON.stringify(draft), result = insertDebugTaskFragment(draft, fragment, target);
    assert.match(result.error!, reason); assert.equal(result.definition, draft); assert.equal(JSON.stringify(draft), before);
  }
});

test("unfinished offline drafts accept fragments and malformed fragments never alter them", () => {
  const draft = createDebugTaskDraft(), result = insertDebugTaskFragment(draft, piece);
  assert.equal(result.error, null); assert.equal(result.definition.goal, ""); assert.deepEqual(result.definition.finalConditions[0].selector, {});
  assert.equal(result.definition.finalConditions.length, 2);
  const malformed = { ...piece, condition: { ...condition, selector: { textContains: "READY" } } } as unknown as DebugTaskFragment;
  const rejected = insertDebugTaskFragment(draft, malformed);
  assert.ok(rejected.error); assert.equal(rejected.definition, draft);
});
