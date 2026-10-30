import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNode } from "../benchmarks/fixtures";
import type { UiSnapshot } from "../shared/types";
import type { InspectionMode } from "../shared/inspection-mode";
import { createInspectionModeController } from "../electron/desktop/inspection-mode-controller";
import { createInspectionModeStore } from "../electron/desktop/inspection-mode-store";
import { createInspectionService } from "../electron/desktop/inspection-service";
import { createWindowOperationScope } from "../electron/desktop/window-operation-scope";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("only an explicitly saved valid mode survives restart; missing, old and broken settings use standard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inspector-mode-"));
  try {
    const path = join(directory, "inspection-settings.json"), store = createInspectionModeStore(path);
    assert.equal(store.load(), "standard");
    for (const value of ['{', '{}', '{"mode":"sdk-enhanced"}', '{"version":1,"mode":true}', '{"version":2,"mode":"sdk-enhanced"}']) {
      await writeFile(path, value); assert.equal(store.load(), "standard");
    }
    await store.save("sdk-enhanced");
    assert.equal(createInspectionModeStore(path).load(), "sdk-enhanced");
    await store.save("standard");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, mode: "standard" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("changing mode blocks new capture and concurrent changes until connections and persistence settle", async () => {
  const close = deferred(), saves: InspectionMode[] = [], events: any[] = [];
  let invalidations = 0;
  const controller = createInspectionModeController({ load: () => undefined, isBusy: () => false,
    save: async mode => { saves.push(mode); }, releaseSdk: () => close.promise,
    invalidate: () => { invalidations++; }, notify: state => events.push(state) });
  const pending = controller.set("sdk-enhanced");
  assert.equal(controller.state().busy, true);
  assert.throws(() => controller.capture(), /切换/);
  await assert.rejects(controller.set("standard"), /先结束/);
  assert.deepEqual(saves, []);
  close.resolve(); await pending;
  assert.deepEqual(controller.capture(), { mode: "sdk-enhanced", revision: 1 });
  assert.deepEqual(saves, ["sdk-enhanced"]); assert.equal(invalidations, 1);
  assert.equal(events.at(-1).busy, false);
});

test("busy or invalid requests never close connections or persist; failed save preserves previous policy", async () => {
  let busy = true, releases = 0, invalidations = 0;
  const controller = createInspectionModeController({ load: () => "sdk-enhanced", isBusy: () => busy,
    releaseSdk: async () => { releases++; }, save: async () => { throw new Error("disk full"); },
    invalidate: () => { invalidations++; }, notify: () => {} });
  await assert.rejects(controller.set("standard"), /先结束/);
  busy = false;
  for (const input of [null, false, {}, "auto"]) await assert.rejects(controller.set(input), /无效/);
  assert.equal(releases, 0);
  await assert.rejects(controller.set("standard"), /disk full/);
  assert.deepEqual(controller.state(), { mode: "sdk-enhanced", revision: 0, busy: false });
  assert.equal(invalidations, 0);
});

function fixture() {
  const root = makeNode("0");
  root.package = "com.example.fixture";
  root.attributes = { "debug-process-id": "123", "debug-window-name": "window", "sdk-process-instance": "retained-instance" };
  root.layerImageDataUrl = "data:image/png;base64,retained";
  return { serial: "test", root, inspectionSource: "debug-hybrid", nodeCount: 1, error: null } as UiSnapshot;
}

function serviceHarness(initial: InspectionMode = "standard") {
  let controller: ReturnType<typeof createInspectionModeController>;
  let styleGate: Promise<any> = Promise.resolve({ values: {} });
  const calls: { kind: string; mode: InspectionMode | undefined }[] = [];
  const saved = fixture();
  const service = createInspectionService({ operations: createWindowOperationScope(),
    capturePolicy: () => controller.capture(), debugStarting: () => false, debugSession: () => null,
    stopSharing: () => {}, inspect: async (_serial, options) => { calls.push({ kind: "inspect", mode: options.inspectionMode }); return saved; },
    measureLayerImages: async () => {}, yieldPreview: () => undefined, withPreviewHeld: async (_owner, action) => action(),
    captureQmlGroupImage: async () => { throw new Error("unexpected QML"); },
    captureViewGroupImage: async (...args) => { calls.push({ kind: "group", mode: args.at(-1) as InspectionMode }); return null; },
    captureListViewItems: async () => { throw new Error("unexpected list"); },
    captureViewNodes: async () => { throw new Error("unexpected node"); },
    captureViewStyle: async (...args) => { calls.push({ kind: "style", mode: args.at(-1) as InspectionMode }); return styleGate; },
    setTimeout, clearTimeout });
  controller = createInspectionModeController({ load: () => initial, isBusy: service.hasActivity, save: async () => {},
    releaseSdk: async () => {}, invalidate: service.invalidateAll, notify: () => {} });
  const sender = { id: 7, isDestroyed: () => false, send: () => {}, onDestroyed: () => () => {} };
  return { service, controller, calls, saved, setStyle: (gate: Promise<any>) => { styleGate = gate; },
    capture: () => service.inspect(sender, { serial: "test", requestId: "request", captureSingleAttempt: false, readOnlyScope: undefined }) };
}

test("SDK attributes in a standard-mode snapshot cannot trigger native SDK group or live style calls", async () => {
  const h = serviceHarness(); await h.capture();
  assert.equal(await h.service.captureGroup(7, "request", "0"), null);
  await assert.rejects(h.service.readStyle(7, "request", "0"), /SDK 增强/);
  assert.deepEqual(h.calls, [{ kind: "inspect", mode: "standard" }]);
  assert.equal(h.saved.root!.layerImageDataUrl, "data:image/png;base64,retained");
});

test("style reads keep mode busy until settled; switching invalidates live rights without deleting saved SDK images", async () => {
  const h = serviceHarness("sdk-enhanced"); await h.capture();
  const gate = deferred<any>(); h.setStyle(gate.promise);
  const read = h.service.readStyle(7, "request", "0");
  assert.equal(h.service.hasActivity(), true);
  await assert.rejects(h.controller.set("standard"), /先结束/);
  gate.resolve({ values: {} }); await read;
  assert.equal(h.service.hasActivity(), false);
  await h.controller.set("standard");
  assert.equal(h.service.hasSession(7), false);
  assert.equal(await h.service.captureGroup(7, "request", "0"), null);
  await assert.rejects(h.service.refreshView(7, "request", "0", "node"), /失效/);
  assert.equal(h.saved.root!.attributes!["sdk-process-instance"], "retained-instance");
  assert.equal(h.saved.root!.layerImageDataUrl, "data:image/png;base64,retained");
  assert.deepEqual(h.calls, [{ kind: "inspect", mode: "sdk-enhanced" }, { kind: "style", mode: "sdk-enhanced" }]);
});
