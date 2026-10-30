import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { debugCommand, debugToolSchemas, debugUiStepExpectation, debugUiStepTarget, getUiStepInput, performUiStepInput,
  resumeUiStepInput, scrollUntilInput } from "../shared/debug-protocol";
import * as moved from "../shared/debug-step-input";
import { debugPlanDefinition, debugPlanStep, type DebugPlanDefinition, type DebugPlanRun, type DebugPlanStep, type DebugPlanStepResult } from "../shared/debug-plan";
import type { DebugSessionState } from "../shared/types";

const condition = { selector: { resourceId: "com.example.fixture:id/ready" } };
const tap = () => ({ id: "open", kind: "step", input: { target: { selector: { resourceId: "com.example.fixture:id/button" } },
  action: { kind: "tap" }, expect: condition } });
const scroll = () => ({ id: "bottom", kind: "scroll-until", input: { target: { selector: { resourceId: "com.example.fixture:id/list" } },
  direction: "down", until: { selector: { resourceId: "com.example.fixture:id/end" }, kind: "end_marker" } } });
const wait = () => ({ id: "ready", kind: "wait", condition });
const plan = () => ({ version: 1, title: "Offline plan", startConditions: [condition], finalConditions: [condition], steps: [tap()] });
const accepted = (value: unknown) => debugPlanDefinition.safeParse(value).success;

test("plan schemas apply the shared defaults and infer all three step variants", () => {
  const definition: DebugPlanDefinition = debugPlanDefinition.parse({ ...plan(), steps: [tap(), scroll(), wait()] });
  assert.equal(definition.backend, "uiautomator"); assert.equal(definition.timeoutMs, 300_000);
  assert.equal(definition.startConditions[0].state, "visible"); assert.equal(definition.finalConditions[0].state, "visible");
  const [first, second, third]: DebugPlanStep[] = definition.steps;
  assert.equal(first.kind, "step"); if (first.kind === "step") {
    assert.equal(first.input.target?.target, "self"); assert.equal(first.input.expect.state, "visible"); assert.equal(first.input.timeoutMs, 45_000);
  }
  assert.equal(second.kind, "scroll-until"); if (second.kind === "scroll-until") {
    assert.equal(second.input.maxScrolls, 6); assert.equal(second.input.timeoutMs, 120_000); assert.equal(second.input.distance, 0.6);
  }
  assert.equal(third.kind, "wait"); if (third.kind === "wait") assert.equal(third.timeoutMs, 30_000);
  assert.equal(accepted({ ...plan(), backend: "accessibility-helper" }), true);
});

test("plan controls require explicit UUIDs and strict namespaced inputs", () => {
  const sessionId = randomUUID(), runId = randomUUID();
  for (const name of ["start_debug_plan", "get_debug_plan", "cancel_debug_plan"] as const) {
    const input = { sessionId, runId, ...(name === "start_debug_plan" ? { definition: plan() } : {}) };
    assert.equal(debugToolSchemas[name].safeParse(input).success, true);
    assert.equal(debugCommand.safeParse({ name, input }).success, true);
    assert.equal(debugToolSchemas[name].safeParse({ ...input, sessionId: "missing" }).success, false);
    assert.equal(debugToolSchemas[name].safeParse({ ...input, runId: "missing" }).success, false);
    assert.equal(debugToolSchemas[name].safeParse({ ...input, requestId: randomUUID() }).success, false);
    assert.equal(debugCommand.safeParse({ name, input, code: "arbitrary" }).success, false);
  }
  assert.equal(debugToolSchemas.start_debug_plan.safeParse({ sessionId, runId }).success, false);
});

test("existing step exports preserve identity, defaults and optional expectation behavior", () => {
  for (const [legacy, current] of [[debugUiStepExpectation, moved.debugUiStepExpectation], [debugUiStepTarget, moved.debugUiStepTarget],
    [performUiStepInput, moved.performUiStepInput], [getUiStepInput, moved.getUiStepInput], [resumeUiStepInput, moved.resumeUiStepInput],
    [scrollUntilInput, moved.scrollUntilInput]]) assert.equal(legacy, current);
  const sessionId = randomUUID(), requestId = randomUUID();
  const old = performUiStepInput.parse({ sessionId, requestId, action: { kind: "back" } });
  assert.equal(old.backend, "uiautomator"); assert.equal(old.timeoutMs, 45_000); assert.equal(old.expect, undefined);
  assert.equal(resumeUiStepInput.parse({ sessionId, requestId }).timeoutMs, 30_000);
  assert.equal(performUiStepInput.safeParse({ sessionId, requestId, action: { kind: "back" },
    visualConfirmation: { snapshotId: randomUUID(), description: "fixture" } }).success, false);
});

test("plan step inputs preserve all shared tap/back/scroll cross-field constraints", () => {
  const invalidInputs = [
    { action: { kind: "tap" }, expect: condition },
    { action: { kind: "scroll", direction: "down" }, expect: condition },
    { action: { kind: "back" }, target: tap().input.target, expect: condition },
    { action: { kind: "scroll", direction: "down" }, target: { ...tap().input.target, target: "clickable-parent" }, expect: condition },
    { action: { kind: "tap" }, target: tap().input.target },
    { action: { kind: "tap", x: 10, y: 20 }, target: tap().input.target, expect: condition },
    { action: { kind: "swipe", fromX: 10, fromY: 10, toX: 10, toY: 20 }, expect: condition },
  ];
  for (const input of invalidInputs) assert.equal(accepted({ ...plan(), steps: [{ id: "bad", kind: "step", input }] }), false);
  const valid = [
    { action: { kind: "back" }, expect: condition },
    { action: { kind: "tap" }, target: { ...tap().input.target, target: "clickable-parent" }, expect: condition },
    { action: { kind: "scroll", direction: "up" }, target: tap().input.target, expect: condition },
  ];
  for (const input of valid) assert.equal(accepted({ ...plan(), steps: [{ id: "valid", kind: "step", input }] }), true);
});

test("plan-owned ids, backend, visual confirmation and executable fields cannot be injected", () => {
  for (const step of [tap(), scroll()]) for (const field of [
    { sessionId: randomUUID() }, { requestId: randomUUID() }, { backend: "accessibility-helper" },
    { visualConfirmation: { snapshotId: randomUUID(), description: "forged" } }, { execute: "shell-command" }, { x: 10, y: 20 },
  ]) assert.equal(accepted({ ...plan(), steps: [{ ...step, input: { ...step.input, ...field } }] }), false);
  for (const injection of [{ code: "arbitrary" }, { command: "arbitrary" }, { repeat: 100 }, { timeoutMs: NaN }, { backend: "deep" }])
    assert.equal(accepted({ ...plan(), ...injection }), false);
  assert.equal(accepted({ ...plan(), steps: [{ id: "shell", kind: "exec", command: "arbitrary" }] }), false);
  assert.equal(accepted({ ...plan(), steps: [{ ...tap(), steps: [tap()] }] }), false);
  assert.equal(accepted({ ...plan(), steps: [{ ...wait(), input: { code: "arbitrary" } }] }), false);
});

test("when and wait accept one exact finite expectation and reject expressions or branching programs", () => {
  for (const state of ["visible", "absent", "enabled", "disabled"] as const) {
    const when = { selector: { resourceId: "com.example.fixture:id/dialog" }, state };
    for (const step of [tap(), scroll(), wait()]) assert.equal(accepted({ ...plan(), steps: [{ ...step, when }] }), true);
  }
  for (const when of [false, "expression", { selector: {} }, { selector: { text: "fixture" }, execute: "arbitrary" },
    { any: [condition] }, { condition, then: [tap()] }, { selector: { text: "fixture" }, state: "unknown" }])
    assert.equal(accepted({ ...plan(), steps: [{ ...tap(), when }] }), false);
  assert.equal(debugPlanStep.safeParse({ ...wait(), timeoutMs: 999 }).success, false);
  assert.equal(debugPlanStep.safeParse({ ...wait(), timeoutMs: 30_001 }).success, false);
  assert.equal(debugPlanStep.safeParse({ ...wait(), timeoutMs: 1000 }).success, true);
});

test("plan counts, step ids and timeouts are bounded at both ends", () => {
  for (const change of [{ version: 2 }, { title: "" }, { title: " " }, { title: "x".repeat(257) },
    { timeoutMs: 999 }, { timeoutMs: 600_001 }, { timeoutMs: Infinity }, { startConditions: [] }, { finalConditions: [] },
    { startConditions: Array(6).fill(condition) }, { finalConditions: Array(6).fill(condition) }, { steps: [] },
    { steps: Array.from({ length: 33 }, (_, index) => ({ ...tap(), id: `s${index}` })) },
    { steps: [tap(), tap()] }, { steps: [{ ...tap(), id: "" }] }, { steps: [{ ...tap(), id: "x".repeat(65) }] },
    { steps: [{ ...tap(), id: "bad id" }] }, { steps: [{ ...tap(), id: "路径" }] }]) assert.equal(accepted({ ...plan(), ...change }), false);
  assert.equal(accepted({ ...plan(), timeoutMs: 1000 }), true); assert.equal(accepted({ ...plan(), timeoutMs: 600_000 }), true);
  assert.equal(accepted({ ...plan(), steps: Array.from({ length: 32 }, (_, index) => ({ ...tap(), id: `s${index}` })) }), true);
  assert.equal(accepted({ ...plan(), steps: [{ ...tap(), id: "A_0-" }] }), true);
  for (const change of [{ maxScrolls: 0 }, { maxScrolls: 13 }, { timeoutMs: 120_001 }, { durationMs: 1001 }, { distance: 0.9 }])
    assert.equal(accepted({ ...plan(), steps: [{ ...scroll(), input: { ...scroll().input, ...change } }] }), false);
});

test("the 12000-byte definition bound counts UTF-8 bytes instead of JavaScript characters", () => {
  const selector = { resourceId: "字".repeat(512), text: "字".repeat(512), className: "字".repeat(512), contentDesc: "字".repeat(512) };
  const oversized = { ...plan(), steps: [0, 1].map(index => ({ ...tap(), id: `s${index}`, input: {
    target: { selector }, action: { kind: "tap" }, expect: { selector },
  } })) };
  assert.ok(JSON.stringify(oversized).length < 12_000);
  assert.ok(new TextEncoder().encode(JSON.stringify(oversized)).length > 12_000);
  const parsed = debugPlanDefinition.safeParse(oversized); assert.equal(parsed.success, false);
  if (!parsed.success) assert.ok(parsed.error.issues.some(issue => issue.message.includes("12000")));
});

test("shared session state holds a plan with nullable unmeasured fields and explicit interrupted status", () => {
  const result: DebugPlanStepResult = { id: "wait", kind: "wait", status: "pending", requestId: null, productStepIds: [], durationMs: null, message: "fixture" };
  const run: DebugPlanRun = { runId: randomUUID(), sessionId: randomUUID(), title: "fixture", planHash: "a".repeat(64), status: "interrupted",
    startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, currentStepId: null, completedSteps: 0, totalSteps: 1,
    steps: [result], checkpointStepIds: [], reportPath: null, ledgerPath: "/private/fixture.json", message: "fixture", stopCode: "interrupted" };
  const state: DebugSessionState = { id: run.sessionId, serial: "offline-device", packageName: "com.example.fixture", active: true, busy: false,
    expiresAt: new Date().toISOString(), steps: [], evidencePath: null, plan: run };
  assert.equal(state.plan?.status, "interrupted"); assert.equal(state.plan?.steps[0].durationMs, null);
});
