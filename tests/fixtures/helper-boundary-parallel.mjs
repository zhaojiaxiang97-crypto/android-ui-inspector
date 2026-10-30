// Isolated mocks only: no ADB, HTTP, screenshots or input is sent to a device.
import assert from "node:assert/strict";
import { mock } from "bun:test";

const [mode, scenario] = process.argv.slice(2);
assert.ok(["wait", "observe"].includes(mode));
const packageName = "com.example.boundary", serial = "offline-helper-boundary";
const frame = { width: 100, height: 200, rotation: 0 };
const target = { packageName, component: packageName + "/.Main", activityName: ".Main", activityRecordId: "activity", windowId: "window" };
const controller = new AbortController();
const targetError = new Error("fixture target failure"), frameError = new Error("fixture frame failure"), cancelError = new Error("fixture cancelled");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const boundaries = Array.from({ length: 2 }, () => ({
  target: { entered: deferred(), result: deferred() },
  frame: { entered: deferred(), result: deferred() },
}));
let targets = 0, frames = 0, inFlight = 0, releases = 0, helperCalls = 0, inputs = 0, finished = false;
const helperEntered = deferred();
async function boundaryRead(kind) {
  const index = kind === "target" ? targets++ : frames++;
  assert.ok(index < 2, "no extra boundary queries");
  const task = boundaries[index][kind];
  inFlight++;
  task.entered.resolve();
  try { return await task.result.promise; }
  finally { inFlight--; }
}
const unexpected = async () => { throw new Error("Unexpected device command"); };
mock.module("../../electron/device/target.ts", () => ({
  automationAdb: () => "/fixture/adb",
  checkedDebugTarget: () => boundaryRead("target"),
  sameActivityInstance: (a, b) => a.component === b.component && a.activityRecordId === b.activityRecordId,
}));
mock.module("../../electron/device/screen.ts", () => ({ readDisplayFrame: () => boundaryRead("frame"), captureScreen: unexpected }));
mock.module("../../electron/device/runtime.ts", () => ({ runCommand: unexpected, runDeviceAdb: unexpected,
  commandError: () => "Unexpected command error", captureSignal: signal => signal }));
mock.module("../../electron/capture/inspection.ts", () => ({ inspectPreferredDevice: unexpected }));
mock.module("../../electron/device/debug-input.ts", () => ({
  runDebugInputCommand: async () => { inputs++; throw new Error("Unexpected input"); }, inspectSystemInputInjection: unexpected,
}));
const hint = { status: "ready", marker: "fixture hint" };
const observed = { root: { id: "0", package: packageName, children: [] }, nodeCount: 1, xml: "<hierarchy/>",
  screenshotDataUrl: "data:image/png;base64,fixture", captureGeometry: {
    screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0,
  } };
async function helperRead(value) {
  assert.equal(inFlight, 0, "the first boundary must settle before contacting Helper");
  assert.equal(targets, 1); assert.equal(frames, 1);
  helperCalls++;
  helperEntered.resolve();
  return value;
}
const session = {
  wait: () => helperRead(hint), read: () => helperRead(observed),
  release: async () => { assert.equal(inFlight, 0, "cleanup must join both boundary reads"); releases++; },
};
const { observeDebugApp, waitDebugAppCondition } = await import("../../electron/automation/device-actions.ts");
const operation = mode === "wait"
  ? waitDebugAppCondition(session)(serial, packageName, { selector: { resourceId: packageName + ":id/ready" }, state: "visible" }, controller.signal)
  : observeDebugApp({}, serial, packageName, "fast", controller.signal, "accessibility-helper", "standard", "parallel", session);
const outcome = operation.then(value => { finished = true; return { value }; }, error => { finished = true; return { error }; });
const entered = pair => Promise.all([pair.target.entered.promise, pair.frame.entered.promise]);
const resolve = pair => { pair.target.result.resolve({ ...target }); pair.frame.result.resolve({ ...frame }); };
async function stillPending() {
  // The unresolved deferred proves ordering; microtasks merely let a fail-fast path run.
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(finished, false, "the operation must not return while a boundary query is pending");
  assert.equal(releases, 0, "the session must not release while a boundary query is pending");
}
// Only a deadlock diagnostic, never a performance/success assertion.
const watchdog = setTimeout(() => { throw new Error("Boundary tasks did not reach the fixture barrier"); }, 3000);
try {
  await entered(boundaries[0]);
  if (scenario.startsWith("after-") || scenario === "success") {
    resolve(boundaries[0]);
    await helperEntered.promise;
    await entered(boundaries[1]);
    if (scenario === "after-target-slow-frame") {
      boundaries[1].target.result.reject(targetError);
      await stillPending();
      boundaries[1].frame.result.resolve(frame);
    } else if (scenario === "after-frame-failure") {
      boundaries[1].target.result.resolve(target);
      boundaries[1].frame.result.reject(frameError);
    } else if (scenario === "after-cancel") {
      controller.abort(cancelError);
      boundaries[1].target.result.resolve(target);
      await stillPending();
      boundaries[1].frame.result.resolve(frame);
    } else {
      boundaries[1].target.result.resolve(target);
      await stillPending();
      boundaries[1].frame.result.resolve(frame);
    }
  } else if (scenario === "before-target-slow-frame") {
    boundaries[0].target.result.reject(targetError);
    await stillPending();
    assert.equal(helperCalls, 0, "a failed boundary must not contact Helper");
    boundaries[0].frame.result.resolve(frame);
  } else if (scenario === "before-both-fail") {
    boundaries[0].target.result.reject(targetError);
    boundaries[0].frame.result.reject(frameError);
  } else if (scenario === "before-cancel") {
    controller.abort(cancelError);
    boundaries[0].target.result.resolve(target);
    await stillPending();
    assert.equal(helperCalls, 0, "cancellation must not contact Helper");
    boundaries[0].frame.result.resolve(frame);
  } else throw new Error("Unknown scenario: " + scenario);
  const result = await outcome;
  const expected = scenario === "success" ? undefined : scenario.includes("cancel") ? cancelError
    : scenario === "after-frame-failure" ? frameError : targetError;
  assert.equal(result.error, expected, "target failure takes priority and no failed/cancelled boundary returns data");
  assert.equal(releases, expected ? 1 : 0);
  assert.equal(helperCalls, scenario.startsWith("before-") ? 0 : 1);
  assert.equal(inFlight, 0); assert.equal(inputs, 0);
  if (!expected) assert.equal(mode === "wait" ? result.value : result.value.snapshot.nodeCount, mode === "wait" ? hint : 1);
  console.log(JSON.stringify({ mode, scenario, targets, frames, helperCalls, releases, inputs, success: !result.error }));
} finally { clearTimeout(watchdog); }
