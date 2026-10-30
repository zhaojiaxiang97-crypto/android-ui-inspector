import assert from "node:assert/strict";
import { mock } from "bun:test";
import { helperEvidenceSnapshot } from "./helper-evidence.ts";

const scenario = process.argv[2], packageName = "com.example.helper", serial = "fixture";
const frame = { width: 400, height: 800, rotation: 0 };
const target = { packageName, component: packageName + "/.Main", activityName: ".Main", activityRecordId: "activity", windowId: "window" };
const snapshot = helperEvidenceSnapshot({ startedAt: 100, packageName, serial, ...frame }), source = snapshot.helperObservation;
let calls = 0, shellInputs = 0, recorded, nodeTargetSeen;
const unexpected = async () => { throw Error("Unexpected device call"); };
mock.module("../../electron/device/target.ts", () => ({ automationAdb: () => "/fixture/adb",
  checkedDebugTarget: async () => scenario === "window" ? { ...target, windowId: "changed" } : target,
  sameActivityInstance: (a, b) => a.component === b.component && a.activityRecordId === b.activityRecordId }));
mock.module("../../electron/device/screen.ts", () => ({ readDisplayFrame: async () => scenario === "display" ? { ...frame, rotation: 1 } : frame, captureScreen: unexpected }));
mock.module("../../electron/device/runtime.ts", () => ({ runCommand: unexpected, runDeviceAdb: unexpected, commandError: () => "Unexpected command", captureSignal: signal => signal }));
mock.module("../../electron/capture/inspection.ts", () => ({ inspectPreferredDevice: unexpected }));
const originalInput = await import("../../electron/device/debug-input.ts");
mock.module("../../electron/device/debug-input.ts", () => ({ ...originalInput,
  runDebugInputCommand: async () => { shellInputs++; throw Error("Unexpected shell input"); } }));
const { HelperInputError } = await import("../../electron/capture/helper-input.ts");
const { createHelperDebugInput } = await import("../../electron/automation/helper-input.ts");
const { debugInputEvidenceSchema } = await import("../../shared/debug-scroll-validation.ts");
const { debugInputMayHaveDispatched } = await import("../../shared/debug-input-state.ts");
const requestId = "11111111-1111-4111-8111-111111111111";
const helper = { input: async (adb, name, actualFrame, evidence, action, signal, nodeTarget) => {
  calls++; assert.equal(adb, "/fixture/adb"); assert.equal(name, packageName); assert.equal(evidence, source);
  assert.deepEqual(actualFrame, frame); assert.equal(action.kind, "tap"); assert.equal(signal.aborted, false);
  nodeTargetSeen = nodeTarget;
  if (scenario === "network") throw new HelperInputError("Network ended", "unknown", requestId);
  const status = ["rejected", "cancelled", "timeout"].includes(scenario) ? scenario : "completed";
  return { version: 1, sessionId: "22222222-2222-4222-8222-222222222222", requestId,
    serviceInstanceId: source.serviceInstanceId, captureId: source.captureId, packageName, windowId: source.windowId, display: frame,
    method: nodeTarget ? "accessibility-click" : "gesture",
    status, dispatchState: status === "completed" ? "sent" : status === "rejected" ? "not_sent" : "unknown",
    ...(status === "completed" ? {} : { errorCode: status === "rejected" ? "dispatch_rejected" : status }),
    startedAtMs: source.timing.completedAtMs + 1, finishedAtMs: source.timing.completedAtMs + 2 };
} };
const cancellation = new AbortController();
if (scenario === "abort-before") cancellation.abort();
let error;
try { await createHelperDebugInput(scenario === "missing-session" ? undefined : helper)(serial, target,
  { kind: "tap", x: scenario === "bounds" ? frame.width : 10, y: 20 }, frame,
  scenario === "missing-source" ? undefined : source, cancellation.signal, value => { recorded = value; },
  scenario === "semantic" ? snapshot.root : undefined); }
catch (value) { error = value; }
assert.equal(shellInputs, 0);
const before = ["abort-before", "window", "display", "bounds", "missing-session", "missing-source"].includes(scenario);
assert.equal(calls, before ? 0 : 1);
if (scenario === "semantic") assert.deepEqual(nodeTargetSeen, { resourceId: packageName + ":id/result", className: "android.widget.TextView",
  text: "完成", bounds: { left: 0, top: 0, right: frame.width, bottom: frame.height } });
else assert.equal(nodeTargetSeen, undefined);
assert.equal(debugInputEvidenceSchema.safeParse(recorded).success, true, JSON.stringify(recorded));
assert.equal(recorded.transport, "accessibility-helper"); assert.equal(recorded.spawned, false); assert.equal(recorded.closed, false);
assert.equal(recorded.exitCode, null); assert.equal(recorded.systemInjection, undefined);
assert.equal(debugInputMayHaveDispatched(recorded), !(before || scenario === "rejected"));
if (scenario === "completed" || scenario === "semantic") { assert.equal(error, undefined); assert.equal(recorded.classification, "accepted"); }
else { assert.ok(error instanceof originalInput.DebugInputError); assert.notEqual(recorded.classification, "accepted"); }
