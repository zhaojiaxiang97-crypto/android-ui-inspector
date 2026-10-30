// Isolated module mocks: no real ADB, SDK connection, screenshot or device input.
import assert from "node:assert/strict";
import { mock } from "bun:test";
const scenario = process.argv[2], packageName = "com.example.observe", serial = "offline-observe";
const frame = { width: 100, height: 200, rotation: 0 };
const target = { packageName, component: packageName + "/.Main", activityName: ".Main", activityRecordId: "a", windowId: "b" };
const controller = new AbortController();
let targets = 0, cleaned = 0, treeStarted = false, screenFinished = false, inputCalls = 0;
let enteredScreen;
const screenEntered = new Promise(resolve => { enteredScreen = resolve; });
const xml = `<?xml version="1.0"?><hierarchy rotation="${scenario === "geometry-window" ? 1 : 0}"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="${scenario === "foreign-tree" ? "com.other.app" : packageName}" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][100,200]" /></hierarchy>`;
const reply = (text = "", code = 0, stderr = "") => ({ code, stdout: Buffer.from(text), stderr });
mock.module("../../electron/device/target.ts", () => ({
  automationAdb: () => "/fixture/adb",
  checkedDebugTarget: async () => { targets++; if (scenario === "foreign-target" && targets > 1) throw Error("前台 App 已离开授权范围");
    return { ...target, windowId: /window/.test(scenario) && targets > 1 ? "changed" : target.windowId }; },
  sameActivityInstance: (a, b) => a.component === b.component && a.activityRecordId === b.activityRecordId,
}));
mock.module("../../electron/device/runtime.ts", () => ({
  runCommand: async (_adb, args) => {
    if (args.includes("uiautomator")) { treeStarted = true; await screenEntered; return reply(); }
    if (args.includes("rm")) { cleaned++; return reply(); }
    throw Error("Unexpected command: " + args.join(" "));
  },
  runDeviceAdb: async (_adb, _serial, args) => {
    assert.deepEqual(args.slice(0, 2), ["exec-out", "cat"]);
    if (scenario === "missing-tree") return reply("", 1, `${args[2]}: No such file or directory`);
    if (scenario === "offline") return reply("", 1, "error: device offline");
    if (scenario === "oversized") return reply("x".repeat(8 * 1024 * 1024 + 1));
    return reply(scenario.startsWith("empty") ? "" : xml);
  },
  commandError: (label, result) => label + ": " + result.stderr.toString(),
  captureSignal: signal => signal,
}));
mock.module("../../electron/device/screen.ts", () => ({
  readDisplayFrame: async () => frame,
  captureScreen: async () => {
    assert.equal(treeStarted, true); enteredScreen();
    await new Promise(resolve => setTimeout(resolve, 20));
    screenFinished = true;
    if (scenario === "cancel") controller.abort(new Error("cancelled fixture"));
    if (scenario === "empty-screen-rejected") throw Error("截图通道断开");
    return { screenshotDataUrl: scenario === "empty-screen-null" ? null : "data:image/png;base64,fixture",
      captureGeometry: { beforeScreenshot: frame, afterScreenshot: scenario === "empty-screen-geometry" ? { ...frame, rotation: 1 } : frame,
        screenshotSize: frame, hierarchyRotation: 0 } };
  },
}));
mock.module("../../electron/capture/inspection.ts", () => ({ inspectPreferredDevice: async () => { throw Error("Unexpected deep capture"); } }));
mock.module("../../electron/device/debug-input.ts", () => ({ runDebugInputCommand: async () => { inputCalls++; throw Error("Unexpected input"); } }));
const { observeDebugApp } = await import("../../electron/automation/device-actions.ts");
let result, error, errorCode;
try { result = await observeDebugApp({}, serial, packageName, "fast", controller.signal); }
catch (caught) { error = caught.message; errorCode = caught.code; }
console.log(JSON.stringify({ targets, cleaned, screenFinished, inputCalls, nodeCount: result?.snapshot.nodeCount, error, errorCode }));
