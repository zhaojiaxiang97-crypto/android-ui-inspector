import assert from "node:assert/strict";
import { test } from "node:test";
import type { InspectionMode, InspectionModeState } from "../shared/inspection-mode";
import type { InspectionModePort } from "../src/platform/desktop-services";
import { createInspectionModeSettings } from "../src/features/inspection/inspection-mode-settings";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const standard: InspectionModeState = { mode: "standard", revision: 0, busy: false };
const enhanced: InspectionModeState = { mode: "sdk-enhanced", revision: 1, busy: false };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  const loads: ReturnType<typeof deferred<InspectionModeState>>[] = [];
  const saves: { mode: InspectionMode; reply: ReturnType<typeof deferred<InspectionModeState>> }[] = [];
  let event!: (state: InspectionModeState) => void, revisions = 0, subscriptions = 0, blocked = false;
  const api: InspectionModePort = {
    getInspectionMode: () => { const reply = deferred<InspectionModeState>(); loads.push(reply); return reply.promise; },
    setInspectionMode: mode => { const reply = deferred<InspectionModeState>(); saves.push({ mode, reply }); return reply.promise; },
    onInspectionMode: callback => { event = callback; subscriptions++; return () => { subscriptions--; }; },
  };
  const settings = createInspectionModeSettings(api, () => { revisions++; }, () => blocked);
  return { settings, loads, saves, event: (state: InspectionModeState) => event(state),
    get revisions() { return revisions; }, get subscriptions() { return subscriptions; }, block: (value: boolean) => { blocked = value; } };
}
test("mode settings default to standard and wait for main-process load before accepting a toggle", async () => {
  const f = fixture(); f.settings.connect();
  assert.equal(f.settings.getState().mode, "standard"); assert.equal(f.settings.getState().loaded, false);
  await f.settings.setMode("sdk-enhanced"); assert.equal(f.saves.length, 0);
  f.loads[0].resolve(standard); await settle();
  assert.equal(f.settings.getState().loaded, true);
  const save = f.settings.setMode("sdk-enhanced");
  assert.equal(f.settings.getState().saving, true); assert.equal(f.settings.getState().mode, "standard");
  await f.settings.setMode("sdk-enhanced"); assert.equal(f.saves.length, 1);
  f.saves[0].reply.resolve(enhanced); await save;
  assert.equal(f.settings.getState().mode, "sdk-enhanced"); assert.equal(f.revisions, 1); f.settings.dispose();
});
test("events supersede an older initial read without enabling edits before load finishes", async () => {
  const f = fixture(); f.settings.connect(); f.event(enhanced);
  assert.equal(f.settings.getState().loaded, false);
  f.loads[0].resolve(standard); await settle();
  assert.equal(f.settings.getState().mode, "sdk-enhanced"); assert.equal(f.settings.getState().revision, 1);
  assert.equal(f.settings.getState().loaded, true); assert.equal(f.revisions, 0); f.settings.dispose();
});
test("same-revision responses do not overwrite newer busy events and stale revisions never roll back", async () => {
  const f = fixture(); f.settings.connect(); f.loads[0].resolve(standard); await settle();
  const save = f.settings.setMode("sdk-enhanced"); f.event(enhanced); f.event({ ...enhanced, busy: true });
  f.saves[0].reply.resolve(enhanced); await save;
  assert.equal(f.settings.getState().busy, true); assert.equal(f.revisions, 1);
  f.event(standard); await f.settings.setMode("standard"); assert.equal(f.saves.length, 1);
  f.event({ ...enhanced, busy: false }); f.block(true); await f.settings.setMode("standard"); assert.equal(f.saves.length, 1);
  f.block(false); const next = f.settings.setMode("standard"); f.saves[1].reply.resolve({ ...standard, revision: 2 }); await next;
  assert.equal(f.revisions, 2); f.settings.dispose();
});
test("failed reads remain disabled and retry succeeds; failed saves preserve the confirmed mode and visible error", async () => {
  const f = fixture(); f.settings.connect(); f.loads[0].reject(new Error("读取失败")); await settle();
  assert.equal(f.settings.getState().error, "读取失败"); assert.equal(f.settings.getState().loaded, false);
  await f.settings.setMode("sdk-enhanced"); assert.equal(f.saves.length, 0);
  const reload = f.settings.reload(); f.loads[1].resolve(standard); await reload;
  const save = f.settings.setMode("sdk-enhanced"); f.saves[0].reply.reject(new Error("写入失败")); await save;
  assert.equal(f.settings.getState().mode, "standard"); assert.equal(f.settings.getState().saving, false);
  assert.equal(f.settings.getState().error, "写入失败"); assert.equal(f.revisions, 0); f.settings.dispose();
});
test("missing API remains unavailable and malformed state is never treated as a successful load", async () => {
  const legacy = createInspectionModeSettings(undefined, () => { throw new Error("unexpected revision"); });
  legacy.connect(); await legacy.setMode("sdk-enhanced");
  assert.equal(legacy.getState().available, false); assert.equal(legacy.getState().loaded, false); legacy.dispose();
  const f = fixture(); f.settings.connect(); f.loads[0].resolve({ ...standard, revision: -1 }); await settle();
  assert.equal(f.settings.getState().loaded, false); assert.match(f.settings.getState().error!, /无效/); f.settings.dispose();
});
test("disconnect revokes replies and events; reconnect loads afresh without duplicate subscriptions", async () => {
  const f = fixture(); f.settings.connect(); f.settings.connect(); assert.equal(f.subscriptions, 1);
  f.settings.dispose(); f.loads[0].resolve(enhanced); f.event(enhanced); await settle();
  assert.equal(f.settings.getState().mode, "standard"); assert.equal(f.subscriptions, 0);
  f.settings.connect(); f.loads[1].resolve(standard); await settle();
  const save = f.settings.setMode("sdk-enhanced"); f.settings.dispose(); f.saves[0].reply.resolve(enhanced); await save;
  assert.equal(f.settings.getState().mode, "standard"); assert.equal(f.revisions, 0); assert.equal(f.subscriptions, 0);
});
