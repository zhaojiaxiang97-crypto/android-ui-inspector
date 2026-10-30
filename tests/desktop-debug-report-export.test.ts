import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { debugReportExportRequestSchema } from "../shared/debug-report-export";

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
  const sender = { id: 1, mainFrame: {}, isDestroyed: () => false }, event = { sender, senderFrame: sender.mainFrame };
  const sourceRecord = { sourceId: "source-token", filePath: "/controlled/report.json", reportSha256: "a".repeat(64) };
  const request = { requestId: "request-one", sourceId: sourceRecord.sourceId, reportSha256: sourceRecord.reportSha256,
    stepIds: "all" as const, includeTrees: true, includeScreenshots: false, includeLogs: true };
  const calls: any[] = []; let dialogs = 0;
  const scope: Record<string, any> = { mainWindow: { webContents: sender }, quitting: false, debugReportExportRequestSchema,
    reportSources: new Map([[1, sourceRecord]]), reportSourceEpochs: new Map(), reportExports: new Map(), taskLibraryTransfers: new Map(),
    dialog: { showOpenDialog: async () => { dialogs++; return { canceled: false, filePaths: ["/chosen"] }; } },
    app: { getVersion: () => "0.1.0" }, randomUUID: () => "fresh-source",
    loadTestReport: async () => ({ debug: {}, index: { reportSha256: "a".repeat(64) } }), realpath: async (file: string) => file,
    exportDebugReportEvidence: async (...args: any[]) => { calls.push(args); return { canceled: false, directory: "/chosen/new", error: null, stepCount: 1, warnings: [] }; } };
  scope.requireDesktopSender = mainFunction("requireDesktopSender", scope);
  const load = mainFunction("loadDesktopReport", scope), invalidate = mainFunction("invalidateReportWork", scope);
  return { scope, event, sender, sourceRecord, request, calls, dialogs: () => dialogs,
    load, invalidate, exportReport: handler("export-debug-report-evidence", scope), cancel: handler("cancel-debug-report-export", scope) };
}

test("export IPC only passes the bound source and native destination, rejects paths and other owners", async () => {
  const h = harness();
  await assert.rejects(h.exportReport({ ...h.event, senderFrame: {} }, h.request), /来源/);
  await assert.rejects(h.exportReport(h.event, { ...h.request, filePath: "/secret" }));
  for (const altered of [{ sourceId: "wrong" }, { reportSha256: "b".repeat(64) }]) {
    const result = await h.exportReport(h.event, { ...h.request, ...altered }); assert.match(result.error, /来源/);
  }
  assert.equal(h.dialogs(), 0); assert.equal(h.calls.length, 0);
  const result = await h.exportReport(h.event, h.request);
  assert.equal(result.error, null); assert.equal(h.calls.length, 1);
  const [bound, selection, destination, options] = h.calls[0];
  assert.equal(bound, h.sourceRecord); assert.deepEqual(selection, h.request); assert.equal(destination, "/chosen");
  assert.equal(options.appVersion, "0.1.0"); assert.equal(h.scope.reportExports.size, 0);
});

test("canceling directory selection, changing report and navigation cannot create an export", async () => {
  for (const action of ["cancel", "report-change", "navigation"]) {
    const h = harness(), chosen = deferred<any>(); h.scope.dialog.showOpenDialog = () => chosen.promise;
    const pending = h.exportReport(h.event, h.request);
    if (action === "cancel") h.cancel(h.event, h.request.requestId);
    if (action === "report-change") h.scope.reportSources.set(1, { ...h.sourceRecord, sourceId: "new" });
    if (action === "navigation") h.invalidate(1);
    chosen.resolve({ canceled: false, filePaths: ["/chosen"] });
    const result = await pending;
    assert(action === "report-change" ? /报告已更新/.test(result.error) : result.canceled);
    assert.equal(h.calls.length, 0); assert.equal(h.scope.reportExports.size, 0);
  }
  const h = harness(); h.scope.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  assert.equal((await h.exportReport(h.event, h.request)).canceled, true); assert.equal(h.calls.length, 0);
});

test("export request ownership prevents concurrent work and unrelated cancellation", async () => {
  const h = harness(), chosen = deferred<any>(); h.scope.dialog.showOpenDialog = () => chosen.promise;
  const pending = h.exportReport(h.event, h.request);
  const second = await h.exportReport(h.event, { ...h.request, requestId: "second" });
  assert.match(second.error, /已有证据/);
  h.cancel(h.event, "not-this-request"); assert.equal(h.scope.reportExports.get(1).controller.signal.aborted, false);
  assert.throws(() => h.cancel({ ...h.event, senderFrame: {} }, h.request.requestId), /来源/);
  assert.throws(() => h.cancel(h.event, "../bad"), /编号/);
  h.cancel(h.event, h.request.requestId); chosen.resolve({ canceled: false, filePaths: ["/chosen"] });
  assert.equal((await pending).canceled, true); assert.equal(h.calls.length, 0);
});

test("navigation cancels active file writing", async () => {
  const h = harness(); let entered = false, cleanup = false;
  h.scope.exportDebugReportEvidence = async (_source: any, _request: any, _path: any, { signal }: { signal: AbortSignal }) => {
    entered = true;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { cleanup = true; resolve(); }, { once: true }));
    return { canceled: true, directory: null, error: null, stepCount: 0, warnings: [] };
  };
  const pending = h.exportReport(h.event, h.request); await turn(); assert(entered);
  h.invalidate(1); await pending; assert(cleanup); assert.equal(h.scope.reportSources.size, 0);
});

test("app quit waits for an owned export to finish cleanup", async () => {
  const pending = deferred<void>(), controller = new AbortController(); let prevented = 0, quits = 0;
  const scope = { quitting: false, stopMcpSharing: () => {}, closeProviderSessions: () => {}, connectionDiagnoses: new Map(),
    reportExports: new Map([[1, { controller, done: pending.promise }]]), reportSources: new Map([[1, {}]]), taskLibraryTransfers: new Map(),
    previews: new Map(), previewCleanup: new Set(), inspections: new Map(), groupCaptures: new Map(), debugSession: null,
    app: { quit: () => { quits++; } } };
  const call = find(node => ts.isCallExpression(node) && node.expression.getText(source) === "app.on"
    && node.arguments[0]?.getText(source) === '"before-quit"') as ts.CallExpression;
  const beforeQuit = evaluate(call.arguments[1].getText(source), scope);
  beforeQuit({ preventDefault: () => { prevented++; } }); await turn();
  assert.equal(controller.signal.aborted, true); assert.equal(prevented, 1); assert.equal(quits, 0); assert.equal(scope.reportSources.size, 0);
  pending.resolve(); await turn(); assert.equal(quits, 1);
  beforeQuit({ preventDefault: () => { prevented++; } }); assert.equal(prevented, 1);
});

test("delayed report loads cannot recreate a source token after navigation or a new frame", async () => {
  const h = harness(), loaded = deferred<any>(); h.scope.loadTestReport = () => loaded.promise;
  const pending = h.load(h.event, "/controlled/report.json"); h.invalidate(1);
  loaded.resolve({ debug: {}, index: { reportSha256: "a".repeat(64) } }); await assert.rejects(pending, /窗口已更新/);
  assert.equal(h.scope.reportSources.size, 0);
  const fresh = await h.load(h.event, "/controlled/report.json"); assert.equal(fresh.exportSourceId, "fresh-source");
  assert.equal(h.scope.reportSources.get(1).filePath, "/controlled/report.json");
  h.scope.loadTestReport = async () => ({ index: { reportSha256: "a".repeat(64) } });
  const legacy = await h.load(h.event, "/controlled/index.json"); assert.equal(legacy.exportSourceId, undefined);
  assert.equal(h.scope.reportSources.size, 0);
});

test("navigation, closing or quitting during file selection cannot register a late report source", async () => {
  for (const action of ["navigation", "closing", "quitting", "frame", "valid"]) {
    const h = harness(), chosen = deferred<any>(); let reads = 0;
    h.scope.reportImports = new Map();
    h.scope.loadDesktopReport = (...args: any[]) => { reads++; return h.load(...args); };
    h.scope.dialog.showOpenDialog = () => chosen.promise;
    const importReport = handler("import-test-report", h.scope);
    const pending = importReport(h.event);
    assert.equal(h.scope.reportImports.get(1), "selecting");
    if (action === "navigation") h.invalidate(1);
    if (action === "closing") h.sender.isDestroyed = () => true;
    if (action === "quitting") h.scope.quitting = true;
    if (action === "frame") h.sender.mainFrame = {};
    chosen.resolve({ canceled: false, filePaths: ["/controlled/report.json"] });
    const result = await pending;
    assert.equal(reads, action === "valid" ? 1 : 0);
    assert.equal(h.scope.reportImports.size, 0);
    if (action === "valid") assert.equal(result.exportSourceId, "fresh-source");
    else {
      assert.equal(result.exportSourceId, undefined);
      assert.equal(result.report, null);
      if (action === "frame") assert.match(result.error, /来源/);
      else assert.equal(result.canceled, true);
    }
  }
});
