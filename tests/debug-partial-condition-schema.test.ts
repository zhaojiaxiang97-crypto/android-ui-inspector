import assert from "node:assert/strict";
import { test } from "node:test";
import { debugToolSchemas, performUiStepInput } from "../shared/debug-protocol";
import { debugTaskCondition } from "../shared/debug-task";
import { debugPlanDefinition } from "../shared/debug-plan";

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const selector = { resourceId: "com.example:id/root", contentDesc: "暂停视频" };
const partial = { selector, state: "visible", visibility: "partial" };

test("partial is an explicit positive observation contract across public entry points", () => {
  assert.equal(debugToolSchemas.wait_for_ui.parse({ sessionId, ...partial }).visibility, "partial");
  assert.equal(debugTaskCondition.parse({ id: "playing", ...partial }).visibility, "partial");
  for (const state of ["absent", "enabled", "disabled"]) {
    assert.equal(debugToolSchemas.wait_for_ui.safeParse({ sessionId, ...partial, state }).success, false);
    assert.equal(debugTaskCondition.safeParse({ id: "playing", ...partial, state }).success, false);
  }
  assert.equal(debugToolSchemas.wait_for_ui.parse({ sessionId, selector }).visibility, undefined);
  const input = { sessionId, requestId: sessionId, action: { kind: "back" }, expect: partial };
  assert.equal(performUiStepInput.safeParse(input).success, false);
  assert.equal(performUiStepInput.safeParse({ ...input, backend: "accessibility-helper" }).success, true);
});

test("plan partial is limited to durable wait/action assertions and the Helper backend", () => {
  const strict = { selector, state: "visible" };
  const base = { version: 1, title: "condition test", backend: "uiautomator", startConditions: [strict], finalConditions: [strict],
    steps: [{ id: "wait", kind: "wait", condition: strict }] };
  const variants = [
    { ...base, startConditions: [partial] }, { ...base, finalConditions: [partial] },
    { ...base, steps: [{ ...base.steps[0], when: partial }] },
    { ...base, steps: [{ ...base.steps[0], condition: partial }] },
    { ...base, steps: [{ id: "back", kind: "step", input: { action: { kind: "back" }, expect: partial } }] },
  ];
  for (const [index, plan] of variants.entries()) {
    assert.equal(debugPlanDefinition.safeParse(plan).success, false);
    assert.equal(debugPlanDefinition.safeParse({ ...plan, backend: "accessibility-helper" }).success, index >= 3);
  }
});
