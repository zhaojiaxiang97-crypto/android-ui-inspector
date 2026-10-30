import assert from "node:assert/strict";
import { test } from "node:test";
import { createDesktopRuntime } from "../electron/desktop/create-desktop-runtime";
import { createWindowOperationScope } from "../electron/desktop/window-operation-scope";
import { createInspectionService } from "../electron/desktop/inspection-service";
import { createLivePreviewHandlers } from "../electron/desktop/live-preview-ipc";
import { createCaptureHandlers } from "../electron/desktop/capture-ipc";
import { makeNode } from "../benchmarks/fixtures";
import { EventEmitter } from "node:events";
import type { AdbProbeResult, UiSnapshot, ViewRefreshResult } from "../shared/types";

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function snapshot(): UiSnapshot {
  const root = makeNode("0"); root.children = [makeNode("0/0")];
  root.attributes = { "debug-process-id": "fixture", "debug-window-name": "window" };
  return { serial: "fixture", root, nodeCount: 2, inspectionSource: "debug-view", error: null, warning: null,
    xmlSize: 0, rawXml: null, screenshotDataUrl: null };
}

function setup() {
  const order: string[] = [], errors: unknown[] = [];
  const provider = deferred(), debug = deferred(), previews = deferred();
  const runtime = createDesktopRuntime({ stopSharing: () => { order.push("stop-debug"); }, settleDebug: () => debug.promise,
    disposePreviews: () => previews.promise, closeProviderSessions: () => { order.push("close-provider"); return provider.promise; },
    reportShutdownError: error => { errors.push(error); } });
  const captures: Array<ReturnType<typeof deferred<UiSnapshot>>> = [];
  const refreshes: Array<ReturnType<typeof deferred<ViewRefreshResult>> & { signal: AbortSignal }> = [];
  const unused = async (): Promise<never> => { throw new Error("unexpected route"); };
  const service = createInspectionService({ operations: runtime.operations, debugStarting: () => false, debugSession: () => null,
    stopSharing: () => {}, inspect: async () => { const pending = deferred<UiSnapshot>(); captures.push(pending); return pending.promise; },
    measureLayerImages: async () => {}, yieldPreview: () => undefined, withPreviewHeld: async (_owner, action) => action(),
    captureQmlGroupImage: unused, captureViewGroupImage: unused, captureListViewItems: unused, captureViewStyle: unused,
    captureViewNodes: async (_serial, _source, _node, _branch, signal) => {
      assert.ok(signal); const pending = { ...deferred<ViewRefreshResult>(), signal }; refreshes.push(pending); return pending.promise;
    }, setTimeout, clearTimeout });
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false, send: () => {} });
  const event = { sender, senderFrame: sender.mainFrame };
  runtime.registerWindow(1, () => service.invalidate(1));
  const handlers = createCaptureHandlers(service, () => sender);
  async function capture(requestId = "capture") {
    const done = handlers["inspect-device"](event, "fixture", requestId); await flush();
    captures.at(-1)!.resolve(snapshot()); await done;
  }
  return { runtime, service, handlers, event, captures, refreshes, order, errors, provider, debug, previews, capture };
}

test("quit aborts an in-flight view refresh and closes Provider only after all window/debug/preview work", async () => {
  const h = setup(); await h.capture();
  const refresh = h.handlers["refresh-view-node"](h.event, "capture", "0/0");
  const aborted = assert.rejects(refresh, /abort/i); await flush();
  assert.equal(h.refreshes.length, 1);
  let prevented = 0, quits = 0;
  const event = { preventDefault: () => { prevented++; } };
  const quit = () => { quits++; };
  h.runtime.beforeQuit(event, quit); h.runtime.beforeQuit(event, quit);
  assert.equal(h.runtime.quitting, true); assert.equal(h.refreshes[0].signal.aborted, true);
  assert.equal(prevented, 2); assert.equal(quits, 0);
  await assert.rejects(h.handlers["inspect-device"](h.event, "fixture", "late"), /正在退出/);
  h.debug.resolve(); h.previews.resolve(); await flush();
  assert.deepEqual(h.order, ["stop-debug"], "view refresh still owns device resources");
  // Cancellation is checked before consuming the late result or committing its tree.
  h.refreshes[0].resolve({} as ViewRefreshResult); await aborted; await flush();
  assert.deepEqual(h.order, ["stop-debug", "close-provider"]);
  assert.equal(quits, 0, "pending Provider connection disposal must also settle");
  h.runtime.beforeQuit(event, quit); assert.equal(prevented, 3);
  h.provider.resolve(); await h.runtime.dispose(); await flush();
  assert.equal(quits, 1); assert.equal(h.service.hasSession(1), false); assert.equal(h.service.hasViewRefreshes(), false);
  h.runtime.beforeQuit(event, quit); assert.equal(prevented, 3);
  assert.deepEqual(h.errors, []);
});

test("reloading keeps canceled refresh ownership until a replacement capture can safely start", async () => {
  const h = setup(); await h.capture();
  const refresh = h.handlers["refresh-view-node"](h.event, "capture", "0/0");
  const aborted = assert.rejects(refresh, /abort/i); await flush();
  const released = h.runtime.releaseWindow(1, "window-reloaded");
  const capture = h.handlers["inspect-device"](h.event, "fixture", "replacement"); await flush();
  assert.equal(h.refreshes[0].signal.aborted, true);
  assert.equal(h.captures.length, 1, "new capture waits for the old debugger to finish");
  h.refreshes[0].resolve({} as ViewRefreshResult); await aborted; await flush();
  assert.equal(h.captures.length, 2); assert.equal(h.service.hasInspections(1), true);
  h.captures[1].resolve(snapshot()); await capture; await released;
  assert.equal(h.service.hasSession(1), true, "old finally must not remove the replacement session");
  assert.equal(h.service.hasInspections(), false);
});

test("closed window cannot start work and late settlement cannot release another window's operations", async () => {
  const scope = createWindowOperationScope();
  const old = deferred(), replacement = deferred(); let oldCanceled = 0, replacementCanceled = 0;
  scope.track(1, old.promise, () => { oldCanceled++; });
  const closing = scope.close(1);
  scope.track(2, replacement.promise, () => { replacementCanceled++; });
  assert.throws(() => scope.assertAvailable(1), /窗口已关闭/);
  scope.assertAvailable(2); old.resolve(); await closing;
  const disposing = scope.dispose(); assert.equal(disposing, scope.dispose());
  assert.equal(oldCanceled, 1); assert.equal(replacementCanceled, 1);
  let settled = false; void disposing.then(() => { settled = true; }); await flush(); assert.equal(settled, false);
  replacement.resolve(); await disposing; assert.equal(settled, true);
});

test("replaced operations remain owned until both settle and dispose is idempotent", async () => {
  const scope = createWindowOperationScope(), first = deferred(), second = deferred();
  const canceled: string[] = [];
  scope.track(1, first.promise, () => { canceled.push("first"); });
  scope.track(1, second.promise, () => { canceled.push("second"); });
  const done = scope.dispose(); assert.equal(done, scope.dispose());
  assert.deepEqual(canceled, ["first", "second"]);
  let finished = false; void done.then(() => { finished = true; });
  first.reject(new Error("canceled")); await flush(); assert.equal(finished, false);
  second.resolve(); await done; assert.equal(finished, true);
});

test("shutdown reports synchronous and asynchronous cleanup failures, still closes Provider and exits once", async () => {
  const errors: unknown[] = [], order: string[] = [];
  const runtime = createDesktopRuntime({ stopSharing: () => { throw new Error("stop failed"); },
    settleDebug: () => { order.push("debug"); return Promise.reject(new Error("debug failed")); },
    disposePreviews: () => { order.push("previews"); throw new Error("preview failed"); },
    closeProviderSessions: () => { order.push("provider"); return Promise.reject(new Error("provider failed")); },
    reportShutdownError: error => { errors.push(error); } });
  let prevented = 0, quits = 0;
  runtime.beforeQuit({ preventDefault: () => { prevented++; } }, () => { quits++; });
  const disposal = runtime.dispose(); assert.equal(runtime.dispose(), disposal);
  runtime.beforeQuit({ preventDefault: () => { prevented++; } }, () => { quits++; });
  await disposal; await flush();
  assert.equal(prevented, 2); assert.equal(quits, 1);
  assert.equal(errors.length, 4); assert.equal(order.at(-1), "provider");
  runtime.beforeQuit({ preventDefault: () => { prevented++; } }, () => { quits++; }); assert.equal(prevented, 2);
});

test("a failing cancellation does not prevent other operations from aborting and settling", async () => {
  const errors: unknown[] = [], first = deferred(), second = deferred();
  let canceled = 0;
  const scope = createWindowOperationScope(error => { errors.push(error); });
  scope.track(1, first.promise, () => { throw new Error("cancel failed"); });
  scope.track(1, second.promise, () => { canceled++; });
  const done = scope.close(1); const disposal = scope.dispose();
  assert.equal(errors.length, 1); assert.equal(canceled, 1, "each operation receives cancellation once");
  first.resolve(); second.resolve(); await done; await disposal;
});

test("capture adapters preserve null, rejection, and source validation for malformed or stale requests", async () => {
  const h = setup();
  assert.equal(await h.handlers["capture-group"](h.event, "request", "../wrong"), null);
  await assert.rejects(h.handlers["refresh-view-node"](h.event, "request", "../wrong"), /控件标识/);
  await assert.rejects(h.handlers["refresh-view-node"](h.event, "request", "0", "unknown"), /刷新范围/);
  await assert.rejects(h.handlers["read-view-style"](h.event, "request", "0"), /快照已失效/);
  await assert.rejects(h.handlers["capture-group"]({ ...h.event, senderFrame: {} }, "request", "0"), /抓图来源/);
  await assert.rejects(h.handlers["read-view-style"]({ ...h.event, senderFrame: {} }, "request", "0"), /样式请求来源/);
  assert.throws(() => h.handlers["cancel-inspection"]({ ...h.event, senderFrame: {} }, "request"), /取消来源/);
  assert.equal(h.captures.length, 0); assert.equal(h.refreshes.length, 0);
});

test("quit cancels a pending preview validation and waits without allowing a late screenshot start", async () => {
  const probe = deferred<AdbProbeResult>(); let starts = 0, providerClosed = false;
  const runtime = createDesktopRuntime({ stopSharing: () => {}, settleDebug: () => undefined, disposePreviews: async () => {},
    closeProviderSessions: async () => { providerClosed = true; }, reportShutdownError: error => { throw error; } });
  const controls = createLivePreviewHandlers({ requireSender: () => {}, operations: runtime.operations, probe: () => probe.promise,
    previewFor: () => { starts++; throw new Error("late preview must not start"); } });
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false, send: () => {} });
  const pending = controls.handlers["live-preview-start"]({ sender, senderFrame: sender.mainFrame }, "fixture");
  const canceled = assert.rejects(pending, /已取消/);
  const disposal = runtime.dispose(); await flush(); assert.equal(providerClosed, false);
  probe.resolve({ error: null, adbPath: "fixture", adbVersion: "fixture", devices: [] });
  await canceled; await disposal; assert.equal(starts, 0); assert.equal(providerClosed, true);
});
