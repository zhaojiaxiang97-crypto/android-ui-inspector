import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLayerImageCapture } from "../electron/capture/layer-image-demand";
import { readDebugPropertiesAndImages } from "../electron/capture/debug-image-handoff";
import { createCaptureRunContext } from "../electron/capture/run-context";
import { commandSignal } from "../electron/device/command-context";
import type { ProviderClient } from "../electron/sdk/provider-session";
import type { UiNode, UiSnapshot } from "../shared/types";
import { makeNode } from "../benchmarks/fixtures";

const target = { packageName: "sample.app", component: "sample.app/.MainActivity", activityName: ".MainActivity", windowId: "abc" };
const provider: ProviderClient = { open: async () => assert.fail("standard mode must not open SDK"), call: async () => assert.fail("standard mode must not call SDK") };
const bounds = { left: 0, top: 0, right: 100, bottom: 80, raw: "[0,0][100,80]" };
const view = (id: string): UiNode => ({ ...makeNode(id), bounds: { ...bounds }, layerImageStatus: "deferred",
  className: "android.view.View", attributes: { "view-ref": `android.view.View@${id.replace(/\//g, "")}` } });
function snapshot(): UiSnapshot {
  const root = view("0");
  root.package = target.packageName;
  root.attributes = { "debug-component": target.component, "debug-window-id": target.windowId, "debug-window-name": "MainWindow", "debug-process-id": "42" };
  root.children = [view("0/0")]; root.children[0].children = [view("0/0/0"), view("0/0/1")];
  return { serial: "device", root, nodeCount: 4, screenshotDataUrl: null, rawXml: null, xmlSize: 1, error: null, warning: null, inspectionSource: "debug-view" };
}
const ok = (text = "") => ({ code: 0, stdout: Buffer.from(text), stderr: "" });
type CapturePorts = NonNullable<Parameters<typeof createLayerImageCapture>[0]>;
function fixture(overrides: CapturePorts = {}) {
  const current = snapshot(), before = structuredClone(current), commands: string[] = [];
  let bitmapCalls = 0, treeReads = 0;
  const capture = createLayerImageCapture({
    automationAdb: () => "fixture-adb", checkedDebugTarget: async () => target, singleAppPid: async () => 42,
    runDeviceAdb: async (_adb, _serial, args) => {
      commands.push(args.join(" "));
      if (args[0] === "forward") { assert.equal(commandSignal(), undefined, "forward cleanup ignores cancelled command context"); return ok("1234"); }
      return ok("ACTIVITY sample.app/.MainActivity instance pid=42\n View Hierarchy:");
    },
    buildReadCurrent: () => async () => { treeReads++; const root = structuredClone(current.root!); return { root, node: root.children[0].children[0] }; },
    captureViewBitmaps: async (_port, bitmapTarget, views) => {
      bitmapCalls++; assert.equal(bitmapTarget.wakeUi, undefined);
      assert(views.every(view => view.captureOwn));
      return { images: new Map(views.map(view => [view.ref, { width: 100, height: 80, imageDataUrl: `image:${view.ref}`, kind: "own" as const, empty: false }])),
        failures: new Map(), kinds: new Map(views.map(view => [view.ref, "own" as const])), skipDraw: new Set(), timing: {} } as Awaited<ReturnType<NonNullable<CapturePorts["captureViewBitmaps"]>>>;
    }, ...overrides,
  });
  return { current, before, commands, capture, bitmapCalls: () => bitmapCalls, treeReads: () => treeReads };
}

test("real initial quick-capture route performs no DDMS pixels, bitmap fallback or SDK operation", () => {
  for (const scenario of ["quick", "cancel-tree"]) {
    const result = JSON.parse(execFileSync(process.execPath,
      [fileURLToPath(new URL("./fixtures/layer-demand-capture.mjs", import.meta.url)), scenario],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 10_000, encoding: "utf8" }));
    assert.deepEqual(result.counters, { properties: 1, ddms: 0, bitmap: 0, sdk: 0, screen: scenario === "quick" ? 1 : 0, removed: 1 });
    assert.deepEqual(result.phases, [{ phase: "tree", status: "deferred" }]);
    assert.equal(result.status, "deferred");
    assert.equal(result.error, scenario === "quick" ? undefined : "cancel-tree");
    assert.equal(result.imageCount, scenario === "quick" ? 0 : undefined);
  }
});

test("on-demand standard property handoff publishes deferred state and skips DDMS image export", async () => {
  for (const mode of ["standard", "sdk-enhanced"] as const) {
    const root = snapshot().root!;
    for (const node of root.children) { delete node.layerImageStatus; for (const child of node.children) delete child.layerImageStatus; }
    root.children[0].children[1].visibleToUser = false;
    let ddms = 0, previewed = false;
    const context = createCaptureRunContext({ inspectionMode: mode, layerCapture: "on-demand" });
    await readDebugPropertiesAndImages({ port: 1, packageName: target.packageName, root, context, stage: () => {}, onBatchTiming: undefined,
      preview: async phase => { assert.equal(phase, "tree"); previewed = true;
        assert.equal(root.children[0].children[0].layerImageStatus, mode === "standard" ? "deferred" : undefined);
        if (mode === "standard") assert.equal(root.children[0].children[1].layerImageStatus, "hidden"); },
    }, {
      applyViewProperties: () => {},
      captureViewLayers: async (_port, options) => {
        await options!.onHierarchy!({} as never, "MainWindow");
        if (!(options!.skipImages as () => boolean)()) ddms++;
        return [];
      },
    });
    assert(previewed); assert.equal(ddms, mode === "standard" ? 0 : 1);
    assert.equal(root.attributes?.["layer-capture-mode"], mode === "standard" ? "on-demand" : undefined);
  }
});

test("full capture remains the default for property handoff", async () => {
  let ddms = 0;
  await readDebugPropertiesAndImages({ port: 1, packageName: target.packageName, root: snapshot().root!, context: createCaptureRunContext(),
    stage: () => {}, onBatchTiming: undefined }, { applyViewProperties: () => {}, captureViewLayers: async (_port, options) => {
      await options!.onHierarchy!({} as never, "MainWindow"); if (!(options!.skipImages as () => boolean)()) ddms++; return [];
    } });
  assert.equal(ddms, 1);
});

test("requested layers use one bitmap session and return image patches without replacing or mutating tree", async () => {
  const f = fixture();
  const result = await f.capture(provider, "device", f.current, ["0/0/0", "0/0/1"]);
  assert.equal(f.bitmapCalls(), 1); assert.equal(f.treeReads(), 2);
  assert.deepEqual(result.failures, []); assert.equal(result.updates.length, 2);
  assert(result.updates.every(update => update.layerImageStatus === "captured" && !("children" in update) && !("text" in update)));
  assert.deepEqual(f.current, f.before);
  assert(f.commands.includes("forward --remove tcp:1234"));
});

test("invalid, repeated, already captured and oversized requests never connect to a device", async () => {
  for (const ids of [[], ["0"], ["0/404"], ["0/0/0", "0/0/0"], Array.from({ length: 33 }, (_, i) => `0/0/${i}`)]) {
    const f = fixture(); await assert.rejects(f.capture(provider, "device", f.current, ids)); assert.equal(f.commands.length, 0);
  }
  const f = fixture(); f.current.root!.children[0].children[0].layerImageStatus = "captured";
  f.current.root!.children[0].children[0].layerImageDataUrl = "existing";
  await assert.rejects(f.capture(provider, "device", f.current, ["0/0/0"])); assert.equal(f.commands.length, 0);
});

test("wrong device, SDK mode and missing window identity reject before device access", async () => {
  const f = fixture();
  await assert.rejects(f.capture(provider, "other", f.current, ["0/0/0"]));
  await assert.rejects(f.capture(provider, "device", f.current, ["0/0/0"], undefined, "sdk-enhanced"));
  delete f.current.root!.attributes!["debug-window-id"];
  await assert.rejects(f.capture(provider, "device", f.current, ["0/0/0"])); assert.equal(f.commands.length, 0);
});

test("changed foreground window or process prevents debugger attachment", async () => {
  for (const change of [{ checkedDebugTarget: async () => ({ ...target, windowId: "new-window" }) }, { singleAppPid: async () => 43 }]) {
    const f = fixture(change); await assert.rejects(f.capture(provider, "device", f.current, ["0/0/0"]), /已变化/);
    assert(!f.commands.some(command => command.startsWith("forward"))); assert.equal(f.bitmapCalls(), 0);
  }
});

test("target or ancestor geometry change refuses capture and releases the forward", async () => {
  for (const id of ["0/0", "0/0/1"]) {
    const live = snapshot().root!;
    const moved = id === "0/0" ? live.children[0] : live.children[0].children[1]; moved.bounds!.left++;
    const f = fixture({ buildReadCurrent: () => async () => ({ root: live, node: live.children[0].children[0] }) });
    await assert.rejects(f.capture(provider, "device", f.current, ["0/0/0", "0/0/1"]), /位置/);
    assert.equal(f.bitmapCalls(), 0); assert(f.commands.includes("forward --remove tcp:1234")); assert.deepEqual(f.current, f.before);
  }
});

test("identity, geometry, visibility and window changes during pixels reject all updates", async () => {
  for (const change of ["identity", "geometry", "visibility", "window", "process"]) {
    let reads = 0, targets = 0, pids = 0;
    const live = snapshot().root!;
    const f = fixture({
      buildReadCurrent: () => async () => {
        const root = structuredClone(live);
        if (++reads === 2) {
          if (change === "identity") root.children[0].children[1].attributes!["view-ref"] = "android.view.View@new";
          if (change === "geometry") root.children[0].children[1].bounds!.left++;
          if (change === "visibility") root.children[0].visibleToUser = false;
        }
        return { root, node: root.children[0].children[0] };
      },
      checkedDebugTarget: async () => ({ ...target, windowId: ++targets === 2 && change === "window" ? "changed" : target.windowId }),
      singleAppPid: async () => ++pids === 2 && change === "process" ? 43 : 42,
    });
    await assert.rejects(f.capture(provider, "device", f.current, ["0/0/0", "0/0/1"]), /已变化/);
    assert.equal(f.bitmapCalls(), 1); assert(f.commands.includes("forward --remove tcp:1234")); assert.deepEqual(f.current, f.before);
  }
});

test("empty containers and partial failures are final patches, not deferred retries", async () => {
  const f = fixture({ captureViewBitmaps: async () => ({ images: new Map(), kinds: new Map(),
    skipDraw: new Set(["android.view.View@000"]), failures: new Map([["android.view.View@001", "cannot draw"]]), timing: {} } as never) });
  const result = await f.capture(provider, "device", f.current, ["0/0/0", "0/0/1"]);
  assert.deepEqual(result.updates.map(update => update.layerImageStatus), ["unavailable", "failed"]);
  assert.equal(result.updates[0].skipDraw, "true"); assert.equal(result.updates[1].imageCaptureError, "cannot draw");
  assert.deepEqual(result.failures, [{ id: "0/0/1", message: "cannot draw" }]); assert.deepEqual(f.current, f.before);
});

test("cancel during attachment still releases the allocated forward without publishing", async () => {
  const abort = new AbortController(); let cleaned = false;
  const f = fixture({ runDeviceAdb: async (_adb, _serial, args) => {
    if (args[0] === "forward" && args[1] === "tcp:0") { abort.abort(new Error("cancel-demand")); return ok("2345"); }
    if (args[0] === "forward" && args[1] === "--remove") { cleaned = true; assert.equal(commandSignal(), undefined); return ok(); }
    return ok("ACTIVITY sample.app/.MainActivity instance pid=42");
  } });
  await assert.rejects(f.capture(provider, "device", f.current, ["0/0/0"], abort.signal), /cancel-demand/);
  assert(cleaned); assert.equal(f.bitmapCalls(), 0); assert.deepEqual(f.current, f.before);
});

test("cancel after bitmap capture drops patches and releases the session forward", async () => {
  const abort = new AbortController();
  const f = fixture({ captureViewBitmaps: async () => { abort.abort(new Error("cancel-after-pixels")); return { images: new Map(), kinds: new Map(),
    skipDraw: new Set(), failures: new Map(), timing: {} } as never; } });
  await assert.rejects(f.capture(provider, "device", f.current, ["0/0/0"], abort.signal), /cancel-after-pixels/);
  assert(f.commands.includes("forward --remove tcp:1234")); assert.deepEqual(f.current, f.before);
});
