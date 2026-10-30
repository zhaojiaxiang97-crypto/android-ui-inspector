// Child-process fixture: mock only the observer's capture/target boundaries.
// No ADB process, Provider connection or device input is allowed.
import assert from "node:assert/strict";
import { mock } from "bun:test";

const scenario = process.argv[2];
const packageName = "com.example.observer", serial = "observer-mode-fixture";
const controller = new AbortController(), failure = new Error("capture fixture failure");
const provider = { open: async () => { throw Error("Unexpected SDK open"); }, call: async () => { throw Error("Unexpected SDK call"); } };
const frame = { width: 100, height: 200, rotation: 0 };
const target = { packageName, component: packageName + "/.Main", activityName: ".Main", activityRecordId: "a", windowId: "b" };
const calls = [];
let targets = 0;

mock.module("../../electron/device/target.ts", () => ({
  automationAdb: selected => { assert.equal(selected, serial); return "/fixture/adb"; },
  checkedDebugTarget: async (_path, selected, expected) => {
    assert.equal(selected, serial); assert.equal(expected, packageName); targets++;
    return { ...target, windowId: scenario === "window-changed" && targets > 1 ? "new" : target.windowId };
  },
  sameActivityInstance: (left, right) => left.component === right.component && left.activityRecordId === right.activityRecordId,
}));
mock.module("../../electron/capture/inspection.ts", () => ({
  inspectPreferredDevice: async (receivedProvider, selected, options) => {
    assert.equal(receivedProvider, provider); assert.equal(selected, serial);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.expectedPackage, packageName); assert.equal(options.allowAppRestart, false);
    calls.push({ inspectionMode: options.inspectionMode });
    if (scenario === "thrown-error") throw failure;
    if (scenario === "cancelled") controller.abort(failure);
    return { serial, root: null, nodeCount: 0, xmlSize: 0, rawXml: null, screenshotDataUrl: null,
      error: scenario === "reported-error" ? failure.message : null,
      captureGeometry: { hierarchyRotation: 0, beforeScreenshot: frame, afterScreenshot: frame, screenshotSize: frame } };
  },
}));

const { observeDebugApp } = await import("../../electron/automation/device-actions.ts");
let error, sourceErrorPreserved = false, result;
try {
  result = await observeDebugApp(provider, serial, packageName, "deep", controller.signal, "uiautomator",
    scenario === "enhanced" ? "sdk-enhanced" : scenario === "standard" ? "standard" : undefined);
} catch (caught) { error = caught.message; sourceErrorPreserved = caught === failure; }
console.log(JSON.stringify({ calls, targets, error, sourceErrorPreserved, captureMode: result?.snapshot.captureMode }));
