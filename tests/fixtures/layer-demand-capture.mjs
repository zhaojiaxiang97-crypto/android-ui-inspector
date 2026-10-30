// Isolated mocks exercise the real initial capture route without touching ADB or SDK.
import assert from "node:assert/strict";
import { mock } from "bun:test";

const scenario = process.argv[2] ?? "quick";
const runtime = await import("../../electron/device/runtime.ts");
const target = await import("../../electron/device/target.ts");
const tree = await import("../../electron/capture/native-tree.ts");
const debug = await import("../../electron/capture/view-debug.ts");
const bitmap = await import("../../electron/capture/view-bitmaps.ts");
const sdk = await import("../../electron/capture/sdk-images.ts");
const screen = await import("../../electron/device/screen.ts");
const counters = { properties: 0, ddms: 0, bitmap: 0, sdk: 0, screen: 0, removed: 0 };
const ok = (text = "") => ({ code: 0, stdout: Buffer.from(text), stderr: "" });
const failSdk = async () => { counters.sdk++; throw new Error("unexpected SDK operation"); };
const controller = new AbortController();
mock.module("../../electron/device/runtime.ts", () => ({ ...runtime, runDeviceAdb: async (_adb, _serial, args) => {
  if (args.join(" ") === "exec-out cat /proc/42/cmdline") return ok("sample.app\0");
  if (args.join(" ") === "forward tcp:0 jdwp:42") return ok("1234");
  if (args.join(" ") === "forward --remove tcp:1234") { counters.removed++; return ok(); }
  throw new Error(`unexpected device operation: ${args.join(" ")}`);
} }));
mock.module("../../electron/device/target.ts", () => ({ ...target, singleAppPid: async () => 42 }));
mock.module("../../electron/capture/native-tree.ts", () => ({ ...tree, applyViewProperties: () => { counters.properties++; } }));
mock.module("../../electron/capture/view-debug.ts", () => ({ ...debug,
  captureViewLayers: async (_port, options) => {
    await options.onHierarchy({}, "MainWindow");
    if (!options.skipImages()) { counters.ddms++; throw new Error("unexpected DDMS pixels"); }
    return [];
  }, probeWindowName: failSdk,
}));
mock.module("../../electron/capture/view-bitmaps.ts", () => ({ ...bitmap, captureViewBitmaps: async () => { counters.bitmap++; throw new Error("unexpected bitmap fallback"); } }));
mock.module("../../electron/capture/sdk-images.ts", () => ({ ...sdk, captureSdkVisibleLayers: failSdk,
  captureSdkRefLayers: failSdk, readSdkBranchGeometry: failSdk, readSdkCapture: failSdk }));
mock.module("../../electron/device/screen.ts", () => ({ ...screen, captureScreen: async () => {
  counters.screen++; return { result: ok(), screenshotDataUrl: "screen", captureGeometry: undefined };
} }));

const { captureDebugViewImages } = await import("../../electron/capture/debug-images.ts");
const { createCaptureRunContext } = await import("../../electron/capture/run-context.ts");
const { makeNode } = await import("../../benchmarks/fixtures.ts");
const root = { ...makeNode("0"), package: "sample.app", children: [{ ...makeNode("0/0"), attributes: { "view-ref": "android.view.View@a" } }] };
const phases = [];
const context = createCaptureRunContext({ inspectionMode: "standard", layerCapture: "on-demand", signal: controller.signal,
  onViewTreeReady: failSdk });
let error, result;
try {
  result = await captureDebugViewImages({ open: failSdk, call: failSdk }, "fixture-adb", "device", "sample.app", root, () => {},
    async phase => {
      phases.push({ phase, status: root.children[0].layerImageStatus });
      if (scenario === "cancel-tree") { controller.abort(new Error("cancel-tree")); controller.signal.throwIfAborted(); }
    }, {}, context);
  assert.equal((await result.finalScreen).screenshotDataUrl, "screen");
} catch (caught) { error = caught.message; }
console.log(JSON.stringify({ counters, phases, error, imageCount: result?.imageCount, status: root.children[0].layerImageStatus }));
