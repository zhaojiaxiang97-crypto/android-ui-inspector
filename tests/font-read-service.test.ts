import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { makeNode } from "../benchmarks/fixtures";
import { createInspectionService } from "../electron/desktop/inspection-service";
import { createCaptureHandlers } from "../electron/desktop/capture-ipc";
import { createWindowOperationScope } from "../electron/desktop/window-operation-scope";
import type { UiSnapshot, LayerImageCaptureResult, QmlGroupImage, ViewRefreshResult, ViewStyleResult } from "../shared/types";
import type { ViewFontResult } from "../shared/view-font";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
}
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const font: ViewFontResult = { ref: "android.widget.TextView@aa", capturedAtMillis: 123, source: "jdwp", basis: "text-paint",
  familyName: null, familyNameStatus: "not-exposed", weight: 400, style: 0, usesDefaultTypeface: false };
function fixture(source: UiSnapshot["inspectionSource"]): UiSnapshot {
  const root = makeNode("0"), child = makeNode("0/0");
  root.attributes = { "debug-process-id": "1", "debug-window-name": "window", "qml-process-id": "1", "qml-window-id": "window" };
  child.attributes = { "view-ref": font.ref }; root.children = [child];
  return { serial: "device", root, nodeCount: 2, xmlSize: 0, rawXml: null, screenshotDataUrl: null,
    warning: null, error: null, inspectionSource: source, layerCapture: "on-demand" };
}
function harness(source: UiSnapshot["inspectionSource"] = "debug-view") {
  const operations = createWindowOperationScope();
  const calls: Array<{ nodeId: string; source: UiSnapshot; signal?: AbortSignal; mode?: string; result: ReturnType<typeof deferred<ViewFontResult>> }> = [];
  const layers: Array<{ signal?: AbortSignal; result: ReturnType<typeof deferred<LayerImageCaptureResult>> }> = [];
  const refreshes: Array<ReturnType<typeof deferred<ViewRefreshResult>>> = [];
  const groups: Array<ReturnType<typeof deferred<QmlGroupImage | null>>> = [];
  const styles: Array<ReturnType<typeof deferred<ViewStyleResult>>> = [];
  const timers = new Map<number, { callback: () => void; ms: number }>(); let timerId = 0;
  let mode: "standard" | "sdk-enhanced" = source === "debug-hybrid" ? "sdk-enhanced" : "standard", revision = 0;
  let starting = false, debugging = false, inspections = 0, holds = 0, releases = 0;
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false, send: () => {} });
  const event = { sender, senderFrame: sender.mainFrame };
  const service = createInspectionService({ operations, capturePolicy: () => ({ mode, revision }),
    debugStarting: () => starting, debugSession: () => debugging ? { state: { active: true } as any, settled: async () => {} } : null,
    stopSharing: () => {}, inspect: async () => { inspections++; return fixture(source); }, measureLayerImages: async () => {}, yieldPreview: () => undefined,
    withPreviewHeld: async (_owner, action) => { holds++; try { return await action(); } finally { releases++; } },
    captureQmlGroupImage: async () => null,
    captureViewGroupImage: async () => { const result = deferred<QmlGroupImage | null>(); groups.push(result); return result.promise; },
    captureListViewItems: async () => ({ nodes: [], failures: [] }),
    captureViewNodes: async () => { const result = deferred<ViewRefreshResult>(); refreshes.push(result); return result.promise; },
    captureViewStyle: async () => { const result = deferred<ViewStyleResult>(); styles.push(result); return result.promise; },
    captureViewLayerImages: async (_serial, _snapshot, _ids, signal) => { const result = deferred<LayerImageCaptureResult>(); layers.push({ signal, result }); return result.promise; },
    captureViewFont: async (_serial, snapshot, nodeId, signal, captureMode) => {
      const result = deferred<ViewFontResult>(); calls.push({ nodeId, source: snapshot, signal, mode: captureMode, result }); return result.promise;
    },
    setTimeout: ((callback: () => void, ms: number) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout,
  });
  const handlers = createCaptureHandlers(service, () => sender);
  return { operations, calls, layers, refreshes, groups, styles, timers, service, handlers, event,
    get inspections() { return inspections; }, get holds() { return holds; }, get releases() { return releases; },
    setPolicy(next: typeof mode) { mode = next; revision++; }, setStarting(value: boolean) { starting = value; }, setDebugging(value: boolean) { debugging = value; },
    inspect: (id = "request") => handlers["inspect-device"](event, "device", id),
    read: (id = "request", node = "0/0") => handlers["read-view-font"](event, id, node),
    cancel: (id: unknown = "request") => handlers["cancel-view-font"](event, id),
  };
}

test("live standard and hybrid font reads use the JDWP route with preview held", async () => {
  for (const source of ["debug-view", "debug-hybrid"] as const) {
    const h = harness(source); await h.inspect(); const read = h.read(); await turn();
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].mode, "standard");
    assert.equal(h.calls[0].source.inspectionSource, source); assert.equal(h.service.hasActivity(), true);
    assert.equal(h.service.hasFontReads(), true); assert.equal(h.holds, 1); assert.equal(h.releases, 0);
    h.calls[0].result.resolve(font); assert.deepEqual(await read, font);
    assert.equal(h.service.hasActivity(), false); assert.equal(h.service.hasFontReads(), false);
    assert.equal(h.releases, 1); assert.equal(h.timers.size, 0);
  }
});

test("font IPC validates main owner, frame, request IDs and fixed node paths", async () => {
  const h = harness(); await h.inspect();
  for (const event of [{ ...h.event, senderFrame: {} }, { ...h.event, sender: { ...h.event.sender, id: 2 } }]) {
    await assert.rejects(h.handlers["read-view-font"](event, "request", "0/0"), /来源/);
    await assert.rejects(h.handlers["cancel-view-font"](event, "request"), /来源/);
  }
  for (const id of ["", null, 3, "x".repeat(129)]) {
    await assert.rejects(h.handlers["read-view-font"](h.event, id, "0/0")); await assert.rejects(h.cancel(id));
  }
  for (const node of ["0/0.getTypeface()", "../0", "0/-1", "0/0;exit", "0/".repeat(400), {}])
    await assert.rejects(h.handlers["read-view-font"](h.event, "request", node));
  await assert.rejects(h.read("old"), /失效/); await assert.rejects(h.read("request", "0/9"), /变化/);
  await assert.rejects(h.service.readFont(2, "request", "0/0"), /失效/);
  assert.equal(h.calls.length, 0);
  const qml = harness("debug-qml"); await qml.inspect(); await assert.rejects(qml.read(), /失效/); assert.equal(qml.calls.length, 0);
});

test("font cancel waits for debugger release and preserves the live session", async () => {
  const h = harness(); await h.inspect(); const read = h.read(); const rejected = assert.rejects(read); await turn();
  await h.cancel("other"); assert.equal(h.calls[0].signal?.aborted, false);
  let canceled = false; const cancel = h.cancel().then(() => { canceled = true; }); await turn();
  assert.equal(h.calls[0].signal?.aborted, true); assert.equal(canceled, false); assert.equal(h.service.hasActivity(), true);
  h.calls[0].result.resolve(font); await rejected; await cancel;
  assert.equal(canceled, true); assert.equal(h.service.hasSession(1), true); assert.equal(h.service.hasActivity(), false);
});

test("replacement font reads are serialized until canceled work releases", async () => {
  const h = harness(); await h.inspect(); const old = h.read(); const rejected = assert.rejects(old); await turn();
  const next = h.read(); await turn(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].signal?.aborted, true);
  h.calls[0].result.resolve(font); await rejected; await turn(); assert.equal(h.calls.length, 2);
  assert.equal(h.service.hasFontReads(), true); h.calls[1].result.resolve(font); await next;
  assert.equal(h.service.hasActivity(), false);
});

test("manual capture cancels and drains font reads before replacing the session", async () => {
  const h = harness(); await h.inspect(); const old = h.read(); const rejected = assert.rejects(old); await turn();
  await assert.rejects(h.handlers["inspect-device"](h.event, "device", "diagnostic", null, true, { expectedPackage: "example.app" }), /只读诊断/);
  const next = h.inspect("next"); await turn(); assert.equal(h.inspections, 1); assert.equal(h.calls[0].signal?.aborted, true);
  h.calls[0].result.resolve(font); await rejected; await next; assert.equal(h.inspections, 2);
  await assert.rejects(h.read(), /失效/); assert.equal(h.service.hasActivity(), false);
});

test("layer capture and font reads transfer ownership only after cleanup", async () => {
  const h = harness(); await h.inspect();
  const layers = h.service.captureLayers(1, "request", ["0/0"]); const layersRejected = assert.rejects(layers); await turn();
  const read = h.read(); await turn(); assert.equal(h.layers[0].signal?.aborted, true); assert.equal(h.calls.length, 0);
  h.layers[0].result.resolve({ updates: [], failures: [] }); await layersRejected; await turn(); assert.equal(h.calls.length, 1);
  const readRejected = assert.rejects(read); const next = h.service.captureLayers(1, "request", ["0/0"]); await turn();
  assert.equal(h.calls[0].signal?.aborted, true); assert.equal(h.layers.length, 1);
  h.calls[0].result.resolve(font); await readRejected; await turn(); assert.equal(h.layers.length, 2);
  h.layers[1].result.resolve({ updates: [], failures: [] }); await next;
  assert.equal(h.service.hasActivity(), false);
});

test("node refresh drains a font read before starting a new tree operation", async () => {
  const h = harness(); await h.inspect(); const read = h.read(); const rejected = assert.rejects(read); await turn();
  const refresh = h.service.refreshView(1, "request", "0/0", "node"); await turn();
  assert.equal(h.calls[0].signal?.aborted, true); assert.equal(h.refreshes.length, 0);
  h.calls[0].result.resolve(font); await rejected; await turn(); assert.equal(h.refreshes.length, 1);
  h.refreshes[0].resolve({ nodes: [h.calls[0].source.root!.children[0]], failures: [] }); await refresh;
  assert.equal(h.service.hasActivity(), false);
});

test("group and style reads do not overlap font reads in either direction", async () => {
  const h = harness("debug-hybrid"); await h.inspect();
  const group = h.service.captureGroup(1, "request", "0/0"); await turn(); await assert.rejects(h.read(), /正在读取/);
  h.groups[0].resolve(null); await group;
  const style = h.service.readStyle(1, "request", "0/0"); await turn(); await assert.rejects(h.read(), /正在读取/);
  h.styles[0].resolve({ ref: font.ref, capturedAtMillis: 123, backgroundType: null, backgroundColor: null, textColor: null, textSizePx: null }); await style;
  const read = h.read(); await turn(); assert.equal(await h.service.captureGroup(1, "request", "0/0"), null);
  await assert.rejects(h.service.readStyle(1, "request", "0/0"), /正在刷新/);
  assert.equal(h.groups.length, 1); assert.equal(h.styles.length, 1);
  h.calls[0].result.resolve(font); await read;
});

test("font timeout cancels work but stays busy until cleanup settles", async () => {
  const h = harness(); await h.inspect(); const read = h.read(); const rejected = assert.rejects(read, /字体读取超时/); await turn();
  assert.equal(h.timers.size, 1); const timer = [...h.timers.values()][0]; assert.equal(timer.ms, 25_000); timer.callback();
  assert.equal(h.calls[0].signal?.aborted, true); assert.equal(h.service.hasActivity(), true);
  h.calls[0].result.resolve(font); await rejected; assert.equal(h.service.hasActivity(), false); assert.equal(h.timers.size, 0);
});

test("font deadline message survives a transport AbortError", async () => {
  const h = harness(); await h.inspect(); const read = h.read(); const rejected = assert.rejects(read, /字体读取超时/); await turn();
  [...h.timers.values()][0].callback();
  h.calls[0].result.reject(new DOMException("The operation was aborted", "AbortError"));
  await rejected; assert.equal(h.service.hasActivity(), false); assert.equal(h.timers.size, 0);
});

test("policy invalidation and window shutdown reject late fonts and wait for cleanup", async () => {
  for (const revoke of ["policy", "owner", "all", "close", "shutdown", "cancel"] as const) {
    const h = harness(); await h.inspect(); const read = h.read(); const rejected = assert.rejects(read); await turn();
    let shutdown: Promise<void> | undefined;
    if (revoke === "policy") h.setPolicy("sdk-enhanced");
    else if (revoke === "owner") h.service.invalidate(1);
    else if (revoke === "all") h.service.invalidateAll();
    else if (revoke === "cancel") h.service.cancel(1, "request");
    else shutdown = revoke === "close" ? h.operations.close(1) : h.operations.dispose();
    if (revoke !== "policy") assert.equal(h.calls[0].signal?.aborted, true, revoke);
    assert.equal(h.service.hasActivity(), true, revoke);
    h.calls[0].result.resolve(font); await rejected; await shutdown; assert.equal(h.service.hasActivity(), false, revoke);
    if (shutdown) await assert.rejects(h.read(), /关闭|退出/);
  }
});

test("font reads refuse automatic debug ownership and main debug-start refuses active fonts", async () => {
  const h = harness(); await h.inspect(); h.setStarting(true); await assert.rejects(h.read(), /正在读取/);
  h.setStarting(false); h.setDebugging(true); await assert.rejects(h.read(), /正在读取/); h.setDebugging(false);
  const read = h.read(); await turn();
  const main = ts.createSourceFile("main.ts", readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let callback = "", startFunction = "";
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(main) === "ipcMain.handle" && node.arguments[0]?.getText(main) === '"debug-start"')
      callback = node.arguments[1].getText(main);
    if (ts.isFunctionDeclaration(node) && node.name?.text === "startDebugSession")
      startFunction = node.getText(main);
    ts.forEachChild(node, visit);
  };
  visit(main); assert.ok(callback); assert.ok(startFunction);
  assert.match(callback, /return startDebugSession\(mainWindow/);
  const code = ts.transpileModule(startFunction, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const debugStart = new Function("scope", `with(scope) { ${code} return startDebugSession; }`)({ mainWindow: { webContents: h.event.sender },
    runtime: { operations: h.operations }, debugStarting: false, debugSession: null, inspectionService: h.service });
  await assert.rejects(debugStart({ webContents: h.event.sender }, "device", false), /结束当前采集或调试/);
  assert.equal(h.calls.length, 1); h.calls[0].result.resolve(font); await read;
});
