import { requireDesktopOwner } from "../electron/desktop/desktop-ipc";
import { createDesktopRuntime } from "../electron/desktop/create-desktop-runtime";
import { createWindowOperationScope, awaitDialogSelection } from "../electron/desktop/window-operation-scope";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = ts.createSourceFile("main.ts", readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function find(predicate: (node: ts.Node) => boolean) {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); };
  visit(source); assert.ok(found); return found;
}
function evaluate(expression: string, scope: Record<string, any>) {
  const code = ts.transpileModule(`const callback = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("scope", `with(scope) { ${code} return callback; }`)(scope);
}
function handler(name: string, scope: Record<string, any>) {
  const call = find(node => ts.isCallExpression(node) && node.expression.getText(source) === "ipcMain.handle"
    && node.arguments[0]?.getText(source) === JSON.stringify(name)) as ts.CallExpression;
  return evaluate(call.arguments[1].getText(source), scope);
}
function mainFunction(name: string, scope: Record<string, any>) {
  return evaluate(find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source), scope);
}
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
function harness() {
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: (): boolean => false });
  const event = { sender, senderFrame: sender.mainFrame }, calls: Array<{ kind: string; file: string; signal?: AbortSignal }> = [];
  const primary = { sourceId: "primary", filePath: "/primary/report.json", reportSha256: "a".repeat(64) };
  const loaded = { debug: {}, index: { reportSha256: "b".repeat(64) } };
  const scope: Record<string, any> = { mainWindow: { webContents: sender }, quitting: false,
    reportImports: new Map(), reportSources: new Map([[1, primary]]), reportSourceEpochs: new Map(), reportExports: new Map(), taskLibraryTransfers: new Map(),
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["/native/import.json"] }),
      showSaveDialog: async () => ({ canceled: false, filePath: "/native/export.json" }) },
    loadTestReport: async (file: string) => { calls.push({ kind: "comparison", file }); return loaded; },
    debugTaskTemplates: {
      importFile: async (file: string, signal: AbortSignal) => { calls.push({ kind: "import", file, signal }); return { canceled: false, filePath: file, error: null }; },
      exportFile: async (file: string, signal: AbortSignal) => { calls.push({ kind: "export", file, signal }); return { canceled: false, filePath: file, error: null }; },
    } };
  scope.runtime = { get quitting() { return scope.quitting; }, operations: createWindowOperationScope() };
  scope.awaitDialogSelection = awaitDialogSelection;
  scope.requireDesktopOwner = requireDesktopOwner;
  scope.requireDesktopSender = mainFunction("requireDesktopSender", scope);
  scope.transferDebugTaskTemplates = mainFunction("transferDebugTaskTemplates", scope);
  return { scope, sender, event, calls, primary, loaded, invalidate: mainFunction("invalidateReportWork", scope),
    comparison: handler("import-comparison-report", scope), importTemplates: handler("debug-task-templates-import", scope),
    exportTemplates: handler("debug-task-templates-export", scope) };
}

test("comparison IPC validates its sender, reads only the native selection and preserves primary export ownership", async () => {
  const h = harness();
  await assert.rejects(h.comparison({ ...h.event, senderFrame: {} }), /来源/);
  await assert.rejects(h.comparison({ ...h.event, sender: { ...h.sender, id: 2 } }), /来源/);
  const result = await h.comparison(h.event, "/renderer/supplied.json");
  assert.deepEqual(h.calls, [{ kind: "comparison", file: "/native/import.json" }]);
  assert.equal(result.report, h.loaded); assert.equal(result.exportSourceId, undefined);
  assert.equal(h.scope.reportSources.get(1), h.primary); assert.equal(h.scope.reportImports.size, 0);
});

test("comparison cancellation, read errors and busy operations retain the original report source", async () => {
  const h = harness();
  h.scope.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  assert.equal((await h.comparison(h.event)).canceled, true); assert.equal(h.calls.length, 0);
  const controller = new AbortController(); h.scope.reportExports.set(1, { controller });
  assert.match((await h.comparison(h.event)).error, /已有报告/); assert.equal(controller.signal.aborted, false);
  h.scope.reportExports.clear(); h.scope.reportImports.set(1, "loading");
  assert.match((await h.comparison(h.event)).error, /已有报告/); h.scope.reportImports.clear();
  h.scope.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ["/native/import.json"] });
  h.scope.loadTestReport = async () => { throw new Error("Invalid proof"); };
  assert.match((await h.comparison(h.event)).error, /Invalid proof/);
  assert.equal(h.scope.reportSources.get(1), h.primary); assert.equal(h.scope.reportImports.size, 0);
});

test("comparison selection and file reads are invalidated by navigation, destruction, quit or changed frame", async () => {
  for (const phase of ["selecting", "loading"]) for (const action of ["navigation", "destroyed", "quit", "frame"]) {
    const h = harness(), selection = deferred<any>(), loaded = deferred<any>();
    if (phase === "selecting") h.scope.dialog.showOpenDialog = () => selection.promise;
    else h.scope.loadTestReport = () => loaded.promise;
    const pending = h.comparison(h.event); await turn();
    assert.equal(h.scope.reportImports.get(1), phase);
    if (action === "navigation") h.invalidate(1);
    if (action === "destroyed") h.sender.isDestroyed = () => true;
    if (action === "quit") h.scope.quitting = true;
    if (action === "frame") h.sender.mainFrame = {};
    selection.resolve({ canceled: false, filePaths: ["/late.json"] }); loaded.resolve(h.loaded);
    const result = await pending;
    assert.equal(result.report, null); assert.equal(result.exportSourceId, undefined);
    assert(action === "frame" ? /来源/.test(result.error) : result.canceled);
    assert.equal(h.scope.reportImports.size, 0);
    assert.equal(h.scope.reportSources.get(1), action === "navigation" ? undefined : h.primary);
  }
});

test("template transfer IPC accepts native paths only, rejects other frames and serializes a window's dialog", async () => {
  for (const kind of ["import", "export"] as const) {
    const h = harness(), transfer = kind === "import" ? h.importTemplates : h.exportTemplates;
    await assert.rejects(transfer({ ...h.event, senderFrame: {} }), /来源/);
    const result = await transfer(h.event, "/renderer/path.json");
    assert.equal(result.error, null); assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].file, `/native/${kind}.json`); assert.equal(h.calls[0].kind, kind);
    assert.equal(h.calls[0].signal?.aborted, false); assert.equal(h.scope.taskLibraryTransfers.size, 0);
    assert.equal(h.sender.listenerCount("destroyed"), 0);
  }
  const h = harness(), selection = deferred<any>(); h.scope.dialog.showOpenDialog = () => selection.promise;
  const pending = h.importTemplates(h.event);
  assert.match((await h.exportTemplates(h.event)).error, /已有模板/);
  selection.resolve({ canceled: true, filePaths: [] }); assert.equal((await pending).canceled, true);
  assert.equal(h.calls.length, 0); assert.equal(h.scope.taskLibraryTransfers.size, 0);
});

test("late template selections cannot write after navigation, closure, quitting or a new frame", async () => {
  for (const kind of ["import", "export"] as const) for (const action of ["navigation", "destroyed", "quit", "frame", "cancel"]) {
    const h = harness(), selection = deferred<any>();
    h.scope.dialog.showOpenDialog = h.scope.dialog.showSaveDialog = () => selection.promise;
    const pending = (kind === "import" ? h.importTemplates : h.exportTemplates)(h.event);
    if (action === "navigation") h.invalidate(1);
    if (action === "destroyed") { h.sender.isDestroyed = () => true; h.sender.emit("destroyed"); }
    if (action === "quit") h.scope.quitting = true;
    if (action === "frame") h.sender.mainFrame = {};
    selection.resolve({ canceled: action === "cancel", filePaths: ["/late.json"], filePath: "/late.json" });
    const result = await pending; assert(action === "frame" ? /来源/.test(result.error) : result.canceled);
    assert.equal(h.calls.length, 0); assert.equal(h.scope.taskLibraryTransfers.size, 0);
    assert.equal(h.sender.listenerCount("destroyed"), 0);
  }
});

test("navigation aborts template storage work; quit waits for cleanup before exiting", async () => {
  const h = harness(); let entered = false, cleaned = false;
  h.scope.debugTaskTemplates.importFile = async (_file: string, signal: AbortSignal) => {
    entered = true;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { cleaned = true; resolve(); }, { once: true }));
    throw new DOMException("aborted", "AbortError");
  };
  const pending = h.importTemplates(h.event); await turn(); assert(entered); h.invalidate(1);
  assert.equal((await pending).canceled, true); assert(cleaned); assert.equal(h.scope.taskLibraryTransfers.size, 0);
  const cleanup = deferred<void>(), controller = new AbortController(); let prevented = 0, quits = 0;
  const runtime = createDesktopRuntime({ stopSharing: () => {}, closeProviderSessions: async () => {},
    settleDebug: () => undefined, disposePreviews: async () => {}, reportShutdownError: error => { throw error; } });
  runtime.operations.track(1, cleanup.promise, () => controller.abort());
  runtime.beforeQuit({ preventDefault: () => { prevented++; } }, () => { quits++; }); await turn();
  assert(controller.signal.aborted); assert.equal(prevented, 1); assert.equal(quits, 0);
  cleanup.resolve(); await turn(); assert.equal(quits, 1);
});

test("destroying a template window settles an unanswered picker and ignores its later choice", async () => {
  for (const kind of ["import", "export"] as const) {
    const h = harness(), selection = deferred<any>();
    h.scope.dialog.showOpenDialog = h.scope.dialog.showSaveDialog = () => selection.promise;
    const pending = (kind === "import" ? h.importTemplates : h.exportTemplates)(h.event);
    h.sender.emit("destroyed");
    assert.equal((await pending).canceled, true);
    assert.equal(h.scope.taskLibraryTransfers.size, 0); assert.equal(h.sender.listenerCount("destroyed"), 0);
    selection.resolve({ canceled: false, filePaths: ["/late.json"], filePath: "/late.json" }); await turn();
    assert.equal(h.calls.length, 0);
  }
});
