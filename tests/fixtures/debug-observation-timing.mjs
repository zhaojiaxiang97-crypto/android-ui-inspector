// Isolated real observation orchestration with fixed mocks; never touches a device.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import { createDebugTiming, runWithDebugTiming, withDebugObservationReason, measureDebugCommand } from "../../electron/automation/debug-timing.ts";
const scenario = process.argv[2], packageName = "com.example.observe", serial = "offline-observe";
const frame = { width: 100, height: 200, rotation: 0 };
const target = { packageName, component: packageName + "/.Main", activityName: ".Main", activityRecordId: "a", windowId: "b" };
const controller = new AbortController();
let targets = 0, cleaned = 0, treeStarted = false, screenFinished = false, inputCalls = 0;
let enteredScreen;
const screenEntered = new Promise(resolve => { enteredScreen = resolve; });
const xml = `<?xml version="1.0"?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="${packageName}" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][100,200]" /></hierarchy>`;
const reply = (text = "") => ({ code: 0, stdout: Buffer.from(text), stderr: "" });
mock.module("../../electron/device/target.ts", () => ({
  automationAdb: () => "/fixture/adb",
  checkedDebugTarget: async () => measureDebugCommand("target", async () => { targets++; return { ...target }; }),
  sameActivityInstance: (a, b) => a.component === b.component && a.activityRecordId === b.activityRecordId,
}));
mock.module("../../electron/device/runtime.ts", () => ({
  runCommand: async (_adb, args) => {
    if (args.includes("uiautomator")) return measureDebugCommand("hierarchy_dump", async () => {
      treeStarted = true; if (scenario !== "ordered") await screenEntered; return reply();
    });
    if (args.includes("rm")) return measureDebugCommand("cleanup", async () => { cleaned++; return reply(); });
    throw Error("Unexpected fixture command");
  },
  runDeviceAdb: async (_adb, _serial, args) => measureDebugCommand("hierarchy_read", async () => {
    assert.deepEqual(args.slice(0, 2), ["exec-out", "cat"]); return reply(scenario === "empty-tree" ? "" : xml);
  }),
  commandError: label => label,
  captureSignal: signal => signal,
}));
mock.module("../../electron/device/screen.ts", () => ({
  readDisplayFrame: async () => frame,
  captureScreen: async () => measureDebugCommand("screenshot", async () => {
    assert.equal(treeStarted, true); enteredScreen();
    if (scenario === "ordered") assert.equal(cleaned, 1);
    await new Promise(resolve => setTimeout(resolve, 20)); screenFinished = true;
    if (scenario === "cancel") controller.abort(new Error("cancelled fixture"));
    return { screenshotDataUrl: "data:image/png;base64,fixture",
      captureGeometry: { beforeScreenshot: frame, afterScreenshot: frame, screenshotSize: frame, hierarchyRotation: 0 } };
  }),
}));
mock.module("../../electron/capture/inspection.ts", () => ({ inspectPreferredDevice: async () => { throw Error("Unexpected deep capture"); } }));
mock.module("../../electron/device/debug-input.ts", () => ({ runDebugInputCommand: async () => { inputCalls++; throw Error("Unexpected input"); } }));
const { observeDebugApp } = await import("../../electron/automation/device-actions.ts");
const timing = createDebugTiming();
let result, error;
try {
  result = await runWithDebugTiming(timing, () => withDebugObservationReason("explicit", () => observeDebugApp({}, serial, packageName,
    "fast", controller.signal, "uiautomator", "standard", scenario === "ordered" ? "after-hierarchy" : "parallel")));
} catch (caught) { error = caught.message; }
const timings = timing.finish(error ? scenario === "cancel" ? "cancelled" : "failed" : "success");
console.log(JSON.stringify({ targets, cleaned, screenFinished, inputCalls, nodeCount: result?.snapshot.nodeCount, error, timings }));
