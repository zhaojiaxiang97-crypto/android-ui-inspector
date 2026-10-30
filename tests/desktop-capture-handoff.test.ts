import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { makeNode } from "../benchmarks/fixtures";
import { mergeLayerImages, flattenNodes } from "../shared/tree-utils";
import { DEFAULT_TREE_COLLAPSE, initialTreeExpansion } from "../shared/tree-collapse";
import { createCaptureHandlers } from "../electron/desktop/capture-ipc";
import { createInspectionService } from "../electron/desktop/inspection-service";
import { createWindowOperationScope } from "../electron/desktop/window-operation-scope";
import { createDesktopRuntime } from "../electron/desktop/create-desktop-runtime";
import type { InspectionPort } from "../src/platform/desktop-services";
import type { InspectionPreview, InspectionProgress, UiNode, UiSnapshot } from "../shared/types";
import { createInspectionSession } from "../src/features/inspection/inspection-session";
import { captureTreePresentation } from "../src/features/inspection/inspection-presentation";
import { createGroupImageCache } from "../src/features/inspection/group-image-cache";
import { createLivePreviewHandlers } from "../electron/desktop/live-preview-ipc";

const main = ts.createSourceFile("main.ts", readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function find(file: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); };
  visit(file); assert.ok(found); return found;
}
function evaluate(expression: string, scope: Record<string, any>) {
  const code = ts.transpileModule(`const callback = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2021 } }).outputText;
  return new Function("scope", `with(scope) {${code} return callback;}`)(scope);
}
const ipcCallback = (name: string) => (find(main, node => ts.isCallExpression(node) && node.expression.getText(main) === "ipcMain.handle"
  && node.arguments[0]?.getText(main) === JSON.stringify(name)) as ts.CallExpression).arguments[1].getText(main);
function deferred() { let resolve!: (value: any) => void, reject!: (reason: any) => void;
  const promise = new Promise<any>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
function snapshot(image?: string, empty = false): UiSnapshot & { root: UiNode } {
  const node = makeNode("0/0"); node.attributes = { "view-ref": "Text@a", "image-source": "SDK 独立图，不含子节点" };
  node.layerImageDataUrl = image; node.layerImageEmpty = empty; node.layerImageStatus = image ? "captured" : undefined;
  const root = makeNode("0"); root.children = [node]; root.attributes = { "debug-process-id": "fixture", "debug-window-name": "fixture-window" };
  return { serial: "fixture", root, nodeCount: 2, inspectionSource: "debug-view", error: null, warning: null, xmlSize: 0, rawXml: null, screenshotDataUrl: null };
}

function harness() {
  const sent: any[] = [], calls: any[] = [], groupCalls: any[] = [], refreshCalls: any[] = [];
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false,
    send: (channel: string, payload: any) => { const copy = structuredClone(payload); sent.push({ channel, payload: copy });
      if (channel === "inspection-preview") preview(copy);
      if (channel === "inspection-progress") progress(copy); } });
  const event = { sender, senderFrame: sender.mainFrame };
  const previews = new Map();
  const mainScope: Record<string, any> = { previews, debugSession: null, setTimeout, clearTimeout };
  const unused = async (): Promise<never> => { throw new Error("unexpected capture route"); };
  const service = createInspectionService({
    operations: createWindowOperationScope(), debugStarting: () => false, debugSession: () => mainScope.debugSession,
    stopSharing: () => {},
    inspect: (serial, options) => { const pending = deferred(); calls.push({ serial, options, ...pending }); return pending.promise; },
    measureLayerImages: async () => {}, yieldPreview: owner => previews.get(owner)?.yieldForCapture(),
    withPreviewHeld: async (_owner, action) => action(),
    captureQmlGroupImage: unused, captureViewGroupImage: () => { const pending = deferred(); groupCalls.push(pending); return pending.promise; },
    captureListViewItems: unused, captureViewNodes: () => { const pending = deferred(); refreshCalls.push(pending); return pending.promise; }, captureViewStyle: unused,
    setTimeout: ((callback: () => void, ms: number) => mainScope.setTimeout(callback, ms)) as typeof setTimeout,
    clearTimeout: token => mainScope.clearTimeout(token),
  });
  const handlers = createCaptureHandlers(service, () => sender);
  const inspect = handlers["inspect-device"], cancel = handlers["cancel-inspection"];
  // Real capture controller + real presentation reconciliation; the sink records
  // UI changes without extracting source text or emulating React setter internals.
  const state: Record<string, any> = { snapshot: null, selectedNode: null, expandedIds: new Set() };
  const cancelled: string[] = [];
  let previewListener: ((event: InspectionPreview) => void) | undefined;
  let progressListener: ((event: InspectionProgress) => void) | undefined;
  const preview = (event: InspectionPreview) => previewListener?.(event);
  const progress = (event: InspectionProgress) => progressListener?.(event);
  const currentSnapshotRef: { current: UiSnapshot | null } = { current: null };
  const focusReturnRef: { current: unknown } = { current: null }, menuRequestRef = { current: 0 };
  let captureTree: UiNode | null = null, treeTouched = false;
  function resetPresentation() {
    state.layerFocus = null; state.hiddenNodeIds = new Set();
    focusReturnRef.current = null; menuRequestRef.current++;
  }
  function presentTree(root: UiNode | null, previous: UiNode | null) {
    const next = captureTreePresentation(previous, root, treeTouched, DEFAULT_TREE_COLLAPSE);
    state.selectedNode = next.select(state.selectedNode); state.expandedIds = next.expand(state.expandedIds);
  }
  const api: InspectionPort = {
    inspectDevice: (serial, requestId, priority, single, requestScope) => inspect(event, serial, requestId, priority, single, requestScope),
    cancelInspection: async id => { cancelled.push(id); cancel(event, id); },
    onInspectionPreview: callback => { previewListener = callback; return () => { previewListener = undefined; }; },
    onInspectionProgress: callback => { progressListener = callback; return () => { progressListener = undefined; }; },
    captureGroup: unused, refreshViewNode: unused, showLayerMenu: unused,
  };
  const session = createInspectionSession(api, {
    begin() { resetPresentation(); currentSnapshotRef.current = state.snapshot = null; captureTree = null; treeTouched = false; presentTree(null, null); },
    preview(event) {
      if (event.phase === "layers") {
        const current = currentSnapshotRef.current!;
        const root = mergeLayerImages(current.root!, event.updates);
        currentSnapshotRef.current = state.snapshot = { ...current, root }; captureTree = root;
        if (!treeTouched) state.expandedIds = initialTreeExpansion(root, DEFAULT_TREE_COLLAPSE);
        state.selectedNode = state.selectedNode ? flattenNodes(root).get(state.selectedNode.id) : null;
      } else {
        const previous = captureTree; captureTree = event.snapshot.root;
        currentSnapshotRef.current = state.snapshot = event.snapshot; presentTree(event.snapshot.root, previous);
      }
    },
    complete(result) { const previous = captureTree; captureTree = null; currentSnapshotRef.current = state.snapshot = result; presentTree(result.root, previous); },
    discard(reason) { if (reason === "cancel") resetPresentation(); captureTree = null; currentSnapshotRef.current = state.snapshot = null; presentTree(null, null); },
    open(next, selectedId) {
      resetPresentation(); currentSnapshotRef.current = state.snapshot = next; captureTree = null;
      presentTree(next.root, null); state.selectedNode = selectedId && next.root ? flattenNodes(next.root).get(selectedId) ?? next.root : next.root;
    },
    clear() { resetPresentation(); currentSnapshotRef.current = state.snapshot = null; presentTree(null, null); },
  });
  session.subscribe(() => {
    for (const [name, value] of Object.entries(session.getState())) state[name] = value;
  });
  session.connect();
  const scope = { activeInspectionRef: { get current() { return session.currentRequestId(); } }, currentSnapshotRef, focusReturnRef, menuRequestRef };
  const handleExpandedChange = (next: ReadonlySet<string>) => { treeTouched = true; state.expandedIds = next; };
  return { sender, event, sent, calls, state, scope, mainScope, service, groupCalls, refreshCalls, cancelled, inspect, cancel, preview,
    capture: session.inspectDevice, cancelUi: session.cancelInspection, showSnapshot: session.showSnapshot, handleExpandedChange, session };
}

test("manual capture registers priority and waits for an unfinished live preview to release its child", async () => {
  const h = harness(), released = deferred();
  let yielding = false;
  h.mainScope.previews.set(h.sender.id, { yieldForCapture: () => {
    assert.equal(h.service.hasInspections(h.sender.id), true);
    yielding = true; return released.promise;
  } });
  const done = h.capture("fixture");
  await turn();
  assert.equal(yielding, true); assert.equal(h.calls.length, 0);
  released.resolve(undefined); await turn();
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(snapshot()); await done;
  assert.equal(h.state.snapshot.root.id, "0");
});

test("app quit waits for debug work to settle after authorization has already stopped", async () => {
  const cleanup = deferred(); let prevented = 0, quits = 0, stopped = 0;
  const runtime = createDesktopRuntime({ stopSharing: () => { stopped++; }, closeProviderSessions: async () => {},
    reportShutdownError: error => { throw error; }, disposePreviews: async () => {}, settleDebug: () => cleanup.promise });
  const beforeQuit = (event: { preventDefault(): void }) => runtime.beforeQuit(event, () => { quits++; });
  beforeQuit({ preventDefault: () => { prevented++; } }); await turn();
  assert.equal(stopped, 1); assert.equal(prevented, 1); assert.equal(quits, 0);
  cleanup.resolve(undefined); await turn();
  assert.equal(quits, 1);
  beforeQuit({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1);
});

test("closing preview while device validation is pending prevents a late screenshot start", async () => {
  const probe = deferred(); let starts = 0, stops = 0;
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false, send: () => {} });
  const controls = createLivePreviewHandlers({ requireSender: () => {}, operations: createWindowOperationScope(), probe: () => probe.promise,
    previewFor: () => ({ start: () => { starts++; }, stop: () => { stops++; } }) as any });
  const event = { sender, senderFrame: sender.mainFrame };
  const start = controls.handlers["live-preview-start"], stop = controls.handlers["live-preview-stop"];
  const pending = start(event, "device-a");
  const cancelled = assert.rejects(pending, /已取消/);
  stop(event, undefined);
  probe.resolve({ error: null, devices: [{ serial: "device-a", state: "device" }] });
  await cancelled;
  assert.equal(starts, 0); assert.equal(stops, 1);
});

test("control image output IPC accepts only the owning window main frame", async () => {
  const sender = { mainFrame: {} }, owner = { webContents: sender }; let calls = 0;
  const scope: Record<string, any> = { mainWindow: owner, exportNodeImage: async (input: unknown, window: unknown) => {
    assert.equal(window, owner); assert.equal(input, "validated-by-exporter"); calls++; return { canceled: true, filePath: null, error: null };
  } };
  const output = evaluate(ipcCallback("output-node-image"), scope);
  for (const event of [{ sender, senderFrame: {} }, { sender, senderFrame: null }, { sender: { mainFrame: sender.mainFrame }, senderFrame: sender.mainFrame }])
    assert.throws(() => output(event, "validated-by-exporter"), /无效的控件图片来源/);
  assert.deepEqual(await output({ sender, senderFrame: sender.mainFrame }, "validated-by-exporter"), { canceled: true, filePath: null, error: null });
  scope.mainWindow = null; assert.throws(() => output({ sender, senderFrame: sender.mainFrame }, "validated-by-exporter"), /无效的控件图片来源/);
  assert.equal(calls, 1);
});

test("group requests share in-flight work and reuse successful results across preview remounts", async () => {
  const source = snapshot(), pending = deferred(); let calls = 0, revision = 0;
  const cache = createGroupImageCache({ captureGroup: async () => { calls++; return pending.promise; } }, () => source, () => { revision++; });
  const request = () => cache.request("live-session", source.root.children[0], source);
  const first = request(), second = request(); assert.equal(calls, 1);
  const image = { dataUrl: "data:image/png;base64,aGVsbG8=", size: { width: 40, height: 40 }, capturedAt: "2026-10-11T00:00:00Z" };
  pending.resolve(image); assert.equal(await first, image); assert.equal(await second, image);
  assert.equal(await request(), image); assert.equal(calls, 1);
  assert.deepEqual(cache.snapshotForStorage()?.layerGroupImages, [{ nodeId: "0/0", image }]);
  assert.equal(revision, 1, "only a new successful group image should notify the properties panel");
});

test("new group source rejects old results with reused node IDs and clears failed in-flight entries", async () => {
  let source = snapshot(); const first = deferred(), second = deferred(); let calls = 0, revision = 0;
  const cache = createGroupImageCache({ captureGroup: async () => { calls++; return calls === 1 ? first.promise : second.promise; } }, () => source, () => { revision++; });
  const request = () => cache.request("live-session", source.root.children[0], source);
  const oldResult = request(); source = snapshot(); cache.invalidate();
  const freshResult = request(); assert.equal(calls, 2);
  const image = { dataUrl: "data:image/png;base64,aGVsbG8=", size: { width: 40, height: 40 }, capturedAt: "2026-10-11T00:00:00Z" };
  first.resolve(image); assert.equal(await oldResult, null); assert.deepEqual(cache.images(source), []);
  second.reject(new Error("connection lost")); await assert.rejects(freshResult, /connection lost/);
  assert.equal(await request().catch(() => null), null); assert.equal(calls, 3);
  assert.equal(revision, 0, "stale or failed group images must not announce exportable pixels");
});

test("history/automation takeover cancels capture before late previews, failures and results", async () => {
  for (const fail of [false, true]) {
    const h = harness(); const done = h.capture("fixture"); await turn();
    const call = h.calls[0], requestId = h.scope.activeInspectionRef.current!;
    call.options.onPreview("tree", snapshot("old-preview"));
    h.state.layerFocus = { node: h.state.snapshot.root, kind: "branch" };
    h.state.hiddenNodeIds = new Set(["0/0"]);
    h.scope.focusReturnRef.current = { root: h.state.snapshot.root };
    const menuRevision = h.scope.menuRequestRef.current;
    const next = snapshot("chosen-history");
    h.showSnapshot(next, "0/0");
    assert.equal(call.options.signal.aborted, true);
    assert.equal(h.state.inspectionLoading, false);
    assert.equal(h.state.snapshot, next);
    assert.equal(h.state.selectedNode.id, "0/0");
    h.preview({ requestId, phase: "tree", snapshot: snapshot("queued-old") });
    if (fail) call.reject(new Error("obsolete failure")); else call.resolve(snapshot("obsolete result"));
    await done;
    assert.equal(h.state.snapshot, next);
    assert.equal(h.state.inspectionError, null);
    assert.equal(h.scope.currentSnapshotRef.current, next);
    assert.equal(h.state.layerFocus, null);
    assert.equal(h.state.hiddenNodeIds.size, 0);
    assert.equal(h.scope.focusReturnRef.current, null);
    assert.ok(h.scope.menuRequestRef.current > menuRevision);
  }
});

test("manual folding is scoped to one capture, not reused by positional ids on the next page", async () => {
  const h = harness(); const done = h.capture("fixture"); await turn();
  const call = h.calls[0]; call.options.onPreview("tree", snapshot());
  h.handleExpandedChange(new Set());
  call.resolve(snapshot()); await done;
  assert.equal(h.state.expandedIds.has("0"), false);
  const next = h.capture("fixture"); await turn();
  h.calls[1].options.onPreview("tree", snapshot()); h.calls[1].resolve(snapshot()); await next;
  assert.equal(h.state.expandedIds.has("0"), true);
});

test("actual desktop and renderer handoff keep default options and SDK empty-image provenance", async () => {
  const h = harness(); const done = h.capture("fixture"); await turn();
  assert.equal(h.calls.length, 1); const call = h.calls[0];
  assert.equal(Object.prototype.hasOwnProperty.call(call.options, "preferVisibleSdk"), false);
  call.options.onPreview("tree", snapshot());
  const image = snapshot("data:image/png;base64,fixture-empty-pixels", true);
  call.options.onPreview("layers", image);
  assert.equal(h.sent[h.sent.length - 1].payload.phase, "layers");
  const node = h.state.snapshot.root.children[0];
  assert.equal(node.layerImageEmpty, true); assert.equal(node.layerImageStatus, "captured");
  assert.equal(node.attributes["image-source"], "SDK 独立图，不含子节点");
  assert.equal(h.state.selectedNode.children[0].layerImageEmpty, true);
  const before = h.sent.length; call.options.onPreview("layers", image); assert.equal(h.sent.length, before, "unchanged batch is not resent");
  call.resolve(image); await done;
  assert.equal(h.state.inspectionLoading, false); assert.equal(h.service.hasInspections(), false);
  assert.equal(h.service.hasSession(1, image as any), true); assert.equal(h.sender.listenerCount("destroyed"), 0);
});

test("cancel drops late events/results and recovery waits for old capture disposal", async () => {
  const h = harness(); const first = h.capture("fixture"); await turn(); const old = h.calls[0];
  old.options.onPreview("tree", snapshot()); old.options.onPreview("layers", snapshot("old"));
  const oldId = h.scope.activeInspectionRef.current!;
  h.cancelUi(); assert.equal(old.options.signal.aborted, true); assert.equal(h.state.snapshot, null);
  assert.equal(h.state.selectedNode, null); assert.equal(h.state.expandedIds.size, 0);
  const before = h.sent.length;
  old.options.onProgress("late SDK progress", 100); old.options.onPreview("layers", snapshot("late"));
  assert.equal(h.sent.length, before, "cancelled requests cannot send progress or previews");
  const second = h.capture("fixture"); await turn(); assert.equal(h.calls.length, 1, "release prior debugger before recovery");
  old.resolve(snapshot("late-result")); await first; await turn();
  assert.equal(h.calls.length, 2); assert.equal(h.state.snapshot, null); assert.equal(h.state.inspectionLoading, true);
  assert.equal(h.service.hasInspections(), true, "old finally must not delete recovery");
  h.preview({ requestId: oldId, phase: "tree", snapshot: snapshot("old-queued-event") });
  assert.equal(h.state.snapshot, null, "renderer rejects events already queued before cancel");
  const current = h.calls[1]; current.options.onPreview("tree", snapshot());
  current.options.onPreview("layers", snapshot("recovered", true)); current.resolve(snapshot("recovered", true)); await second;
  const recovered = h.state.snapshot as ReturnType<typeof snapshot> | null;
  assert.ok(recovered);
  assert.equal(recovered.root.children[0].layerImageDataUrl, "recovered");
  assert.equal(recovered.root.children[0].layerImageEmpty, true);
  assert.equal(h.state.inspectionLoading, false); assert.equal(h.service.hasInspections(), false);
  assert.equal(h.sender.listenerCount("destroyed"), 0); assert.ok(h.cancelled.includes(oldId));
});

test("desktop rejects wrong frame and stale cancel cannot abort a newer request", async () => {
  const h = harness();
  await assert.rejects(h.inspect({ ...h.event, senderFrame: {} }, "fixture", "bad"), /无效的采集来源/);
  assert.equal(h.calls.length, 0);
  const done = h.capture("fixture"); await turn();
  h.cancel(h.event, "obsolete"); assert.equal(h.calls[0].options.signal.aborted, false);
  h.sender.emit("destroyed"); assert.equal(h.calls[0].options.signal.aborted, true);
  h.calls[0].reject(new Error("closed")); await done;
  assert.equal(h.service.hasInspections(), false); assert.equal(h.service.hasSession(h.sender.id), false); assert.equal(h.sender.listenerCount("destroyed"), 0);
});

test("SDK tree replacement forwards current pixels; rejected capture clears partial renderer state", async () => {
  const h = harness(); const done = h.capture("fixture"); await turn(); const call = h.calls[0];
  call.options.onPreview("tree", snapshot());
  const changed = snapshot("new-shape", true); changed.root.children.push(makeNode("0/1"));
  call.options.onPreview("layers", changed);
  assert.deepEqual(h.sent.slice(-2).map(item => item.payload.phase), ["tree", "layers"]);
  assert.equal(h.state.snapshot.root.children.length, 2);
  assert.equal(h.state.snapshot.root.children[0].layerImageDataUrl, "new-shape");
  call.reject(new Error("SDK capture failed")); await done;
  assert.equal(h.state.snapshot, null); assert.equal(h.state.selectedNode, null);
  assert.equal(h.state.inspectionError, "SDK capture failed"); assert.equal(h.state.inspectionLoading, false);
  assert.equal(h.service.hasSession(h.sender.id), false);
});

test("actual preload preserves ordinary capture arguments and preview subscriptions", async () => {
  const preload = ts.createSourceFile("preload.ts", readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let object = (find(preload, node => ts.isCallExpression(node) && node.expression.getText(preload) === "contextBridge.exposeInMainWorld") as ts.CallExpression).arguments[1];
  if (ts.isIdentifier(object)) {
    const declaration = find(preload, node => ts.isVariableDeclaration(node) && node.name.getText(preload) === object.getText(preload)) as ts.VariableDeclaration;
    object = declaration.initializer!;
  }
  const emitter = new EventEmitter(), invokes: any[] = [];
  const api = evaluate(object.getText(preload), { ipcRenderer: Object.assign(emitter, {
    invoke: (...args: any[]) => { invokes.push(args); return Promise.resolve(null); } }) });
  await api.inspectDevice("fixture", "request", null); await api.cancelInspection("request");
  assert.deepEqual(invokes, [["inspect-device", "fixture", "request", null, undefined], ["cancel-inspection", "request"]]);
  await api.inspectDevice("fixture", "diagnosis", null, true, { expectedPackage: "sample.app" });
  assert.deepEqual(invokes.at(-1), ["inspect-device", "fixture", "diagnosis", null, true, { expectedPackage: "sample.app" }]);
  const previews: any[] = [], unsubscribe = api.onInspectionPreview((value: any) => previews.push(value));
  const update = { requestId: "request", phase: "layers", updates: [{ id: "0/0", layerImageEmpty: true, imageSource: "SDK" }] };
  emitter.emit("inspection-preview", {}, update); assert.equal(previews[0], update);
  unsubscribe(); emitter.emit("inspection-preview", {}, update); assert.equal(previews.length, 1);
  assert.equal(emitter.listenerCount("inspection-preview"), 0);
});

test("report capture uses the existing handoff once with fixed App and no restart", async () => {
  const h = harness();
  const done = h.capture("fixture", null, { expectedPackage: "sample.app", requestId: "diagnosis" }); await turn();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.singleAttempt, true);
  assert.equal(h.calls[0].options.expectedPackage, "sample.app");
  assert.equal(h.calls[0].options.allowAppRestart, false);
  assert.equal(h.scope.activeInspectionRef.current, "diagnosis");
  const result = snapshot("diagnostic-image"); h.calls[0].resolve(result);
  assert.equal(await done, result);
  assert.equal(h.state.snapshot, result);
  assert.equal(h.service.hasInspections(), false);
});

test("read-only IPC rejects invalid scope and busy owners before another capture", async () => {
  const h = harness();
  await assert.rejects(h.inspect(h.event, "fixture", "bad", null, false, { expectedPackage: "sample.app" }), /单次/);
  await assert.rejects(h.inspect(h.event, "fixture", "bad", null, true, { expectedPackage: "sample.app;input" }), /有效/);
  const busy = h.capture("fixture"); await turn();
  const requestId = h.scope.activeInspectionRef.current!;
  await assert.rejects(h.inspect(h.event, "fixture", "busy", null, true, { expectedPackage: "sample.app" }), /已有采集/);
  const live = snapshot(); live.inspectionSource = "debug-hybrid";
  h.calls[0].resolve(live); await busy;
  assert.equal(h.state.viewLiveRequestId, requestId);
  const group = h.service.captureGroup(1, requestId, "0/0"); await turn();
  await assert.rejects(h.inspect(h.event, "fixture", "busy", null, true, { expectedPackage: "sample.app" }), /已有采集/);
  h.groupCalls[0].resolve(null); await group;
  const refresh = h.service.refreshView(1, requestId, "0/0", "node");
  const canceledRefresh = assert.rejects(refresh, /fixture refresh ended/); await turn();
  await assert.rejects(h.inspect(h.event, "fixture", "busy", null, true, { expectedPackage: "sample.app" }), /已有采集/);
  h.refreshCalls[0].reject(new Error("fixture refresh ended")); await canceledRefresh;
  h.mainScope.debugSession = { state: { active: true } };
  await assert.rejects(h.inspect(h.event, "fixture", "busy", null, true, { expectedPackage: "sample.app" }), /自动调试/);
  assert.equal(h.calls.length, 1);
});

test("diagnosis scoped cancellation cannot stop a newer workspace request", async () => {
  const h = harness(); const done = h.capture("fixture"); await turn();
  h.cancelUi("old-report-request");
  assert.equal(h.calls[0].options.signal.aborted, false);
  assert.equal(h.state.inspectionLoading, true);
  h.calls[0].resolve(snapshot()); await done;
});

test("report cancellation drops late result, and failure propagates once for diagnosis", async () => {
  const h = harness(); const done = h.capture("fixture", null, { expectedPackage: "sample.app", requestId: "report" }); await turn();
  h.cancelUi("report"); h.calls[0].resolve(snapshot("late"));
  assert.equal(await done, null); assert.equal(h.state.snapshot, null);
  const failed = h.capture("fixture", null, { expectedPackage: "sample.app", requestId: "failure" });
  const rejection = assert.rejects(failed, /fixture failure/); await turn();
  h.calls[1].reject(new Error("fixture failure")); await rejection;
  assert.equal(h.calls.length, 2); assert.equal(h.state.inspectionLoading, false);
  assert.equal(h.state.inspectionError, "fixture failure");
});

test("read-only deadline aborts once and refuses the late successful response", async () => {
  const h = harness(); let fire!: () => void, milliseconds = 0, cleared = 0;
  h.mainScope.setTimeout = (callback: () => void, delay: number) => { fire = callback; milliseconds = delay; return "deadline"; };
  h.mainScope.clearTimeout = (token: string) => { assert.equal(token, "deadline"); cleared++; };
  const done = h.inspect(h.event, "fixture", "deadline", null, true, { expectedPackage: "sample.app" });
  const rejection = assert.rejects(done, /超过30秒/); await turn();
  assert.equal(milliseconds, 30000); assert.equal(h.calls.length, 1); fire();
  assert.equal(h.calls[0].options.signal.aborted, true);
  const before = h.sent.length; h.calls[0].options.onPreview("tree", snapshot("late"));
  assert.equal(h.sent.length, before);
  h.calls[0].resolve(snapshot("late")); await rejection;
  assert.equal(h.service.hasSession(h.sender.id), false); assert.equal(h.service.hasInspections(), false); assert.equal(cleared, 1);
});

test("read-only deadline retains its explanation when a cancelled transport throws AbortError", async () => {
  const h = harness(); let fire!: () => void;
  h.mainScope.setTimeout = (callback: () => void) => { fire = callback; return "deadline"; };
  h.mainScope.clearTimeout = () => {};
  const done = h.inspect(h.event, "fixture", "deadline", null, true, { expectedPackage: "sample.app" });
  const rejection = assert.rejects(done, /超过30秒/); await turn(); fire();
  h.calls[0].reject(new DOMException("The operation was aborted", "AbortError"));
  await rejection; assert.equal(h.service.hasInspections(), false);
});
