import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { makeNode } from "../benchmarks/fixtures";
import { changedLayerImages, layerImageBaseline, layerImageUpdates, mergeLayerImages, flattenNodes, remapViewNodeIds } from "../shared/tree-utils";
import { DEFAULT_TREE_COLLAPSE, initialTreeExpansion, reconcileTreeExpansion } from "../shared/tree-collapse";
import { inspectionSingleAttempt, inspectionReadOnlyScope } from "../shared/inspection-policy";
import { isGroupImage } from "../shared/snapshot-validation";
import { isLivePreviewSerial, isLivePreviewSessionId } from "../shared/live-preview";

const main = ts.createSourceFile("main.ts", readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const renderer = ts.createSourceFile("useInspectionWorkspace.ts", readFileSync(new URL("../src/features/inspection/useInspectionWorkspace.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
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
const hookCallback = (name: string) => {
  const declaration = find(renderer, node => ts.isVariableDeclaration(node) && node.name.getText(renderer) === name) as ts.VariableDeclaration;
  return (declaration.initializer as ts.CallExpression).arguments[0].getText(renderer);
};
const previewCallback = (find(renderer, node => ts.isCallExpression(node) && node.expression.getText(renderer) === "window.electronApi.onInspectionPreview") as ts.CallExpression).arguments[0].getText(renderer);
function deferred() { let resolve!: (value: any) => void, reject!: (reason: any) => void;
  const promise = new Promise<any>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
function snapshot(image?: string, empty = false) {
  const node = makeNode("0/0"); node.attributes = { "view-ref": "Text@a", "image-source": "SDK 独立图，不含子节点" };
  node.layerImageDataUrl = image; node.layerImageEmpty = empty; node.layerImageStatus = image ? "captured" : undefined;
  const root = makeNode("0"); root.children = [node]; root.attributes = { "debug-process-id": "fixture", "debug-window-name": "fixture-window" };
  return { serial: "fixture", root, nodeCount: 2, inspectionSource: "debug-view", error: null, warning: null };
}

function harness() {
  const sent: any[] = [], calls: any[] = [];
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false,
    send: (channel: string, payload: any) => { const copy = structuredClone(payload); sent.push({ channel, payload: copy });
      if (channel === "inspection-preview") preview(copy); } });
  const event = { sender, senderFrame: sender.mainFrame };
  const inspections = new Map(), liveSessions = new Map(), groupCaptures = new Map(), viewRefreshes = new Map(), previews = new Map();
  const mainScope: Record<string, any> = { mainWindow: { webContents: sender }, inspections, liveSessions, groupCaptures, viewRefreshes,
    previews,
    inspectionSingleAttempt, inspectionReadOnlyScope, stopMcpSharing: () => {}, debugSession: null, debugStarting: false, visualFixtureMode: false,
    fixtureSnapshot: () => { throw new Error("not a visual fixture route"); },
    inspectPreferredDevice: (serial: string, options: any) => { const pending = deferred(); calls.push({ serial, options, ...pending }); return pending.promise; },
    measureLayerImages: async () => {}, changedLayerImages, layerImageBaseline, layerImageUpdates };
  const inspect = evaluate(ipcCallback("inspect-device"), mainScope), cancel = evaluate(ipcCallback("cancel-inspection"), mainScope);
  const state: Record<string, any> = { setSnapshot: null, setSelectedNodeState: null, setTreeExpandedIds: new Set(), setCaptureFailures: [] };
  const cancelled: string[] = [];
  const scope: Record<string, any> = { activeInspectionRef: { current: null }, previewShownRef: { current: false },
    currentSnapshotRef: { current: null }, inspectionStartedRef: { current: 0 }, captureTreeRef: { current: null },
    collapsePreferenceRef: { current: DEFAULT_TREE_COLLAPSE }, sessionCollapseRef: { current: DEFAULT_TREE_COLLAPSE },
    nodeNavigationEpochRef: { current: 0 }, menuRequestRef: { current: 0 }, focusReturnRef: { current: null },
    groupEpochRef: { current: 0 }, capturedGroupsRef: { current: null },
    cancelViewRefresh: () => {}, mergeLayerImages, flattenNodes, remapViewNodeIds, initialTreeExpansion, reconcileTreeExpansion,
    expandedTreeNodeIds: (root: any) => new Set([...flattenNodes(root).values()].filter(node => node.children.length).map(node => node.id)),
    rememberCaptureFailures: (previous: any) => previous,
    window: { electronApi: { inspectDevice: (...args: any[]) => inspect(event, ...args),
      cancelInspection: (id: string) => { cancelled.push(id); return cancel(event, id); } } } };
  for (const setter of new Set((previewCallback + hookCallback("inspectDevice") + hookCallback("cancelInspection") + hookCallback("showSnapshot") + hookCallback("resetPresentation")).match(/\bset[A-Z]\w*/g)))
    scope[setter] = (value: any) => { state[setter] = typeof value === "function" ? value(state[setter]) : value; };
  scope.resetPresentation = evaluate(hookCallback("resetPresentation"), scope);
  const preview = evaluate(previewCallback, scope), capture = evaluate(hookCallback("inspectDevice"), scope), cancelUi = evaluate(hookCallback("cancelInspection"), scope);
  scope.cancelInspection = cancelUi;
  scope.clearTreeFilter = () => {};
  const showSnapshot = evaluate(hookCallback("showSnapshot"), scope);
  const handleExpandedChange = evaluate(hookCallback("handleExpandedChange"), scope);
  return { sender, event, sent, calls, state, scope, mainScope, inspections, liveSessions, groupCaptures, viewRefreshes, cancelled, inspect, cancel, preview, capture, cancelUi, showSnapshot, handleExpandedChange };
}

test("manual capture registers priority and waits for an unfinished live preview to release its child", async () => {
  const h = harness(), released = deferred();
  let yielding = false;
  h.mainScope.previews.set(h.sender.id, { yieldForCapture: () => {
    assert.equal(h.inspections.has(h.sender.id), true);
    yielding = true; return released.promise;
  } });
  const done = h.capture("fixture");
  await turn();
  assert.equal(yielding, true); assert.equal(h.calls.length, 0);
  released.resolve(undefined); await turn();
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(snapshot()); await done;
  assert.equal(h.state.setSnapshot.root.id, "0");
});

test("app quit waits for debug work to settle after authorization has already stopped", async () => {
  const call = find(main, node => ts.isCallExpression(node) && node.expression.getText(main) === "app.on"
    && node.arguments[0]?.getText(main) === '"before-quit"') as ts.CallExpression;
  const cleanup = deferred(); let prevented = 0, quits = 0, stopped = 0;
  const scope = { quitting: false, stopMcpSharing: () => { stopped++; }, closeProviderSessions: () => {},
    connectionDiagnoses: new Map(), reportExports: new Map(), reportSources: new Map(), taskLibraryTransfers: new Map(), previews: new Map(), previewCleanup: new Set(), inspections: new Map(), groupCaptures: new Map(),
    debugSession: { state: { active: false, busy: false }, hasPendingWork: true, settled: () => cleanup.promise },
    app: { quit: () => { quits++; } } };
  const beforeQuit = evaluate(call.arguments[1].getText(main), scope);
  beforeQuit({ preventDefault: () => { prevented++; } }); await turn();
  assert.equal(stopped, 1); assert.equal(prevented, 1); assert.equal(quits, 0);
  cleanup.resolve(undefined); await turn();
  assert.equal(quits, 1);
  beforeQuit({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1);
});

test("closing preview while device validation is pending prevents a late screenshot start", async () => {
  const probe = deferred(); let starts = 0, stops = 0;
  const scope = { requireDesktopSender: () => {}, isLivePreviewSerial, isLivePreviewSessionId,
    previewStartRevision: 0, previewStarts: new Map(), visualFixtureMode: false, probeAdb: () => probe.promise,
    previewFor: () => ({ start: () => { starts++; }, stop: () => { stops++; } }) };
  const event = { sender: { id: 1, isDestroyed: () => false } };
  const start = evaluate(ipcCallback("live-preview-start"), scope), stop = evaluate(ipcCallback("live-preview-stop"), scope);
  const pending = start(event, "device-a");
  const cancelled = assert.rejects(pending, /已取消/);
  stop(event, undefined);
  probe.resolve({ error: null, devices: [{ serial: "device-a", state: "device" }] });
  await cancelled;
  assert.equal(starts, 0); assert.equal(stops, 1); assert.equal(scope.previewStarts.size, 0);
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
  const scope = { currentSnapshotRef: { current: source }, groupEpochRef: { current: 1 }, capturedGroupsRef: { current: null } as { current: any },
    pendingGroupsRef: { current: null } as { current: any }, groupRequestId: "live-session", isGroupImage,
    setGroupImageRevision: (update: (value: number) => number) => { revision = update(revision); },
    window: { electronApi: { captureGroup: () => { calls++; return pending.promise; } } } };
  const request = evaluate(hookCallback("requestGroup"), scope);
  const first = request(source.root.children[0]), second = request(source.root.children[0]);
  assert.equal(calls, 1);
  const image = { dataUrl: "data:image/png;base64,aGVsbG8=", size: { width: 40, height: 40 }, capturedAt: "2026-10-11T00:00:00Z" };
  pending.resolve(image);
  assert.equal(await first, image); assert.equal(await second, image);
  assert.equal(await request(source.root.children[0]), image); assert.equal(calls, 1);
  assert.equal(scope.pendingGroupsRef.current.requests.size, 0);
  assert.equal(revision, 1, "only a new successful group image should notify the properties panel");
});

test("new group source rejects old results with reused node IDs and clears failed in-flight entries", async () => {
  const old = snapshot(), first = deferred(), second = deferred(); let calls = 0, revision = 0;
  const scope = { currentSnapshotRef: { current: old }, groupEpochRef: { current: 1 }, capturedGroupsRef: { current: null } as { current: any },
    pendingGroupsRef: { current: null } as { current: any }, groupRequestId: "live-session", isGroupImage,
    setGroupImageRevision: (update: (value: number) => number) => { revision = update(revision); },
    window: { electronApi: { captureGroup: () => { calls++; return calls === 1 ? first.promise : second.promise; } } } };
  const request = evaluate(hookCallback("requestGroup"), scope);
  const oldResult = request(old.root.children[0]);
  const fresh = snapshot(); scope.currentSnapshotRef.current = fresh; scope.groupEpochRef.current++;
  const freshResult = request(fresh.root.children[0]); assert.equal(calls, 2);
  const image = { dataUrl: "data:image/png;base64,aGVsbG8=", size: { width: 40, height: 40 }, capturedAt: "2026-10-11T00:00:00Z" };
  first.resolve(image); assert.equal(await oldResult, null); assert.equal(scope.capturedGroupsRef.current, null);
  second.reject(new Error("connection lost")); await assert.rejects(freshResult, /connection lost/);
  assert.equal(scope.pendingGroupsRef.current.requests.size, 0);
  assert.equal(await request(fresh.root.children[0]).catch(() => null), null); assert.equal(calls, 3);
  assert.equal(revision, 0, "stale or failed group images must not announce exportable pixels");
});

test("history/automation takeover cancels capture before late previews, failures and results", async () => {
  for (const fail of [false, true]) {
    const h = harness(); const done = h.capture("fixture"); await turn();
    const call = h.calls[0], requestId = h.scope.activeInspectionRef.current;
    call.options.onPreview("tree", snapshot("old-preview"));
    h.state.setLayerFocus = { node: h.state.setSnapshot.root, kind: "branch" };
    h.state.setHiddenNodeIds = new Set(["0/0"]);
    h.scope.focusReturnRef.current = { root: h.state.setSnapshot.root };
    const menuRevision = h.scope.menuRequestRef.current;
    const next = snapshot("chosen-history");
    h.showSnapshot(next, "0/0");
    assert.equal(call.options.signal.aborted, true);
    assert.equal(h.state.setInspectionLoading, false);
    assert.equal(h.state.setSnapshot, next);
    assert.equal(h.state.setSelectedNodeState.id, "0/0");
    h.preview({ requestId, phase: "tree", snapshot: snapshot("queued-old") });
    if (fail) call.reject(new Error("obsolete failure")); else call.resolve(snapshot("obsolete result"));
    await done;
    assert.equal(h.state.setSnapshot, next);
    assert.equal(h.state.setInspectionError, null);
    assert.equal(h.scope.currentSnapshotRef.current, next);
    assert.equal(h.state.setLayerFocus, null);
    assert.equal(h.state.setHiddenNodeIds.size, 0);
    assert.equal(h.scope.focusReturnRef.current, null);
    assert.ok(h.scope.menuRequestRef.current > menuRevision);
  }
});

test("manual folding is scoped to one capture, not reused by positional ids on the next page", async () => {
  const h = harness(); const done = h.capture("fixture"); await turn();
  const call = h.calls[0]; call.options.onPreview("tree", snapshot());
  h.handleExpandedChange(new Set());
  call.resolve(snapshot()); await done;
  assert.equal(h.state.setTreeExpandedIds.has("0"), false);
  const next = h.capture("fixture"); await turn();
  h.calls[1].options.onPreview("tree", snapshot()); h.calls[1].resolve(snapshot()); await next;
  assert.equal(h.state.setTreeExpandedIds.has("0"), true);
});

test("actual desktop and renderer handoff keep default options and SDK empty-image provenance", async () => {
  const h = harness(); const done = h.capture("fixture"); await turn();
  assert.equal(h.calls.length, 1); const call = h.calls[0];
  assert.equal(Object.prototype.hasOwnProperty.call(call.options, "preferVisibleSdk"), false);
  call.options.onPreview("tree", snapshot());
  const image = snapshot("data:image/png;base64,fixture-empty-pixels", true);
  call.options.onPreview("layers", image);
  assert.equal(h.sent[h.sent.length - 1].payload.phase, "layers");
  const node = h.state.setSnapshot.root.children[0];
  assert.equal(node.layerImageEmpty, true); assert.equal(node.layerImageStatus, "captured");
  assert.equal(node.attributes["image-source"], "SDK 独立图，不含子节点");
  assert.equal(h.state.setSelectedNodeState.children[0].layerImageEmpty, true);
  const before = h.sent.length; call.options.onPreview("layers", image); assert.equal(h.sent.length, before, "unchanged batch is not resent");
  call.resolve(image); await done;
  assert.equal(h.state.setInspectionLoading, false); assert.equal(h.inspections.size, 0);
  assert.equal(h.liveSessions.get(1).snapshot, image); assert.equal(h.sender.listenerCount("destroyed"), 0);
});

test("cancel drops late events/results and recovery waits for old capture disposal", async () => {
  const h = harness(); const first = h.capture("fixture"); await turn(); const old = h.calls[0];
  old.options.onPreview("tree", snapshot()); old.options.onPreview("layers", snapshot("old"));
  const oldId = h.scope.activeInspectionRef.current;
  h.cancelUi(); assert.equal(old.options.signal.aborted, true); assert.equal(h.state.setSnapshot, null);
  assert.equal(h.state.setSelectedNodeState, null); assert.equal(h.state.setTreeExpandedIds.size, 0);
  const before = h.sent.length;
  old.options.onProgress("late SDK progress", 100); old.options.onPreview("layers", snapshot("late"));
  assert.equal(h.sent.length, before, "cancelled requests cannot send progress or previews");
  const second = h.capture("fixture"); await turn(); assert.equal(h.calls.length, 1, "release prior debugger before recovery");
  old.resolve(snapshot("late-result")); await first; await turn();
  assert.equal(h.calls.length, 2); assert.equal(h.state.setSnapshot, null); assert.equal(h.state.setInspectionLoading, true);
  assert.equal(h.inspections.size, 1, "old finally must not delete recovery");
  h.preview({ requestId: oldId, phase: "tree", snapshot: snapshot("old-queued-event") });
  assert.equal(h.state.setSnapshot, null, "renderer rejects events already queued before cancel");
  const current = h.calls[1]; current.options.onPreview("tree", snapshot());
  current.options.onPreview("layers", snapshot("recovered", true)); current.resolve(snapshot("recovered", true)); await second;
  const recovered = h.state.setSnapshot as ReturnType<typeof snapshot> | null;
  assert.ok(recovered);
  assert.equal(recovered.root.children[0].layerImageDataUrl, "recovered");
  assert.equal(recovered.root.children[0].layerImageEmpty, true);
  assert.equal(h.state.setInspectionLoading, false); assert.equal(h.inspections.size, 0);
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
  assert.equal(h.inspections.size, 0); assert.equal(h.liveSessions.size, 0); assert.equal(h.sender.listenerCount("destroyed"), 0);
});

test("SDK tree replacement forwards current pixels; rejected capture clears partial renderer state", async () => {
  const h = harness(); const done = h.capture("fixture"); await turn(); const call = h.calls[0];
  call.options.onPreview("tree", snapshot());
  const changed = snapshot("new-shape", true); changed.root.children.push(makeNode("0/1"));
  call.options.onPreview("layers", changed);
  assert.deepEqual(h.sent.slice(-2).map(item => item.payload.phase), ["tree", "layers"]);
  assert.equal(h.state.setSnapshot.root.children.length, 2);
  assert.equal(h.state.setSnapshot.root.children[0].layerImageDataUrl, "new-shape");
  call.reject(new Error("SDK capture failed")); await done;
  assert.equal(h.state.setSnapshot, null); assert.equal(h.state.setSelectedNodeState, null);
  assert.equal(h.state.setInspectionError, "SDK capture failed"); assert.equal(h.state.setInspectionLoading, false);
  assert.equal(h.liveSessions.size, 0);
});

test("actual preload preserves ordinary capture arguments and preview subscriptions", async () => {
  const preload = ts.createSourceFile("preload.ts", readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const object = (find(preload, node => ts.isCallExpression(node) && node.expression.getText(preload) === "contextBridge.exposeInMainWorld") as ts.CallExpression).arguments[1];
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
  assert.equal(h.state.setSnapshot, result);
  assert.equal(h.inspections.size, 0);
});

test("read-only IPC rejects invalid scope and busy owners before another capture", async () => {
  const h = harness();
  await assert.rejects(h.inspect(h.event, "fixture", "bad", null, false, { expectedPackage: "sample.app" }), /单次/);
  await assert.rejects(h.inspect(h.event, "fixture", "bad", null, true, { expectedPackage: "sample.app;input" }), /有效/);
  for (const map of [h.inspections, h.groupCaptures, h.viewRefreshes]) {
    map.set(1, {});
    await assert.rejects(h.inspect(h.event, "fixture", "busy", null, true, { expectedPackage: "sample.app" }), /已有采集/);
    map.clear();
  }
  h.mainScope.debugSession = { state: { active: true } };
  await assert.rejects(h.inspect(h.event, "fixture", "busy", null, true, { expectedPackage: "sample.app" }), /自动调试/);
  assert.equal(h.calls.length, 0);
});

test("diagnosis scoped cancellation cannot stop a newer workspace request", async () => {
  const h = harness(); const done = h.capture("fixture"); await turn();
  h.cancelUi("old-report-request");
  assert.equal(h.calls[0].options.signal.aborted, false);
  assert.equal(h.state.setInspectionLoading, true);
  h.calls[0].resolve(snapshot()); await done;
});

test("report cancellation drops late result, and failure propagates once for diagnosis", async () => {
  const h = harness(); const done = h.capture("fixture", null, { expectedPackage: "sample.app", requestId: "report" }); await turn();
  h.cancelUi("report"); h.calls[0].resolve(snapshot("late"));
  assert.equal(await done, null); assert.equal(h.state.setSnapshot, null);
  const failed = h.capture("fixture", null, { expectedPackage: "sample.app", requestId: "failure" });
  const rejection = assert.rejects(failed, /fixture failure/); await turn();
  h.calls[1].reject(new Error("fixture failure")); await rejection;
  assert.equal(h.calls.length, 2); assert.equal(h.state.setInspectionLoading, false);
  assert.equal(h.state.setInspectionError, "fixture failure");
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
  assert.equal(h.liveSessions.size, 0); assert.equal(h.inspections.size, 0); assert.equal(cleared, 1);
});

test("read-only deadline retains its explanation when a cancelled transport throws AbortError", async () => {
  const h = harness(); let fire!: () => void;
  h.mainScope.setTimeout = (callback: () => void) => { fire = callback; return "deadline"; };
  h.mainScope.clearTimeout = () => {};
  const done = h.inspect(h.event, "fixture", "deadline", null, true, { expectedPackage: "sample.app" });
  const rejection = assert.rejects(done, /超过30秒/); await turn(); fire();
  h.calls[0].reject(new DOMException("The operation was aborted", "AbortError"));
  await rejection; assert.equal(h.inspections.size, 0);
});
