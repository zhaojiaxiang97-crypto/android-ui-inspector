import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemandLayerCapture, demandLayerIds, type DemandLayerState } from "../src/features/inspection/demand-layer-capture";
import { makeNode } from "../benchmarks/fixtures";
import { mergeLayerImages } from "../shared/tree-utils";
import type { LayerImageCaptureResult, UiNode, UiSnapshot } from "../shared/types";

function node(id: string): UiNode { return { ...makeNode(id), attributes: { "view-ref": `View@${id}` }, layerImageStatus: "deferred" }; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate: () => boolean) { for (let n = 0; n < 100 && !predicate(); n++) await tick(); assert.ok(predicate()); }
function harness() {
  const root = node("0"); root.children = Array.from({ length: 40 }, (_, i) => node(`0/${i}`));
  let snapshot: UiSnapshot = { root, serial: "fixture", nodeCount: 41, rawXml: null, xmlSize: 0,
    screenshotDataUrl: null, warning: null, error: null, layerCapture: "on-demand" };
  let requestId = "first", blocked = false;
  const calls: { ids: string[]; result: ReturnType<typeof deferred<LayerImageCaptureResult>> }[] = [], canceled: string[] = [];
  let state: DemandLayerState | null = null;
  const controller = createDemandLayerCapture({ delayMs: 0,
    api: { captureLayerImages: async (_request, ids) => { const result = deferred<LayerImageCaptureResult>(); calls.push({ ids, result }); return result.promise; },
      cancelLayerImages: async id => { canceled.push(id); } },
    current: () => ({ snapshot, requestId, blocked }),
    apply: (source, result) => { snapshot = { ...source, root: mergeLayerImages(source.root!, result.updates) }; },
    publish: next => { state = next; },
  });
  return { controller, calls, canceled, get state() { return state; }, get snapshot() { return snapshot; },
    request: (id = "0", retry = false) => controller.request(snapshot, id, retry),
    block: () => { blocked = true; }, replace: () => { requestId = "second"; snapshot = { ...snapshot, root: node("0") }; },
    resolve: (index: number) => calls[index].result.resolve({ updates: calls[index].ids.map(id => ({ id, layerImageStatus: "captured", layerImageDataUrl: "pixels" })), failures: [] }),
  };
}

test("demand candidates skip hidden, invalid geometry, missing references and existing pixels; breadth-first bounded selection", () => {
  const root = node("0"); root.children = Array.from({ length: 50 }, (_, i) => node(`0/${i}`));
  root.children[0].visibleToUser = false;
  root.children[1].bounds = null;
  root.children[2].bounds!.right = 0;
  root.children[3].bounds!.bottom = Number.NaN;
  root.children[4].attributes = {};
  root.children[5].layerImageDataUrl = "existing";
  root.children[6].layerImageStatus = "failed";
  root.children[7].children = [node("0/7/0")];
  assert.deepEqual(demandLayerIds(root).slice(0, 3), ["0", "0/7", "0/8"]);
  assert.equal(demandLayerIds(root).length, 32);
  assert.ok(!demandLayerIds(root).includes("0/7/0"));
  assert.equal(demandLayerIds(root, true)[1], "0/6");
});

test("one visit loads only one batch; image patches and repeated visit do not drain the tree", async () => {
  const h = harness(); h.request(); await until(() => h.calls.length === 1);
  assert.equal(h.calls[0].ids.length, 32); h.resolve(0); await until(() => !h.controller.isBusy());
  h.request(); await tick(); await tick(); assert.equal(h.calls.length, 1);
  assert.match(h.state!.message!, /已读取一批/);
  h.request("0", true); await until(() => h.calls.length === 2);
  assert.equal(h.calls[1].ids.length, 9); h.resolve(1); await until(() => !h.controller.isBusy());
  assert.match(h.state!.message!, /已读取。/); h.controller.dispose();
});

test("rapid branch visits coalesce, and queued branch starts only after the current request", async () => {
  const h = harness(); h.request("0/0"); h.request("0/1"); await until(() => h.calls.length === 1);
  assert.deepEqual(h.calls[0].ids, ["0/1"]); h.request("0/2"); await tick(); assert.equal(h.calls.length, 1);
  h.resolve(0); await until(() => h.calls.length === 2); assert.deepEqual(h.calls[1].ids, ["0/2"]);
  h.resolve(1); await until(() => !h.controller.isBusy()); h.controller.dispose();
});

test("invalidation cancels only branch work and rejects the previous session's result", async () => {
  const h = harness(); h.request(); await until(() => h.calls.length === 1);
  h.controller.invalidate(); h.replace(); h.resolve(0); await tick();
  assert.deepEqual(h.canceled, ["first"]); assert.equal(h.snapshot.root!.layerImageStatus, "deferred");
  h.request(); await until(() => h.calls.length === 2); h.resolve(1); await until(() => !h.controller.isBusy());
  assert.equal(h.snapshot.root!.layerImageStatus, "captured"); h.controller.dispose();
});

test("foreign patches fail closed and blocked or disposed callbacks cannot start reads", async () => {
  const h = harness(); h.request("0/0"); await until(() => h.calls.length === 1);
  h.calls[0].result.resolve({ updates: [{ id: "0/1", layerImageStatus: "captured" }], failures: [] });
  await until(() => !h.controller.isBusy()); assert.equal(h.state!.failed, true);
  assert.equal(h.snapshot.root!.children[1].layerImageStatus, "deferred");
  h.block(); h.request("0/1"); await tick(); assert.equal(h.calls.length, 1);
  h.controller.dispose(); h.request("0/2"); await tick(); assert.equal(h.calls.length, 1);
});
