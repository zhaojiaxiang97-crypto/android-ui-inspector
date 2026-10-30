import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { CapturePlan } from "../electron/capture/capture-plan";
import { createCaptureAttemptContext, createCaptureRunContext, notifyViewTreeReady, withCaptureSignal } from "../electron/capture/run-context";
import { captureListViewItems, captureViewGroupImage, captureViewNodes, captureViewStyle } from "../electron/capture/refresh";
import { acceptSdkMergedTree, bitmapTarget, captureSdkRefLayers, captureSdkVisibleLayers, readSdkBranchGeometry, readSdkCapture } from "../electron/capture/sdk-images";
import { verifySdkTreeIdentity } from "../electron/capture/sdk-tree-verification";
import { createInspectionRunner } from "../electron/capture/inspection";
import type { ProviderClient } from "../electron/sdk/provider-session";
import type { UiNode, UiSnapshot } from "../shared/types";

const evidence = { nodeCount: 5000, verified: true, visibleStream: "2", uiWake: "1", hardwareAccelerated: "true" };
const blocked = /标准模式/;
const unused = () => assert.fail("standard mode must not touch an SDK provider, device query or adoption callback");
const provider: ProviderClient = { open: unused, call: unused };
// The deliberately invalid serial prevents real ADB activity even if an early policy guard regresses.
const serial = "offline policy fixture";
function sdkSnapshot(): UiSnapshot {
  const child: UiNode = { ...makeNode("0/0"), bounds: { left: 0, top: 0, right: 100, bottom: 100, raw: "[0,0][100,100]" },
    attributes: { "view-ref": "FrameLayout@a", "hardware-accelerated": "true" }, children: [makeNode("0/0/0")] };
  const root: UiNode = { ...makeNode("0"), package: "sample.app", bounds: child.bounds, children: [child], attributes: {
    "debug-process-id": "42", "debug-component": "sample.app/.MainActivity", "debug-window-name": "fixture-window",
    "sdk-process-instance": "11111111-1111-1111-1111-111111111111", "sdk-visible-process-instance": "11111111-1111-1111-1111-111111111111",
    "sdk-visible-stream": "2", "sdk-ui-wake-version": "1", "sdk-style-version": "1", "sdk-ref-debug-canvas-version": "1",
  } };
  return { serial, root, nodeCount: 3, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null, inspectionSource: "debug-hybrid" };
}

test("default standard policy cannot be promoted by old image preferences or modern SDK evidence", () => {
  for (const preferVisibleSdk of [undefined, false, true]) {
    const request = createCaptureRunContext({ preferVisibleSdk });
    for (const context of [request, createCaptureAttemptContext(request, { startupRetry: true }), withCaptureSignal(request, new AbortController().signal)]) {
      assert.equal(context.plan.inspectionMode, "standard");
      assert.equal(context.plan.allowsSdk, false);
      assert.equal(context.plan.sdkFirstCandidate(5000, true), false);
      assert.equal(context.plan.acceptVerifiedSdk(evidence), false);
      assert.equal(context.plan.imageRoute, "ddms");
      assert.throws(() => context.plan.requireSdk(), blocked);
    }
  }
  const enhanced = new CapturePlan(undefined, false, "sdk-enhanced");
  assert.equal(enhanced.acceptVerifiedSdk(evidence), true);
  assert.equal(enhanced.imageRoute, "sdk");
  assert.doesNotThrow(() => enhanced.requireSdk());
});

test("standard tree handoff and prefetched SDK evidence perform zero verification or adoption work", async () => {
  const snapshot = sdkSnapshot(), before = structuredClone(snapshot.root);
  const context = { ...createCaptureRunContext({ preferVisibleSdk: true, onViewTreeReady: unused }), treeVerifier: unused };
  await notifyViewTreeReady(context, "sample.app", snapshot.root!, "adopt", { version: 1 });
  for (const prefetched of [undefined, { version: 1 }]) {
    const result = await verifySdkTreeIdentity({ serial, packageName: "sample.app", root: snapshot.root!, prefetched },
      { installed: unused, target: unused, pid: unused, read: unused });
    assert.equal(result, null);
  }
  assert.deepEqual(snapshot.root, before);
  assert.equal(context.plan.imageRoute, "ddms");
});

test("standard SDK entrypoints reject before probing, opening, capturing or reading files", async () => {
  const snapshot = sdkSnapshot(), root = snapshot.root!, context = createCaptureRunContext({ preferVisibleSdk: true });
  const runner = createInspectionRunner({ automationAdb: unused, checkedDebugTarget: unused, singleAppPid: unused, readSdkCapture: unused });
  await assert.rejects(runner.inspectHybridDevice(provider, serial, "sample.app"), blocked);
  await assert.rejects(readSdkCapture(provider, "must-not-run-adb", serial, "sample.app", context), blocked);
  await assert.rejects(captureSdkVisibleLayers(provider, "must-not-run-adb", serial, "sample.app", root, unused, undefined, context), blocked);
  await assert.rejects(captureSdkRefLayers(provider, "must-not-run-adb", serial, "sample.app", root, ["FrameLayout@a"], true), blocked);
  await assert.rejects(readSdkBranchGeometry(provider, "must-not-run-adb", serial, {
    packageName: "sample.app", pid: 42, processInstance: root.attributes!["sdk-process-instance"], rootRef: "FrameLayout@a", branchRef: "View@b",
  }, ["FrameLayout@a", "View@b"]), blocked);
  await assert.rejects(acceptSdkMergedTree({ value: {}, adbPath: "must-not-run-adb", serial, packageName: "sample.app", processId: "42",
    before: { component: "sample.app/.MainActivity", windowId: "window" }, root, notice: unused, withTree: { onTree: unused }, callStarted: 0,
  }, context, { checkedTarget: unused, pid: unused, now: unused }), blocked);
  assert.equal(bitmapTarget(provider, "must-not-run-adb", serial, "sample.app", root, "FrameLayout@a", "window").wakeUi, undefined);
});

test("standard refresh rejects SDK snapshots and never wakes or refetches old SDK data even with text experiment enabled", async () => {
  const previous = process.env.INSPECTOR_ENABLE_SDK_TEXT_REFRESH;
  process.env.INSPECTOR_ENABLE_SDK_TEXT_REFRESH = "1";
  try {
    for (const source of ["debug-hybrid", "debug-view"] as const) {
      const snapshot = { ...sdkSnapshot(), inspectionSource: source }, before = structuredClone(snapshot);
      for (const branch of [false, true]) await assert.rejects(captureViewNodes(provider, serial, snapshot, "0/0", branch), /重新采集整页/);
      await assert.rejects(captureListViewItems(provider, serial, snapshot, "0/0"), /重新采集整页/);
      assert.equal(await captureViewGroupImage(provider, serial, snapshot, "0/0"), null);
      await assert.rejects(captureViewStyle(provider, serial, snapshot, "0/0"), blocked);
      assert.deepEqual(snapshot, before, "offline SDK data remains readable and unchanged");
    }
  } finally {
    if (previous === undefined) delete process.env.INSPECTOR_ENABLE_SDK_TEXT_REFRESH;
    else process.env.INSPECTOR_ENABLE_SDK_TEXT_REFRESH = previous;
  }
});

test("explicit enhanced refresh retains the existing validation path after each final mode argument", async () => {
  const snapshot = sdkSnapshot(), invalidSerial = /设备序列号无效/;
  for (const branch of [false, true]) await assert.rejects(captureViewNodes(provider, serial, snapshot, "0/0", branch, undefined, "sdk-enhanced"), invalidSerial);
  await assert.rejects(captureListViewItems(provider, serial, snapshot, "0/0", undefined, "sdk-enhanced"), invalidSerial);
  await assert.rejects(captureViewGroupImage(provider, serial, snapshot, "0/0", undefined, "sdk-enhanced"), invalidSerial);
  await assert.rejects(captureViewStyle(provider, serial, snapshot, "0/0", "sdk-enhanced"), invalidSerial);
});

test("mode gates preserve cancellation and never turn cancelled work into an optional success", async () => {
  const controller = new AbortController(), reason = new Error("cancel optional SDK work"); controller.abort(reason);
  const snapshot = sdkSnapshot(), context = createCaptureRunContext({ signal: controller.signal });
  const sameReason = (error: unknown) => error === reason;
  await assert.rejects(notifyViewTreeReady(context, "sample.app", snapshot.root!), sameReason);
  await assert.rejects(readSdkCapture(provider, "must-not-run-adb", serial, "sample.app", context), sameReason);
  await assert.rejects(captureSdkVisibleLayers(provider, "must-not-run-adb", serial, "sample.app", snapshot.root!, unused, undefined, context), sameReason);
  await assert.rejects(captureViewNodes(provider, serial, snapshot, "0/0", false, controller.signal), sameReason);
  await assert.rejects(captureListViewItems(provider, serial, snapshot, "0/0", controller.signal), sameReason);
  await assert.rejects(captureViewGroupImage(provider, serial, snapshot, "0/0", controller.signal), sameReason);
});
