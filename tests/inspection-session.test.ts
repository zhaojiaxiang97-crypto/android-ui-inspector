import assert from "node:assert/strict";
import { test } from "node:test";
import type { InspectionPort } from "../src/platform/desktop-services";
import type { InspectionPreview, InspectionProgress, QmlGroupImage, UiSnapshot } from "../shared/types";
import { createInspectionSession } from "../src/features/inspection/inspection-session";
import { createGroupImageCache } from "../src/features/inspection/group-image-cache";
import { makeNode } from "../benchmarks/fixtures";
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const snapshot = (serial = "fixture"): UiSnapshot => ({ serial, root: makeNode("0"), nodeCount: 1, xmlSize: 0,
  rawXml: null, screenshotDataUrl: null, error: null, warning: null });
function harness() {
  const captures: { id: string; serial: string; reply: ReturnType<typeof deferred<UiSnapshot>> }[] = [];
  const canceled: string[] = [], changes: string[] = [];
  let progress!: (event: InspectionProgress) => void, preview!: (event: InspectionPreview) => void, subscriptions = 0;
  const api: InspectionPort = {
    inspectDevice: async (serial, id) => { const reply = deferred<UiSnapshot>(); captures.push({ id, serial, reply }); return reply.promise; },
    cancelInspection: async id => { canceled.push(id); }, captureGroup: async () => null,
    refreshViewNode: async () => ({ nodes: [], failures: [] }), showLayerMenu: async () => null,
    onInspectionProgress: callback => { progress = callback; subscriptions++; return () => { subscriptions--; }; },
    onInspectionPreview: callback => { preview = callback; subscriptions++; return () => { subscriptions--; }; },
  };
  const session = createInspectionSession(api, {
    begin: serial => { changes.push(`begin:${serial}`); }, preview: event => { changes.push(`preview:${event.phase}`); },
    complete: value => { changes.push(`complete:${value.serial}`); }, discard: reason => { changes.push(`discard:${reason}`); },
    open: value => { changes.push(`open:${value.serial}`); }, clear: () => { changes.push("clear"); },
  });
  return { session, captures, canceled, changes, progress: (event: InspectionProgress) => progress(event), preview: (event: InspectionPreview) => preview(event),
    subscriptions: () => subscriptions };
}
test("disposed capture owner rejects retained commands/events and reconnect owns fresh subscriptions", async () => {
  const h = harness();
  assert.equal(await h.session.inspectDevice("before-connect"), null);
  const stop = h.session.connect(); h.session.connect(); assert.equal(h.subscriptions(), 2);
  const old = h.session.inspectDevice("old"), oldId = h.captures[0].id;
  stop(); stop(); assert.deepEqual(h.canceled, [oldId]); assert.equal(h.subscriptions(), 0);
  const unchanged = [...h.changes];
  await h.session.inspectDevice("obsolete"); h.session.showSnapshot(snapshot("obsolete")); h.session.clearInspection(); h.session.cancelInspection();
  h.progress({ requestId: oldId, stage: "late", elapsedMs: 0 });
  h.preview({ requestId: oldId, phase: "tree", snapshot: snapshot("obsolete") });
  assert.deepEqual(h.changes, unchanged); assert.equal(h.captures.length, 1);
  h.session.connect(); assert.equal(h.subscriptions(), 2);
  const fresh = h.session.inspectDevice("fresh"); h.captures[0].reply.resolve(snapshot("old"));
  assert.equal(await old, null); assert.equal(h.session.getState().inspectionLoading, true);
  h.captures[1].reply.resolve(snapshot("fresh")); await fresh;
  assert.equal(h.changes.at(-1), "complete:fresh"); assert.equal(h.session.getState().inspectionLoading, false);
  h.session.dispose(); assert.equal(h.subscriptions(), 0);
});
test("capture token identity rejects an old promise even if a caller reuses its request id", async () => {
  const h = harness(); h.session.connect();
  const scope = { expectedPackage: "example.app", requestId: "reused" };
  const old = h.session.inspectDevice("a", null, scope); h.session.cancelInspection("reused");
  const fresh = h.session.inspectDevice("b", null, scope);
  h.captures[0].reply.reject(new Error("obsolete failure")); assert.equal(await old, null);
  assert.equal(h.session.getState().inspectionLoading, true); assert.equal(h.session.getState().inspectionError, null);
  h.captures[1].reply.resolve(snapshot("b")); await fresh;
  assert.equal(h.changes.at(-1), "complete:b"); h.session.dispose();
});
test("screen updates require the active request's tree and stop after completion", async () => {
  const h = harness(); h.session.connect();
  const done = h.session.inspectDevice("fixture"), requestId = h.captures[0].id;
  const screen: InspectionPreview = { requestId, phase: "screen", screen: { screenshotDataUrl: "screen" } };
  h.preview(screen); assert.deepEqual(h.changes, ["begin:fixture"]);
  h.preview({ requestId, phase: "tree", snapshot: snapshot() });
  h.preview(screen); assert.equal(h.changes.at(-1), "preview:screen");
  h.captures[0].reply.resolve(snapshot()); await done;
  h.preview(screen); assert.equal(h.changes.at(-1), "complete:fixture"); h.session.dispose();
});
test("external snapshot takeover revokes preview/result ownership before opening", async () => {
  const h = harness(); h.session.connect();
  const pending = h.session.inspectDevice("a"), id = h.captures[0].id;
  h.preview({ requestId: id, phase: "tree", snapshot: snapshot("a") });
  h.session.showSnapshot(snapshot("history"));
  assert.deepEqual(h.changes.slice(-2), ["discard:cancel", "open:history"]);
  h.preview({ requestId: id, phase: "tree", snapshot: snapshot("late") });
  h.captures[0].reply.resolve(snapshot("late")); assert.equal(await pending, null);
  assert.equal(h.changes.at(-1), "open:history"); assert.equal(h.session.getState().inspectionLoading, false); h.session.dispose();
});
test("different group nodes run concurrently while same node deduplicates, and disposed caches stay inactive", async () => {
  const source = snapshot(), firstNode = makeNode("0/0"), secondNode = makeNode("0/1");
  source.root!.children = [firstNode, secondNode];
  const calls: { id: string; reply: ReturnType<typeof deferred<QmlGroupImage | null>> }[] = [];
  const api = { captureGroup: async (_request: string, id: string) => { const reply = deferred<QmlGroupImage | null>(); calls.push({ id, reply }); return reply.promise; } };
  const cache = createGroupImageCache(api, () => source, () => {});
  const first = cache.request("live", firstNode, source), duplicate = cache.request("live", firstNode, source);
  const second = cache.request("live", secondNode, source); assert.deepEqual(calls.map(call => call.id), ["0/0", "0/1"]);
  const image = { dataUrl: "data:image/png;base64,aGVsbG8=", size: { width: 4, height: 4 }, capturedAt: "2026-10-14T00:00:00Z" };
  calls[1].reply.resolve(image); assert.equal(await second, image);
  cache.dispose(); calls[0].reply.resolve(image); assert.equal(await first, null); assert.equal(await duplicate, null);
  assert.equal(await cache.request("live", secondNode, source), null); assert.equal(calls.length, 2);
  cache.activate(); const resumed = cache.request("new-live", secondNode, source); assert.equal(calls.length, 3);
  calls[2].reply.resolve(image); assert.equal(await resumed, image);
});

test("retained group callback cannot start work against a replacement tree with the same live request id", async () => {
  const original = snapshot(), node = original.root!; let current = original, calls = 0;
  const cache = createGroupImageCache({ captureGroup: async () => { calls++; return null; } }, () => current, () => {});
  const retained = () => cache.request("same-live-request", node, original);
  current = snapshot();
  assert.equal(await retained(), null); assert.equal(calls, 0);
  assert.equal(await cache.request("same-live-request", node, current), null); assert.equal(calls, 0);
  await cache.request("same-live-request", current.root!, current); assert.equal(calls, 1);
});

test("policy invalidation revokes capture results and live ids without discarding the displayed document", async () => {
  const h = harness(); h.session.connect();
  const capture = h.session.inspectDevice("fixture"), id = h.captures[0].id;
  h.preview({ requestId: id, phase: "tree", snapshot: snapshot() });
  const previous = [...h.changes]; h.session.invalidateLiveRequests();
  h.captures[0].reply.resolve(snapshot()); assert.equal(await capture, null);
  h.preview({ requestId: id, phase: "tree", snapshot: snapshot("obsolete") });
  assert.deepEqual(h.changes, previous); assert.deepEqual(h.canceled, [id]);
  assert.equal(h.session.getState().inspectionLoading, false);
  const fresh = h.session.inspectDevice("fixture");
  const next = snapshot(); next.inspectionSource = "debug-hybrid";
  next.root!.attributes = { "debug-process-id": "1", "debug-window-name": "window" };
  h.captures[1].reply.resolve(next); await fresh; assert.ok(h.session.getState().viewLiveRequestId);
  h.session.invalidateLiveRequests(); assert.equal(h.session.getState().viewLiveRequestId, null);
  assert.equal(h.changes.at(-1), "complete:fixture"); h.session.dispose();
});

test("invalidating pending group work preserves successful images for display and snapshot export", async () => {
  const source = snapshot(), a = makeNode("0/0"), b = makeNode("0/1"); source.root!.children = [a, b];
  const pending = deferred<QmlGroupImage | null>();
  const image: QmlGroupImage = { dataUrl: "data:image/png;base64,aGVsbG8=", size: { width: 4, height: 4 }, capturedAt: "2026-10-15T00:00:00Z" };
  const cache = createGroupImageCache({ captureGroup: async (_request, id) => id === a.id ? image : pending.promise }, () => source, () => {});
  await cache.request("live", a, source); const late = cache.request("live", b, source);
  cache.invalidatePending(); pending.resolve(image); assert.equal(await late, null);
  assert.deepEqual(cache.images(source), [{ nodeId: a.id, image }]);
  assert.deepEqual(cache.snapshotForStorage()!.layerGroupImages, [{ nodeId: a.id, image }]);
  assert.equal(source.root!.children[0], a);
});

test("obsolete group failures do not escape after policy invalidation", async () => {
  const source = snapshot(), pending = deferred<QmlGroupImage | null>();
  const cache = createGroupImageCache({ captureGroup: () => pending.promise }, () => source, () => {});
  const old = cache.request("live", source.root!, source);
  cache.invalidatePending(); pending.reject(new Error("obsolete transport failure"));
  assert.equal(await old, null);
});
