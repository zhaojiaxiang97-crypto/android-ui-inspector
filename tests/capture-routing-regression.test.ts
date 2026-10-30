import assert from "node:assert/strict";
import { test } from "node:test";
import { createInspectionRunner, type InspectionPorts } from "../electron/capture/inspection";
import { readDebugPropertiesAndImages } from "../electron/capture/debug-image-handoff";
import { notifyViewTreeReady, type CaptureRunContext } from "../electron/capture/run-context";
import { commandSignal } from "../electron/device/command-context";
import type { ProviderClient } from "../electron/sdk/provider-session";
import type { UiNode } from "../shared/types";
import { makeNode } from "../benchmarks/fixtures";

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const ok = (text = "") => ({ code: 0, stdout: Buffer.from(text), stderr: "" });
const target = { packageName: "sample.app", component: "sample.app/.MainActivity", activityName: ".MainActivity", activityRecordId: "abc", windowId: "window-1" };
function sdk(stream = 2) {
  return { version: 1, packageName: target.packageName, pid: 42, processInstance: "11111111-1111-1111-1111-111111111111",
    capturedAtMillis: 1, nodeCount: 1, visibleStreamVersion: stream, uiWakeVersion: 1,
    root: { visible: true, clickable: false, enabled: true, focusable: false, focused: false, selected: false,
      scrollable: false, alpha: 1, elevation: 0, paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, hardwareAccelerated: true,
      ref: "android.widget.FrameLayout@a", className: "android.widget.FrameLayout", width: 100, height: 100, screenX: 0, screenY: 0, children: [] } };
}
function fillRoot(root: UiNode) {
  Object.assign(root, { ...makeNode("0"), package: target.packageName,
    attributes: { "debug-process-id": "42", "debug-component": target.component },
    children: [{ ...makeNode("0/0"), className: "android.widget.FrameLayout", text: null,
      bounds: { left: 0, top: 0, right: 100, bottom: 100, raw: "[0,0][100,100]" },
      attributes: { "view-ref": "android.widget.FrameLayout@a", "inspection-source": "debug-view" } }] });
}
async function adopt(context: CaptureRunContext, root: UiNode, serial: string, stream = 2) {
  fillRoot(root);
  await notifyViewTreeReady(context, target.packageName, root, "adopt", sdk(stream), { ...target, serial, pid: 42 });
}
function fixture(overrides: Partial<InspectionPorts> = {}, sdkInstalled = true) {
  const commands: { serial: string; args: string[] }[] = [], screens: string[] = [], opens: string[] = [];
  const provider: ProviderClient = { open: async (_adb, serial) => { opens.push(serial); return null; }, call: async () => assert.fail("no unplanned SDK business request") };
  const api = createInspectionRunner({
    findAdbPath: () => "fixture-adb", automationAdb: () => "fixture-adb",
    runDeviceAdb: async (_adb, serial, args) => {
      commandSignal()?.throwIfAborted(); commands.push({ serial, args });
      const command = args.join(" ");
      if (command === "shell dumpsys activity activities") return ok("mResumedActivity: ActivityRecord{abc u0 sample.app/.MainActivity t1}");
      if (command === "shell run-as sample.app id") return ok("uid=10001(sample.app)");
      if (command === "shell dumpsys activity sample.app") return ok("ACTIVITY sample.app/.MainActivity abc pid=42\n    View Hierarchy:\n      DecorView@abcdef[MainActivity]\n        android.widget.TextView{123456 V.E...... ........ 0,0-100,100}\n    Looper (main)");
      if (command === "shell dumpsys package sample.app") return ok(sdkInstalled ? "sample.app/com.androiduiinspector.sdk.HierarchyProvider:" : "");
      assert.fail(`unexpected command: ${command}`);
    },
    checkedDebugTarget: async () => target, singleAppPid: async () => 42,
    readDebugFocus: async () => ({ id: target.windowId, packageName: target.packageName }),
    readSdkCapture: async () => assert.fail("merged proof must not add a tree request"),
    captureDebugViewImages: async (_provider, _adb, serial, _package, root, _stage, _preview, _timings, context) => {
      await adopt(context, root, serial); return { imageCount: 0, finalScreen: null };
    },
    captureScreen: async (_adb, serial) => { screens.push(serial); return { result: ok(), screenshotDataUrl: `fixture-${serial}`, captureGeometry: undefined }; },
    ...overrides,
  });
  return { api, provider, commands, screens, opens };
}

test("default standard capture completes native properties, images and screen without any SDK probe or open", async () => {
  for (const sdkInstalled of [false, true]) for (const preferVisibleSdk of [undefined, false, true]) {
    let nativeProperties = 0, nativeImages = 0;
    const stages: string[] = [];
    const h = fixture({ captureDebugViewImages: async (_provider, _adb, _serial, _package, root, stage, _preview, _timings, context) => {
      assert.equal(context.plan.inspectionMode, "standard");
      assert.equal(context.plan.sdkFirstCandidate(5000, true), false);
      fillRoot(root);
      await readDebugPropertiesAndImages({ port: 1234, packageName: target.packageName, root, context, stage, onBatchTiming: undefined }, {
        applyViewProperties: () => { nativeProperties++; },
        captureViewLayers: async (_port, options) => {
          await options!.onHierarchy!({} as Parameters<NonNullable<NonNullable<typeof options>["onHierarchy"]>>[0], "fixture-window");
          assert.equal((options!.skipImages as () => boolean)(), false);
          nativeImages++;
          return [];
        },
      });
      assert.equal(context.plan.imageRoute, "ddms");
      return { imageCount: 0, finalScreen: null };
    } }, sdkInstalled);
    const result = await h.api.inspectPreferredDevice(h.provider, "fixture", {
      preferVisibleSdk, onViewTreeReady: async () => assert.fail("legacy SDK hook cannot enable SDK in standard mode"), onProgress: stage => { stages.push(stage); },
    });
    assert.equal(result.error, null); assert.equal(result.inspectionSource, "debug-view"); assert.ok(result.root);
    assert.equal(result.screenshotDataUrl, "fixture-fixture");
    assert.equal(nativeProperties, 1); assert.equal(nativeImages, 1);
    assert.deepEqual(h.opens, []); assert.deepEqual(h.screens, ["fixture"]);
    assert.equal(h.commands.some(call => call.args.join(" ") === "shell dumpsys package sample.app"), false);
    assert.equal(h.commands.some(call => call.args.join(" ") === "shell run-as sample.app id"), true, "native Debug eligibility checks remain enabled");
    assert.equal(stages.some(stage => stage.includes("SDK")), false);
  }
});

test("explicit enhanced capture with no installed SDK keeps the native fallback", async () => {
  const h = fixture({ captureDebugViewImages: async (_provider, _adb, _serial, _package, root, _stage, _preview, _timings, context) => {
    fillRoot(root);
    await notifyViewTreeReady(context, target.packageName, root);
    assert.equal(context.plan.imageRoute, "ddms");
    return { imageCount: 0, finalScreen: null };
  } }, false);
  const result = await h.api.inspectPreferredDevice(h.provider, "fixture", { inspectionMode: "sdk-enhanced" });
  assert.equal(result.error, null); assert.equal(result.inspectionSource, "debug-view");
  assert.equal(result.screenshotDataUrl, "fixture-fixture");
  assert.equal(h.commands.filter(call => call.args.join(" ") === "shell dumpsys package sample.app").length, 1);
  assert.deepEqual(h.opens, ["fixture"]);
});

test("concurrent preferred captures own separate verified routes and the next request starts from caller policy", async () => {
  const verifiedA = deferred(), enteredB = deferred(), contexts = new Map<string, CaptureRunContext>();
  const controllerA = new AbortController(), controllerB = new AbortController();
  const h = fixture({ captureDebugViewImages: async (_provider, _adb, serial, _package, root, _stage, _preview, _timings, context) => {
    contexts.set(serial, context); assert.equal(context.plan.preferVisibleSdk, serial === "B" ? false : undefined);
    if (serial === "A") {
      await adopt(context, root, serial); assert.equal(context.plan.imageRoute, "sdk"); verifiedA.resolve();
      await enteredB.promise; assert.equal(context.plan.imageRoute, "sdk"); assert.equal(commandSignal(), context.signal);
    } else {
      if (serial === "B") await verifiedA.promise;
      await adopt(context, root, serial, 1); assert.equal(context.plan.imageRoute, "ddms");
      if (serial === "B") enteredB.resolve();
    }
    return { imageCount: 0, finalScreen: null };
  } });
  const optionsA = Object.freeze({ inspectionMode: "sdk-enhanced" as const, signal: controllerA.signal }), optionsB = Object.freeze({ inspectionMode: "sdk-enhanced" as const, signal: controllerB.signal, preferVisibleSdk: false });
  const [a, b] = await Promise.all([h.api.inspectPreferredDevice(h.provider, "A", optionsA), h.api.inspectPreferredDevice(h.provider, "B", optionsB)]);
  const next = await h.api.inspectPreferredDevice(h.provider, "next", { inspectionMode: "sdk-enhanced" });
  for (const result of [a, b, next]) { assert.equal(result.error, null); assert.ok(result.root); assert.equal(result.captureRequestDiagnostics?.totalAttempts, 1); }
  assert.notEqual(contexts.get("A")!.plan, contexts.get("B")!.plan);
  assert.notEqual(contexts.get("A")!.request, contexts.get("B")!.request);
  assert.deepEqual(optionsA, { inspectionMode: "sdk-enhanced", signal: controllerA.signal }); assert.equal(optionsB.preferVisibleSdk, false);
  assert.deepEqual(h.screens.sort(), ["A", "B", "next"]); assert.equal(h.opens.length, 3);
  assert.equal(h.commands.filter(call => call.args.join(" ") === "shell dumpsys activity sample.app").length, 3);
});

test("late image completion from a cancelled capture cannot affect a simultaneous capture or start its screenshot", async () => {
  const aStarted = deferred(), releaseA = deferred(), controller = new AbortController(), reason = new Error("only A cancelled");
  const h = fixture({ captureDebugViewImages: async (_provider, _adb, serial, _package, root, _stage, _preview, _timings, context) => {
    await adopt(context, root, serial);
    if (serial === "A") { aStarted.resolve(); await releaseA.promise; }
    return { imageCount: 0, finalScreen: null };
  } });
  const a = h.api.inspectPreferredDevice(h.provider, "A", { inspectionMode: "sdk-enhanced", signal: controller.signal });
  const rejected = assert.rejects(a, error => error === reason);
  await aStarted.promise;
  const b = h.api.inspectPreferredDevice(h.provider, "B", { inspectionMode: "sdk-enhanced" });
  controller.abort(reason); releaseA.resolve();
  await rejected; assert.equal((await b).error, null);
  assert.deepEqual(h.screens, ["B"]); assert.deepEqual(h.opens.sort(), ["A", "B"]);
});

for (const phase of ["target", "pid"] as const) for (const completion of ["reject", "late-success"] as const)
  test(`final SDK ${phase} cancellation preserves the original reason: ${completion}`, async () => {
    const controller = new AbortController(), reason = new Error(`cancel final ${phase}`); let completed = false, finalQueries = 0;
    const boundary = () => { finalQueries++; controller.abort(reason); if (completion === "reject") throw reason; };
    const h = fixture({
      checkedDebugTarget: async () => { if (completed && phase === "target") boundary(); return target; },
      singleAppPid: async () => { if (completed && phase === "pid") boundary(); return 42; },
    });
    await assert.rejects(h.api.inspectPreferredDevice(h.provider, "fixture", { inspectionMode: "sdk-enhanced", signal: controller.signal,
      onProgress(stage) { if (stage === "完成") completed = true; } }), error => error === reason);
    assert.equal(finalQueries, 1); assert.deepEqual(h.screens, ["fixture"]); assert.equal(h.opens.length, 1);
  });

for (const mismatch of ["window", "pid"] as const) test(`final SDK ${mismatch} mismatch still preserves the independent snapshot with warning`, async () => {
  let completed = false;
  const h = fixture({ checkedDebugTarget: async () => ({ ...target, windowId: completed && mismatch === "window" ? "changed" : target.windowId }),
    singleAppPid: async () => completed && mismatch === "pid" ? 43 : 42 });
  const result = await h.api.inspectPreferredDevice(h.provider, "fixture", { inspectionMode: "sdk-enhanced", onProgress(stage) { if (stage === "完成") completed = true; } });
  assert.equal(result.error, null); assert.ok(result.root); assert.equal(result.screenshotDataUrl, "fixture-fixture");
  assert.match(result.warning!, /SDK 树未采用（进程或窗口已变化）.*保留原独立画面/);
  assert.equal(result.captureRequestDiagnostics?.totalAttempts, 1);
});

test("preferred tree verification receives the real image-stage signal through the property handoff", async () => {
  const controller = new AbortController(); let imageSignal: AbortSignal | undefined, treeReads = 0;
  const h = fixture({
    captureDebugViewImages: async (_provider, _adb, _serial, _package, root, _stage, _preview, _timings, context) => {
      imageSignal = context.signal; assert.ok(imageSignal); assert.notEqual(imageSignal, controller.signal);
      fillRoot(root);
      await readDebugPropertiesAndImages({ port: 1234, packageName: target.packageName, root, context,
        stage: () => {}, onBatchTiming: undefined }, {
        applyViewProperties: () => {},
        captureViewLayers: async (_port, options) => {
          assert.equal(options?.signal, imageSignal);
          const dump = {} as Parameters<NonNullable<NonNullable<typeof options>["onHierarchy"]>>[0];
          await options?.onHierarchy?.(dump, "fixture-window");
          assert.equal(typeof options?.skipImages, "function");
          assert.equal((options!.skipImages as () => boolean)(), true);
          return [];
        },
      });
      assert.equal(context.plan.imageRoute, "sdk"); return { imageCount: 0, finalScreen: null };
    },
    readSdkCapture: async (_provider, _adb, _serial, _package, context) => {
      treeReads++; assert.equal(context.signal, imageSignal); assert.equal(commandSignal(), imageSignal);
      return sdk();
    },
  });
  assert.equal((await h.api.inspectPreferredDevice(h.provider, "fixture", { inspectionMode: "sdk-enhanced", signal: controller.signal })).error, null);
  assert.equal(treeReads, 1); assert.equal(commandSignal(), undefined);
});

test("a late SDK tree reply after cancellation cannot promote its route, start a screenshot or replay capture", async () => {
  const treeStarted = deferred(), releaseTree = deferred(), controller = new AbortController();
  const reason = new Error("cancel A while SDK tree is pending");
  let cancelledContext: CaptureRunContext | undefined, treeReads = 0;
  const h = fixture({
    captureDebugViewImages: async (_provider, _adb, serial, _package, root, _stage, _preview, _timings, context) => {
      if (serial === "A") {
        cancelledContext = context; fillRoot(root);
        await notifyViewTreeReady(context, target.packageName, root);
        assert.fail("cancelled verification cannot resume image capture");
      }
      await adopt(context, root, serial); return { imageCount: 0, finalScreen: null };
    },
    readSdkCapture: async (_provider, _adb, serial) => {
      assert.equal(serial, "A"); treeReads++; treeStarted.resolve(); await releaseTree.promise;
      return sdk();
    },
  });
  const a = h.api.inspectPreferredDevice(h.provider, "A", { inspectionMode: "sdk-enhanced", signal: controller.signal });
  const rejected = assert.rejects(a, error => error === reason);
  await treeStarted.promise;
  const b = h.api.inspectPreferredDevice(h.provider, "B", { inspectionMode: "sdk-enhanced" });
  controller.abort(reason); releaseTree.resolve();
  await rejected; assert.equal((await b).error, null);
  assert.equal(cancelledContext!.plan.imageRoute, "ddms"); assert.equal(treeReads, 1);
  assert.deepEqual(h.screens, ["B"]); assert.deepEqual(h.opens.sort(), ["A", "B"]);
  assert.equal(h.commands.filter(call => call.serial === "A" && call.args.join(" ") === "shell dumpsys activity sample.app").length, 1);
});
