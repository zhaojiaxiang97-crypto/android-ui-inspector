// Isolated adapter tests: target/display reads and Helper dispatch are mocks; no device is contacted.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock } from "bun:test";
import { helperEvidenceSnapshot } from "./helper-evidence.ts";

const scenario = process.argv[2], packageName = "com.example.helper", serial = "offline-helper-target";
const frame = { width: 100, height: 200, rotation: 0 };
const target = { packageName, component: packageName + "/.Main", activityName: ".Main", activityRecordId: "activity", windowId: "window" };
let deviceCommands = 0, helperCalls = 0, targetReads = 0, frameReads = 0, descriptor;
const unexpected = async () => { deviceCommands++; throw new Error("Unexpected device command"); };
mock.module("../../electron/device/target.ts", () => ({
  automationAdb: () => "/fixture/adb",
  checkedDebugTarget: async () => { targetReads++; return scenario === "target-change" ? { ...target, windowId: "other" } : target; },
  sameActivityInstance: (a, b) => a.component === b.component && a.activityRecordId === b.activityRecordId,
}));
mock.module("../../electron/device/screen.ts", () => ({
  readDisplayFrame: async () => { frameReads++; return scenario === "display-change" ? { ...frame, width: 101 } : frame; }, captureScreen: unexpected,
}));
mock.module("../../electron/device/runtime.ts", () => ({ runCommand: unexpected, runDeviceAdb: unexpected,
  commandError: () => "Unexpected command error", captureSignal: signal => signal }));
mock.module("../../electron/capture/inspection.ts", () => ({ inspectPreferredDevice: unexpected }));
const { createHelperDebugInput } = await import("../../electron/automation/helper-input.ts");
const { HelperInputError } = await import("../../electron/capture/helper-input.ts");
const snapshot = helperEvidenceSnapshot({ packageName, serial, ...frame }), source = snapshot.helperObservation;
const node = structuredClone(snapshot.root);
Object.assign(node, { resourceId: null, contentDesc: "我", className: "androidx.appcompat.app.ActionBar$Tab" });
Object.assign(node.attributes, { "resource-id": "", "content-desc": "我", class: node.className });
if (scenario === "id-priority" || scenario === "swipe-id") { node.resourceId = packageName + ":id/tab"; node.attributes["resource-id"] = node.resourceId; }
if (scenario === "no-desc") { node.contentDesc = null; node.attributes["content-desc"] = ""; }
if (scenario === "invalid-id") node.resourceId = " ";
if (scenario === "long-id" || scenario === "swipe-invalid-id") node.resourceId = "x".repeat(513);
if (scenario === "missing-raw") delete node.attributes["resource-id"];
if (scenario === "invalid-class") node.className = "";
if (scenario === "bad-bounds") node.bounds.right = 101;
if (scenario === "long-desc") node.contentDesc = "我".repeat(513);
if (scenario === "no-id-scroll") { node.scrollable = true; node.attributes["scroll-forward-supported"] = "true"; }
const helper = {
  input: async (_adb, actualPackage, display, evidence, action, signal, selected) => {
    helperCalls++; signal.throwIfAborted(); assert.equal(actualPackage, packageName); assert.deepEqual(display, frame); assert.equal(evidence, source);
    descriptor = selected;
    if (scenario.startsWith("swipe-")) assert.equal(action.kind, "swipe");
    const requestId = randomUUID();
    if (scenario === "failed") throw new HelperInputError("fixture lost reply", "unknown", requestId);
    return { version: 1, sessionId: randomUUID(), requestId, serviceInstanceId: source.serviceInstanceId, captureId: source.captureId,
      packageName, windowId: source.windowId, display, status: "completed", dispatchState: "sent",
      startedAtMs: source.timing.completedAtMs + 1, finishedAtMs: source.timing.completedAtMs + 2,
      method: selected ? "accessibility-click" : "gesture" };
  },
};
const controller = new AbortController(); if (scenario === "cancelled") controller.abort(new Error("fixture cancelled"));
const evidence = [];
const result = await createHelperDebugInput(helper)(serial, target,
  scenario.startsWith("swipe-") ? { kind: "swipe", fromX: 50, fromY: 160, toX: 50, toY: 40, durationMs: 350 }
    : scenario === "no-id-scroll" ? { kind: "scroll", direction: "down" } : { kind: "tap", x: 50, y: 100 },
  frame, source, controller.signal, receipt => evidence.push(receipt), node).then(() => ({ success: true }), error => ({ error }));
assert.equal(evidence.length, 1); assert.equal(deviceCommands, 0); assert.ok(helperCalls <= 1, "never retry or fall back after a failed dispatch");
const receipt = evidence[0];
if (["no-id", "id-priority", "failed"].includes(scenario)) {
  assert.deepEqual(descriptor, { ...(scenario === "id-priority" ? { resourceId: node.resourceId } : {}), className: node.className,
    text: node.text, contentDesc: "我", bounds: { left: 0, top: 0, right: 100, bottom: 200 } });
  if (scenario !== "failed") { assert.equal(result.success, true); assert.equal(receipt.helperInput.receipt.method, "accessibility-click"); }
} else if (scenario === "no-desc" || scenario.startsWith("swipe-")) {
  assert.equal(descriptor, undefined); assert.equal(result.success, true); assert.equal(receipt.helperInput.receipt.method, "gesture");
} else { assert.ok(result.error); assert.equal(helperCalls, 0); }
if (scenario === "failed") { assert.ok(result.error); assert.equal(receipt.helperInput.dispatchState, "unknown"); assert.equal(receipt.helperInput.receipt, undefined); }
if (scenario === "cancelled" || scenario === "no-id-scroll") { assert.equal(targetReads, 0); assert.equal(frameReads, 0); }
console.log(JSON.stringify({ helperCalls, deviceCommands, dispatchState: receipt.helperInput.dispatchState }));
