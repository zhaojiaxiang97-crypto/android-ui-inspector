import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopApi } from "../shared/desktop-api";
import type { InspectionProgress } from "../shared/types";
import { createDesktopServices } from "../src/platform/desktop-services";

function bridge(label: string) {
  const calls: string[] = [];
  let progress: ((value: InspectionProgress) => void) | null = null;
  const api: DesktopApi = {
    runtime: { sandboxed: true, contextIsolated: true },
    probeAdb: async () => { throw new Error("unexpected device probe"); },
    inspectDevice: async () => { throw new Error("unexpected capture"); },
    captureGroup: async () => null,
    refreshViewNode: async () => { throw new Error("unexpected refresh"); },
    readViewStyle: async () => { throw new Error("unexpected style read"); },
    cancelInspection: async requestId => { calls.push(`${label}:cancel:${requestId}`); },
    showLayerMenu: async () => null,
    onInspectionProgress: callback => {
      progress = callback;
      return () => { calls.push(`${label}:unsubscribe`); progress = null; };
    },
    onInspectionPreview: () => () => {},
    copyText: async () => {},
    exportSnapshot: async () => ({ canceled: true, filePath: null, error: null }),
    loadSnapshots: async () => { calls.push(`${label}:history`); return { snapshots: [], error: null }; },
    saveSnapshot: async () => ({ snapshots: [], error: null }),
    clearSnapshots: async () => ({ snapshots: [], error: null }),
  };
  return { api, calls, publish: (value: InspectionProgress) => progress?.(value) };
}

test("desktop composition uses its supplied bridge without a window or import-time singleton", async () => {
  const first = bridge("first"), second = bridge("second");
  const a = createDesktopServices(first.api), b = createDesktopServices(second.api);
  await a.snapshots.loadSnapshots();
  await b.inspection.cancelInspection("new-request");
  assert.deepEqual(first.calls, ["first:history"]);
  assert.deepEqual(second.calls, ["second:cancel:new-request"]);
  assert.equal(a.menu.runtime, first.api.runtime);
});

test("legacy bridge capabilities stay absent and diagnosis requires both run and cancel", () => {
  const { api } = bridge("legacy");
  const legacy = createDesktopServices(api);
  assert.equal(legacy.snapshots.importSnapshotFile, undefined);
  assert.equal(legacy.menu.onAppMenuAction, undefined);
  assert.equal(legacy.diagnostics, undefined);
  const diagnoseConnection: NonNullable<DesktopApi["diagnoseConnection"]> = async () => { throw new Error("not invoked"); };
  const cancelConnectionDiagnosis = async () => {};
  assert.equal(createDesktopServices({ ...api, diagnoseConnection }).diagnostics, undefined);
  assert.equal(createDesktopServices({ ...api, cancelConnectionDiagnosis }).diagnostics, undefined);
  assert.deepEqual(createDesktopServices({ ...api, diagnoseConnection, cancelConnectionDiagnosis }).diagnostics,
    { diagnoseConnection, cancelConnectionDiagnosis });
});

test("inspection port preserves event identity and releases the original subscription", () => {
  const fixture = bridge("events"), port = createDesktopServices(fixture.api).inspection;
  const received: InspectionProgress[] = [];
  const release = port.onInspectionProgress(event => received.push(event));
  const event = { requestId: "capture", stage: "tree", elapsedMs: 7 };
  fixture.publish(event);
  assert.equal(received[0], event);
  release();
  fixture.publish({ ...event, stage: "late" });
  assert.equal(received.length, 1);
  assert.deepEqual(fixture.calls, ["events:unsubscribe"]);
});

test("mode settings require all three bridge capabilities and stay unavailable in offline fixtures", () => {
  const { api } = bridge("mode");
  const mode = { getInspectionMode: async () => ({ mode: "standard" as const, revision: 0, busy: false }),
    setInspectionMode: async () => ({ mode: "standard" as const, revision: 0, busy: false }), onInspectionMode: () => () => {} };
  assert.equal(createDesktopServices(api).inspectionMode, undefined);
  assert.equal(createDesktopServices({ ...api, getInspectionMode: mode.getInspectionMode }).inspectionMode, undefined);
  assert.deepEqual(createDesktopServices({ ...api, ...mode }).inspectionMode, mode);
  assert.equal(createDesktopServices({ ...api, ...mode, runtime: { ...api.runtime, fixtureMode: true } }).inspectionMode, undefined);
});
