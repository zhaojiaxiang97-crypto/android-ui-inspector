import assert from "node:assert/strict";
import { test } from "node:test";
import { createFontCapture } from "../electron/capture/font-capture";
import { commandSignal } from "../electron/device/command-context";
import { makeNode } from "../benchmarks/fixtures";
import type { UiSnapshot } from "../shared/types";
import type { ProviderClient } from "../electron/sdk/provider-session";

const target = { packageName: "sample.app", component: "sample.app/.MainActivity", activityName: ".MainActivity", windowId: "abc" };
const provider: ProviderClient = { open: async () => assert.fail("must not open SDK"), call: async () => assert.fail("must not call SDK") };
const ok = (text = "") => ({ code: 0, stdout: Buffer.from(text), stderr: "" });
function fixture(extra: Parameters<typeof createFontCapture>[0] = {}) {
  const root = makeNode("0"); root.package = target.packageName;
  root.attributes = { "debug-component": target.component, "debug-window-id": "abc", "debug-window-name": "Window", "debug-process-id": "42" };
  root.children = [makeNode("0/0")]; root.children[0].attributes = { "view-ref": "View@abc" };
  root.children[0].children = [makeNode("0/0/0")]; root.children[0].children[0].attributes = { "view-ref": "TextView@def" };
  const snapshot: UiSnapshot = { serial: "device", root, nodeCount: 3, screenshotDataUrl: null, rawXml: null, xmlSize: 1, error: null, warning: null, inspectionSource: "debug-view" };
  const live = structuredClone(root), commands: string[] = []; let calls = 0, reads = 0;
  const capture = createFontCapture({ automationAdb: () => "adb", checkedDebugTarget: async () => target, singleAppPid: async () => 42,
    runDeviceAdb: async (_adb, _serial, args) => {
      commands.push(args.join(" "));
      if (args[0] === "forward") { assert.equal(commandSignal(), undefined); return ok("1234"); }
      return ok("ACTIVITY sample.app/.MainActivity instance pid=42\n View Hierarchy:");
    }, debugViewTree: () => structuredClone(live), applyViewProperties: () => {},
    captureViewLayers: async (_port, options) => { reads++; assert.equal(options?.skipImages, true); await options?.onHierarchy?.({} as never, "Window"); return []; },
    readViewFont: async (_port, viewTarget, ref) => { calls++; assert.equal(viewTarget.wakeUi, undefined); return {
      ref, capturedAtMillis: 10, source: "jdwp", basis: "text-paint", familyName: "sans-serif", familyNameStatus: "system-family", weight: 500, style: 0, usesDefaultTypeface: false,
    }; }, ...extra,
  });
  return { capture, snapshot, live, commands, calls: () => calls, reads: () => reads };
}
test("font capture reads actual metadata without SDK, images or snapshot changes", async () => {
  const f = fixture(), before = structuredClone(f.snapshot);
  const value = await f.capture(provider, "device", f.snapshot, "0/0/0");
  assert.equal(value.familyName, "sans-serif"); assert.equal(value.weight, 500);
  assert.equal(f.reads(), 2); assert.equal(f.calls(), 1); assert.deepEqual(f.snapshot, before);
  assert.equal(f.commands.at(-1), "forward --remove tcp:1234");
});
test("hybrid row IDs may differ while native identities remain equal", async () => {
  const f = fixture(); f.snapshot.inspectionSource = "debug-hybrid";
  f.live.children[0].children[0].id = "0/0/8";
  await f.capture(provider, "device", f.snapshot, "0/0/0", undefined, "sdk-enhanced"); assert.equal(f.calls(), 1);
});
test("stale process is refused before connecting", async () => {
  const f = fixture({ singleAppPid: async () => 43 });
  await assert.rejects(f.capture(provider, "device", f.snapshot, "0/0/0"), /进程/);
  assert.equal(f.commands.length, 0); assert.equal(f.calls(), 0);
});
test("moved and ambiguous objects are refused before font invocation and release forwarding", async () => {
  for (const change of ["moved", "duplicate"] as const) {
    const f = fixture();
    if (change === "moved") f.live.children[0].children[0].bounds = { left: 10, right: 20, top: 0, bottom: 10, raw: "" };
    else f.live.children[0].children.push(structuredClone(f.live.children[0].children[0]));
    await assert.rejects(f.capture(provider, "device", f.snapshot, "0/0/0"), /身份/);
    assert.equal(f.calls(), 0); assert.equal(f.commands.at(-1), "forward --remove tcp:1234");
  }
});
test("process replacement after read is discarded", async () => {
  let pids = 0;
  const other = fixture({ singleAppPid: async () => ++pids === 1 ? 42 : 43 });
  await assert.rejects(other.capture(provider, "device", other.snapshot, "0/0/0"), /进程/);
  assert.equal(other.calls(), 1); assert.equal(other.commands.at(-1), "forward --remove tcp:1234");
});
test("font failure and cancellation always release forwarding", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const f = fixture({ readViewFont: async () => { if (cancel) controller.abort(new Error("cancelled")); throw new Error(cancel ? "cancelled" : "not TextView"); } });
    await assert.rejects(f.capture(provider, "device", f.snapshot, "0/0/0", controller.signal), cancel ? /cancelled/ : /TextView/);
    assert.equal(f.commands.at(-1), "forward --remove tcp:1234");
  }
});
test("wrong device, inaccessible node and cancelled request perform no I/O", async () => {
  const f = fixture();
  await assert.rejects(f.capture(provider, "other", f.snapshot, "0/0/0"), /实时/);
  await assert.rejects(f.capture(provider, "device", f.snapshot, "0/8"), /身份/);
  await assert.rejects(f.capture(provider, "device", f.snapshot, "0/0/0", AbortSignal.abort()), /abort/i);
  assert.equal(f.commands.length, 0);
});
test("cancellation during forward cleanup discards the completed font result", async () => {
  const controller = new AbortController(); let cleaned = false;
  const f = fixture({ runDeviceAdb: async (_adb, _serial, args) => {
    if (args[0] === "forward") {
      if (args[1] === "--remove") { cleaned = true; controller.abort(new Error("cleanup cancelled")); }
      return ok("1234");
    }
    return ok("ACTIVITY sample.app/.MainActivity instance pid=42\n View Hierarchy:");
  } });
  await assert.rejects(f.capture(provider, "device", f.snapshot, "0/0/0", controller.signal), /cleanup cancelled/);
  assert(cleaned); assert.equal(f.calls(), 1);
});
