import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { performUiStepInput } from "../shared/debug-protocol";
import type { DebugSessionState, DebugStep, UiSnapshot } from "../shared/types";
import { DebugStepExecutor } from "../electron/automation/debug-step-executor";
import { debugStepFailure, type StepContext } from "../electron/automation/debug-step-context";
import { DebugObservationError } from "../electron/automation/debug-observation-error";

const packageName = "com.example.timeout", serial = "offline-device";
const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "timeout-window" };
function snapshot(text = "CURRENT"): UiSnapshot {
  const root = makeNode("0"), button = makeNode("0/0");
  root.package = button.package = packageName; root.clickable = root.scrollable = false;
  root.bounds = { left: 0, top: 0, right: 1080, bottom: 2400, raw: "" };
  button.resourceId = `${packageName}:id/action`; button.text = text;
  button.clickable = button.enabled = button.visibleToUser = true; button.scrollable = false;
  button.bounds = { left: 20, top: 100, right: 180, bottom: 160, raw: "" }; root.children = [button];
  const frame = { width: 1080, height: 2400, rotation: 0 as const };
  return { serial, root, nodeCount: 2, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null,
    captureMode: "fast", inspectionSource: "uiautomator",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } };
}
function untilAbort(signal: AbortSignal): Promise<never> {
  signal.throwIfAborted();
  return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}
async function timeoutCase(page: (read: number, signal: AbortSignal) => UiSnapshot | Promise<UiSnapshot>, deadlineMs = 800) {
  const directory = mkdtempSync(join(tmpdir(), "inspector-expectation-timeout-"));
  const state: DebugSessionState = { id: randomUUID(), serial, packageName, active: true, busy: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), steps: [], evidencePath: null };
  let reads = 0, inputs = 0;
  const executor = new DebugStepExecutor(state, { snapshotPath: join(directory, "current.json"),
    observe: async (_serial, _package, _mode, signal) => ({ snapshot: await page(++reads, signal!), target }),
    input: async (_serial, _target, _action, _frame, _signal, onEvidence) => { inputs++; onEvidence?.({ classification: "accepted", spawned: true,
      closed: true, exitCode: 0, signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }); },
    events: { phase: (context, phase) => { context.phase = phase; }, emit: () => {} } });
  const command = { name: "perform_ui_step" as const, input: performUiStepInput.parse({ sessionId: state.id, requestId: randomUUID(),
    target: { selector: { resourceId: `${packageName}:id/action` } }, action: { kind: "tap" },
    expect: { selector: { text: "EXPECTED" } }, timeoutMs: 1000 }) };
  const step: DebugStep = { id: 1, time: new Date().toISOString(), action: command.name, input: command.input,
    status: "running", message: "fixture", dispatchState: "not_sent" };
  const context = executor.beginStep(command, step), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Fixture deadline", "TimeoutError")), deadlineMs);
  try {
    await assert.rejects(executor.execute(command, controller.signal, context));
    assert.equal(controller.signal.aborted, true, "fixture must reach its deadline instead of failing preflight");
    const error = debugStepFailure(controller.signal.reason, context, true, false);
    return { context, error, reads, inputs, step };
  } finally { clearTimeout(timer); executor.stop(); rmSync(directory, { recursive: true, force: true }); }
}

test("completed unmet observations classify verification timeout even when the final read is cancelled", async () => {
  const result = await timeoutCase((read, signal) => read >= 4 ? untilAbort(signal) : snapshot());
  assert.equal(result.inputs, 1); assert.equal(result.step.dispatchState, "sent"); assert.equal(result.context.phase, "capture");
  assert.deepEqual(result.context.verification, { completedObservations: 2, lastVisibleMatchCount: 0,
    matchedObservations: 0, consecutiveMatches: 0, unrecoveredObservationFailures: 0 });
  assert.equal(result.error.code, "expectation_not_met_timeout"); assert.equal(result.error.phase, "verify");
  assert.match(result.error.message, /2 次完整观察/); assert.match(result.error.message, /最后可见匹配数 0/);
});

test("one unmet observation, a previously met frame, or no valid verification frame retain ordinary timeout", async () => {
  const cases = [
    { page: (read: number, signal: AbortSignal) => read >= 3 ? untilAbort(signal) : snapshot(), completed: 1, matched: 0 },
    { page: (read: number, signal: AbortSignal) => read >= 4 ? untilAbort(signal) : snapshot(read === 2 ? "EXPECTED" : "CURRENT"), completed: 2, matched: 1 },
    { page: (read: number, signal: AbortSignal) => read >= 2 ? untilAbort(signal) : snapshot(), completed: undefined, matched: undefined },
  ];
  for (const item of cases) {
    const result = await timeoutCase(item.page);
    assert.equal(result.error.code, "timeout"); assert.equal(result.inputs, 1); assert.equal(result.step.dispatchState, "sent");
    assert.equal(result.context.verification?.completedObservations, item.completed);
    assert.equal(result.context.verification?.matchedObservations, item.matched);
  }
});

test("unrecovered read failure retains ordinary timeout, while a later complete read clears that failure", async () => {
  const failed = await timeoutCase((read, signal) => {
    if (read === 4) throw new DebugObservationError("hierarchy_unavailable", "Fixture transient failure");
    return read >= 5 ? untilAbort(signal) : snapshot();
  });
  assert.equal(failed.context.verification?.completedObservations, 2);
  assert.ok(failed.context.verification!.unrecoveredObservationFailures > 0);
  assert.equal(failed.error.code, "timeout"); assert.equal(failed.inputs, 1);
  const recovered = await timeoutCase((read, signal) => {
    if (read === 3) throw new DebugObservationError("hierarchy_unavailable", "Fixture transient failure");
    return read >= 5 ? untilAbort(signal) : snapshot();
  }, 1100);
  assert.equal(recovered.context.verification?.completedObservations, 2);
  assert.equal(recovered.context.verification?.unrecoveredObservationFailures, 0);
  assert.equal(recovered.error.code, "expectation_not_met_timeout"); assert.equal(recovered.inputs, 1);
});

test("a real read fault arriving at the deadline is not treated as merely cancelling the last read", async () => {
  const result = await timeoutCase((read, signal) => read >= 4 ? new Promise<UiSnapshot>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DebugObservationError("hierarchy_unavailable", "Fixture read fault")), { once: true });
  }) : snapshot());
  assert.equal(result.context.verification?.completedObservations, 2);
  assert.equal(result.context.verification?.unrecoveredObservationFailures, 1);
  assert.equal(result.error.code, "timeout"); assert.equal(result.inputs, 1);
});

test("classification requires the deadline and all conservative verification counters", () => {
  const verification = { completedObservations: 4, lastVisibleMatchCount: 2, matchedObservations: 0,
    consecutiveMatches: 0, unrecoveredObservationFailures: 0 };
  const context = { phase: "capture", step: {}, verification } as StepContext;
  const classified = debugStepFailure(new Error("fixture"), context, true, false);
  assert.equal(classified.code, "expectation_not_met_timeout"); assert.match(classified.message, /最后可见匹配数 2/);
  assert.equal(debugStepFailure(new Error("fixture"), context, false, true).code, "cancelled");
  for (const override of [{ completedObservations: 1 }, { lastVisibleMatchCount: null }, { matchedObservations: 1 },
    { consecutiveMatches: 1 }, { unrecoveredObservationFailures: 1 }]) {
    context.verification = { ...verification, ...override };
    assert.equal(debugStepFailure(new Error("fixture"), context, true, false).code, "timeout");
  }
});
