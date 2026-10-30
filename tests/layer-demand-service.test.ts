import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { makeNode } from "../benchmarks/fixtures";
import { createInspectionService } from "../electron/desktop/inspection-service";
import { createCaptureHandlers } from "../electron/desktop/capture-ipc";
import { createWindowOperationScope } from "../electron/desktop/window-operation-scope";
import { nodePresentationStatus } from "../shared/node-presentation-status";
import { isUiSnapshot } from "../shared/snapshot-validation";
import type { LayerImageCaptureResult, UiSnapshot } from "../shared/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(): UiSnapshot {
  const root = makeNode("0"), child = makeNode("0/0");
  root.attributes = { "debug-process-id": "1", "debug-window-name": "window" };
  child.attributes = { "view-ref": "TextView@1" }; child.layerImageStatus = "deferred";
  root.children = [child];
  return { serial: "device", root, nodeCount: 2, xmlSize: 0, rawXml: null, screenshotDataUrl: null,
    warning: null, error: null, inspectionSource: "debug-view", layerCapture: "on-demand" };
}
function harness() {
  const calls: { snapshot: UiSnapshot; ids: string[]; signal?: AbortSignal; result: ReturnType<typeof deferred<LayerImageCaptureResult>> }[] = [];
  const captures: any[] = [];
  let mode: "standard" | "sdk-enhanced" = "standard", revision = 0;
  const unused = async (): Promise<never> => { throw new Error("unexpected route"); };
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false, send: () => {} });
  const event = { sender, senderFrame: sender.mainFrame };
  const service = createInspectionService({
    operations: createWindowOperationScope(), capturePolicy: () => ({ mode, revision }),
    debugStarting: () => false, debugSession: () => null, stopSharing: () => {},
    inspect: async (_serial, options) => { captures.push(options); return fixture(); },
    measureLayerImages: async () => {}, yieldPreview: () => undefined, withPreviewHeld: async (_owner, work) => work(),
    captureQmlGroupImage: unused, captureViewGroupImage: unused, captureListViewItems: unused,
    captureViewNodes: unused, captureViewStyle: unused,
    captureViewLayerImages: async (_serial, snapshot, ids, signal) => {
      const result = deferred<LayerImageCaptureResult>(); calls.push({ snapshot, ids, signal, result }); return result.promise;
    }, setTimeout, clearTimeout,
  });
  const handlers = createCaptureHandlers(service, () => sender);
  return { service, calls, captures, handlers, event, setMode(value: typeof mode) { mode = value; revision++; },
    inspect: (id = "request", layers: unknown = "on-demand") => handlers["inspect-device"](event, "device", id, undefined, undefined, undefined, layers),
    load: (ids: unknown = ["0/0"]) => handlers["capture-layer-images"](event, "request", ids),
  };
}
const image: LayerImageCaptureResult = { updates: [{ id: "0/0", layerImageStatus: "captured", layerImageDataUrl: "data:image/png;base64,YQ==", layerImageEmpty: false }], failures: [] };

test("on-demand capture is explicit and SDK enhancement retains full capture", async () => {
  const h = harness(); await h.inspect(); assert.equal(h.captures[0].layerCapture, "on-demand");
  await h.handlers["inspect-device"](h.event, "device", "old-client"); assert.equal(h.captures[1].layerCapture, "full");
  await assert.rejects(h.inspect("bad", "fast"), /范围/);
  h.setMode("sdk-enhanced"); await h.inspect(); assert.equal(h.captures[2].layerCapture, "full");
  await assert.rejects(h.load(), /失效/); assert.equal(h.calls.length, 0);
});

test("image requests validate bounded unique node IDs and sender ownership", async () => {
  const h = harness(); await h.inspect();
  for (const ids of [[], ["0/0", "0/0"], ["../0"], ["0/1"], Array.from({ length: 33 }, (_, i) => `0/${i}`)])
    await assert.rejects(h.load(ids));
  await assert.rejects(h.handlers["capture-layer-images"]({ ...h.event, senderFrame: {} }, "request", ["0/0"]));
  assert.equal(h.calls.length, 0);
});

test("successful patches update live image cache while preserving geometry and tree", async () => {
  const h = harness(); await h.inspect(); const first = h.load(); await turn();
  const original = h.calls[0].snapshot.root!;
  h.calls[0].result.resolve(image); assert.deepEqual(await first, image);
  const second = h.load(); await turn();
  const updated = h.calls[1].snapshot.root!;
  assert.equal(updated.children[0].layerImageStatus, "captured");
  assert.deepEqual(updated.children[0].bounds, original.children[0].bounds);
  assert.equal(original.children[0].layerImageStatus, "deferred");
  h.calls[1].result.resolve(image); await second;
  assert.equal(h.service.hasActivity(), false);
});

test("canceling image work preserves session and drains before replacement", async () => {
  const h = harness(); await h.inspect(); const first = h.load(); const failure = assert.rejects(first); await turn();
  h.handlers["cancel-layer-images"](h.event, "request"); assert.equal(h.calls[0].signal?.aborted, true);
  const second = h.load(); await turn(); assert.equal(h.calls.length, 1);
  h.calls[0].result.resolve(image); await failure; await turn(); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].snapshot.root!.children[0].layerImageStatus, "deferred");
  h.calls[1].result.resolve(image); await second;
  assert.equal(h.service.hasSession(1), true);
});

test("recapture waits for canceled images and old results cannot enter new session", async () => {
  const h = harness(); await h.inspect(); const load = h.load(); const failure = assert.rejects(load); await turn();
  const next = h.inspect("new"); await turn(); assert.equal(h.captures.length, 1); assert.equal(h.calls[0].signal?.aborted, true);
  h.calls[0].result.resolve(image); await failure; const result = await next;
  assert.equal(result.root!.children[0].layerImageStatus, "deferred"); assert.equal(h.captures.length, 2);
  await assert.rejects(h.load(), /失效/);
});

test("policy changes and out-of-range results reject image commits", async () => {
  const h = harness(); await h.inspect(); const first = h.load(); const failure = assert.rejects(first); await turn();
  h.setMode("sdk-enhanced"); h.calls[0].result.resolve(image); await failure;
  h.setMode("standard"); await h.inspect(); const second = h.load(); const invalid = assert.rejects(second, /范围/); await turn();
  h.calls[1].result.resolve({ updates: [{ id: "0/999", layerImageStatus: "captured" }], failures: [] }); await invalid;
});

test("saved deferred snapshots remain deferred, never empty or failed", () => {
  const snapshot = fixture(); assert.equal(isUiSnapshot(snapshot), true);
  const status = nodePresentationStatus(snapshot.root!.children[0]);
  assert.equal(status.code, "deferred"); assert.equal(status.label, "待加载"); assert.equal(status.imageEmpty, undefined);
  assert.equal(isUiSnapshot({ ...snapshot, layerCapture: "invalid" }), false);
});
