import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { debugPlanDefinition } from "../shared/debug-plan";
import { scrollUntilInput } from "../shared/debug-step-input";
import { debugScrollProgressSchema } from "../shared/debug-scroll-validation";
import { helperInputRequest } from "../shared/helper-input";

const selector = { resourceId: "com.example.test:id/list", className: "android.widget.ScrollView" };
const condition = { selector: { text: "末项" } };
const input = () => ({ sessionId: randomUUID(), requestId: randomUUID(), backend: "accessibility-helper",
  inputMethod: "accessibility", target: { selector }, direction: "down", until: condition });

test("semantic scroll is explicit, vertical and tied to an exact Helper container", () => {
  assert.equal(scrollUntilInput.safeParse(input()).success, true);
  for (const change of [{ backend: "uiautomator" }, { direction: "left" }, { direction: "right" },
    { target: { selector: { resourceId: selector.resourceId } } }, { target: { selector: { className: selector.className } } },
    { inputMethod: "fallback" }, { visualConfirmation: { snapshotId: randomUUID(), description: "visible" } }])
    assert.equal(scrollUntilInput.safeParse({ ...input(), ...change }).success, false);
  const { inputMethod: _, ...legacy } = input();
  const parsed = scrollUntilInput.parse({ ...legacy, backend: "uiautomator", direction: "left" });
  assert.equal(parsed.inputMethod, undefined, "legacy requests retain their original normalized shape and hash");
});

test("plans enforce the same semantic scroll restrictions using their own backend", () => {
  const { sessionId: _, requestId: _request, backend, ...step } = input();
  const plan = { version: 1, title: "scroll", backend, startConditions: [condition], finalConditions: [condition],
    steps: [{ id: "end", kind: "scroll-until", input: step }] };
  assert.equal(debugPlanDefinition.safeParse(plan).success, true);
  assert.equal(debugPlanDefinition.safeParse({ ...plan, backend: "uiautomator" }).success, false);
  assert.equal(debugPlanDefinition.safeParse({ ...plan,
    steps: [{ ...plan.steps[0], input: { ...step, direction: "left" } }] }).success, false);
});

const request = () => ({ version: 1, sessionId: randomUUID(), requestId: randomUUID(), serviceInstanceId: randomUUID(),
  captureId: randomUUID(), packageName: "com.example.test", windowId: "1", display: { width: 1080, height: 2400, rotation: 0 },
  action: { kind: "scroll", direction: "down" },
  target: { ...selector, bounds: { left: 10, top: 100, right: 1000, bottom: 2200 } } });

test("phone protocol rejects missing targets, unknown actions and invalid semantic bounds", () => {
  assert.equal(helperInputRequest.safeParse(request()).success, true);
  for (const change of [{ target: undefined }, { action: { kind: "scroll", direction: "left" } },
    { action: { kind: "scroll", direction: "down", fromY: 100 } },
    { target: { ...request().target, bounds: { left: 10, top: 100, right: 1000, bottom: 2401 } } },
    { target: { ...request().target, bounds: { left: 10, top: 100, right: 10, bottom: 200 } } }])
    assert.equal(helperInputRequest.safeParse({ ...request(), ...change }).success, false);
});

function progress() {
  const { target: _, action: _action, ...identity } = request();
  const before = randomUUID(), after = randomUUID();
  return { stopReason: "interrupted", observationIds: [before, after], iterations: [{ index: 1,
    startedAt: new Date().toISOString(), durationMs: 100, beforeId: before, afterId: after,
    dispatchState: "sent", progress: "unknown", resolvedInput: { action: { kind: "scroll", direction: "down" },
      frame: identity.display, targetNodeId: "0/1", scrollRegion: {
        viewport: { left: 10, top: 100, right: 1000, bottom: 2200 },
        confirmationBounds: { left: 400, top: 500, right: 600, bottom: 1800 }, excludedNavigationBounds: [] } },
    inputEvidence: { transport: "accessibility-helper", classification: "accepted", spawned: false, closed: false,
      exitCode: null, signal: null, durationMs: 100, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
      helperInput: { dispatchState: "sent", requestId: identity.requestId,
        receipt: { ...identity, status: "completed", dispatchState: "sent", startedAtMs: 100,
          finishedAtMs: 200, method: "accessibility-scroll" } } } }] };
}

test("scroll records distinguish semantic actions from gesture receipts and require target geometry", () => {
  assert.equal(debugScrollProgressSchema.safeParse(progress()).success, true);
  for (const method of ["gesture", "accessibility-click", "global-back", undefined]) {
    const p = progress();
    Object.assign(p.iterations[0].inputEvidence.helperInput.receipt, { method });
    assert.equal(debugScrollProgressSchema.safeParse(p).success, false);
  }
  for (const key of ["scrollRegion", "targetNodeId"]) {
    const p = progress();
    Reflect.deleteProperty(p.iterations[0].resolvedInput, key);
    assert.equal(debugScrollProgressSchema.safeParse(p).success, false);
  }
  const p = progress();
  Object.assign(p.iterations[0].resolvedInput, { action: { kind: "swipe", fromX: 500, fromY: 1500,
    toX: 500, toY: 600, durationMs: 350 } });
  assert.equal(debugScrollProgressSchema.safeParse(p).success, false, "a swipe must not masquerade as a semantic scroll");
});
