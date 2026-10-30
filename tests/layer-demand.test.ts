import assert from "node:assert/strict";
import { test } from "node:test";
import { LayerDemandQueue } from "../shared/layer-demand";
import { layerDemandOrder } from "../src/features/layers/demand";
import { collapsedTextureKey, nativeTextureKey } from "../src/features/layers/presentation";
import { buildLayerOverview } from "../shared/layer-layout";
import { makeNode } from "../benchmarks/fixtures";
import type { ScenePlane } from "../src/features/layers/types";

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const items = (...ids: string[]) => ids.map(key => ({ key, value: key }));

test("layer queue preserves an in-flight request across rapid withdrawal and reentry", async () => {
  const pending = deferred(), calls: string[] = [];
  const queue = new LayerDemandQueue<string>(async id => { calls.push(id); await pending.promise; }, () => assert.fail("unexpected rejection"));
  queue.update(items("branch"));
  for (let i = 0; i < 3; i++) { queue.update([]); queue.update(items("branch")); }
  assert.deepEqual(calls, ["branch"]); assert.equal(queue.pendingCount, 1);
  pending.resolve(); await turn();
  queue.update(items("branch")); assert.deepEqual(calls, ["branch"]); assert.equal(queue.pendingCount, 0);
  queue.dispose();
});

test("newly selected demand jumps queued work without concurrent decoding", async () => {
  const pending = deferred(), calls: string[] = [];
  const queue = new LayerDemandQueue<string>(async id => { calls.push(id); if (id === "first") await pending.promise; }, () => assert.fail());
  queue.update(items("first", "rear", "selected", "withdrawn"));
  queue.update(items("selected", "first", "rear", "selected"));
  assert.deepEqual(calls, ["first"]);
  pending.resolve(); await turn();
  assert.deepEqual(calls, ["first", "selected", "rear"]);
  assert.equal(queue.pendingCount, 0); queue.dispose();
});

test("evicted in-flight result reloads a reentered demand without concurrent work", async () => {
  const pending = deferred(), calls: string[] = [];
  let published = false;
  const queue = new LayerDemandQueue<string>(async id => {
    calls.push(id);
    if (calls.length === 1) { await pending.promise; return "retry"; }
    published = true;
  }, () => assert.fail("unexpected rejection"));
  queue.update(items("parent")); queue.update([]); queue.update(items("parent"));
  assert.deepEqual(calls, ["parent"]);
  pending.resolve(); await turn();
  assert.deepEqual(calls, ["parent", "parent"]);
  assert.equal(published, true); assert.equal(queue.pendingCount, 0);
  queue.update(items("parent")); assert.equal(calls.length, 2);
  queue.dispose();
});

test("discarded demand stays withdrawn instead of retrying obsolete work", async () => {
  const pending = deferred(), calls: string[] = [];
  const queue = new LayerDemandQueue<string>(async id => {
    calls.push(id); await pending.promise; return "retry";
  }, () => assert.fail("unexpected rejection"));
  queue.update(items("old")); queue.update([]); pending.resolve(); await turn();
  assert.deepEqual(calls, ["old"]); assert.equal(queue.pendingCount, 0);
  queue.dispose();
});

test("disposed scene cannot publish its delayed result or start more work", async () => {
  const pending = deferred(), published: string[] = [], calls: string[] = [];
  const queue = new LayerDemandQueue<string>(async (id, _key, active) => {
    calls.push(id); await pending.promise; if (active()) published.push(id);
  }, () => assert.fail());
  queue.update(items("old", "queued")); queue.dispose(); queue.update(items("new"));
  pending.resolve(); await turn();
  assert.deepEqual(calls, ["old"]); assert.deepEqual(published, []);
});

test("failed demand does not spin; later explicit reentry can retry and other work continues", async () => {
  const calls: string[] = [], failures: string[] = [];
  const queue = new LayerDemandQueue<string>(async id => { calls.push(id); if (id === "bad") throw new Error("decode failed"); }, (_error, key) => failures.push(key));
  queue.update(items("bad", "good")); await turn();
  for (let i = 0; i < 5; i++) queue.update(items("bad", "good"));
  assert.deepEqual(calls, ["bad", "good"]); assert.deepEqual(failures, ["bad"]);
  queue.update([]); queue.update(items("bad")); await turn();
  assert.deepEqual(failures, ["bad", "bad"]); queue.dispose();
});

const camera = { distance: 1000, azimuth: 0, elevation: 0, roll: 0, layerGap: 24, panX: 0, panY: 0 };
const pivot = { x: 0, y: 0, z: 0 }, viewport = { left: 0, top: 0, width: 100, height: 100 };
function plane(id: string, left: number, top: number, width: number, height: number, z = 0): ScenePlane {
  return { id, node: makeNode(id), rect: { left, top, width, height }, z,
    source: { left: 0, top: 0, width, height }, textureSrc: id, textureSize: { width, height }, kind: "native", opacity: 1, hitTestable: true };
}

test("viewport demand includes crossings and selected offscreen layers, skips behind-camera planes", () => {
  const planes = [plane("visible", 10, 10, 10, 10), plane("offscreen", 500, 500, 20, 20),
    plane("crossing", -100, -100, 400, 400), plane("behind", 0, 0, 10, 10, 1200), plane("selected", 500, 500, 20, 20),
    { ...plane("selected:selection", 500, 500, 20, 20), kind: "selection" as const }];
  assert.deepEqual(layerDemandOrder(planes, camera, pivot, viewport, "selected"), ["selected", "visible", "crossing"]);
  assert.deepEqual(layerDemandOrder(planes, { ...camera, panX: -500, panY: -500 }, pivot, viewport), ["offscreen", "selected"]);
  assert.deepEqual(layerDemandOrder([plane("parent:parent", 0, 0, 10, 10)], camera, pivot, viewport), ["parent"]);
});

test("invalid projections stay deferred while explicit selection remains loadable", () => {
  const invalid = plane("invalid", NaN, 0, 10, 10);
  assert.deepEqual(layerDemandOrder([invalid], camera, pivot, viewport), []);
  assert.deepEqual(layerDemandOrder([invalid], camera, pivot, viewport, "invalid"), ["invalid"]);
});

function branchRecord() {
  const root = makeNode("key-root"), branch = makeNode("key-root/0"), child = makeNode("key-root/0/0");
  for (const node of [root, branch, child]) node.bounds = { left: 0, top: 0, right: 40, bottom: 40, raw: "" };
  root.children = [branch]; branch.children = [child]; child.layerImageDataUrl = "image-a"; child.layerImageSize = { width: 40, height: 40 };
  return { record: buildLayerOverview(root, branch, { width: 40, height: 40 }, { expandedIds: new Set([root.id]) }).records[0], child };
}

test("same-time native group results cannot collide with each other or local branch textures", () => {
  const { record } = branchRecord();
  const first = { dataUrl: "group-a", size: { width: 40, height: 40 }, capturedAt: "same-time" }, second = { ...first, dataUrl: "group-b" };
  assert.equal(collapsedTextureKey(record, "", first), collapsedTextureKey(record, "", first));
  assert.notEqual(collapsedTextureKey(record, "", first), collapsedTextureKey(record, "", second));
  assert.notEqual(collapsedTextureKey(record, "", first), collapsedTextureKey(record, "", null));
  const old = collapsedTextureKey(record, "", first); first.dataUrl = "changed-pixels";
  assert.notEqual(collapsedTextureKey(record, "", first), old);
});

test("branch cache invalidates when child pixels, geometry, opacity or clipping change", () => {
  const { record, child } = branchRecord();
  let previous = collapsedTextureKey(record, "", null);
  const mutate = (change: () => void) => {
    change(); const next = collapsedTextureKey(record, "", null); assert.notEqual(next, previous); previous = next;
    assert.ok(next.length < 100); assert.equal(next.includes("image-"), false);
  };
  assert.equal(collapsedTextureKey(record, "", null), previous);
  mutate(() => { child.layerImageDataUrl = "image-b"; });
  mutate(() => { child.bounds = { ...child.bounds!, right: 30 }; });
  mutate(() => { child.attributes = { alpha: "0.5" }; });
  mutate(() => { record.node.attributes = { "clip-children": "true" }; });
  mutate(() => { record.node.attributes!["tree-source"] = "debug-sdk"; });
  mutate(() => { record.node.attributes!["sdk-paddingLeft"] = "10"; });
  mutate(() => { record.node.attributes!["clip-children"] = "false"; });
  mutate(() => { child.attributes = { ...child.attributes, "drawing-order": "4", elevation: "8" }; });
  assert.notEqual(collapsedTextureKey(record, "hide-child", null), previous);
  const clipped = { ...record, node: child, id: child.id };
  const own = nativeTextureKey(clipped, []), clippedOwn = nativeTextureKey(clipped, [record.node]);
  child.bounds = { ...child.bounds!, left: 5, top: 5 };
  assert.equal(nativeTextureKey(clipped, []), own, "unclipped unchanged pixels remain reusable");
  assert.notEqual(nativeTextureKey(clipped, [record.node]), clippedOwn, "relative ancestor clipping changes when a child moves");
});
