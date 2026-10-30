import { requireDesktopOwner } from "../electron/desktop/desktop-ipc";
import { createWindowOperationScope, awaitDialogSelection } from "../electron/desktop/window-operation-scope";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession } from "../electron/automation/debug-session";
import { debugToolSchemas } from "../shared/debug-protocol";
import { loadTestReport } from "../electron/desktop/test-report";
import { debugTaskSnapshotDiff } from "../src/features/reports/debug-report-view";

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
  const declaration = find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  return evaluate(declaration.getText(source), scope);
}
function harness() {
  const directory = mkdtempSync(join(tmpdir(), "desktop-debug-task-"));
  const serial = "fixture", packageName = "com.example.task", reads: number[] = [], inputs: number[] = [];
  const root = makeNode("0"); root.package = packageName; root.visibleToUser = root.enabled = true; root.attributes = {};
  root.text = "Ready"; root.resourceId = `${packageName}:id/ready`;
  const frame = { width: 100, height: 100, rotation: 0 as const };
  const snapshot = { serial, root, nodeCount: 1, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null,
    inspectionSource: "uiautomator" as const, captureMode: "fast" as const, hierarchyDumpMode: "full" as const,
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 as const } };
  const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "window", activityRecordId: "instance" };
  const session = new DebugSession({ serial, packageName, snapshotPath: join(directory, "current.json"), directory,
    observe: async () => { reads.push(Date.now()); return { snapshot, target }; },
    input: async () => { inputs.push(1); }, onEvent: () => {} });
  const sender = { id: 1, mainFrame: {}, isDestroyed: () => false }, event = { sender, senderFrame: sender.mainFrame };
  const scope: Record<string, any> = { mainWindow: { webContents: sender }, debugSession: session, debugStarting: false,
    debugToolSchemas, inspections: new Map(), groupCaptures: new Map(), viewRefreshes: new Map(), connectionDiagnoses: new Map(),
    previewHolds: new Map(), previews: new Map() };
  scope.runtime = { get quitting() { return scope.quitting; }, operations: createWindowOperationScope() };
  scope.awaitDialogSelection = awaitDialogSelection;
  scope.inspectionService = { hasInspections: () => scope.inspections.size > 0, hasGroupCaptures: () => scope.groupCaptures.size > 0,
    hasViewRefreshes: () => scope.viewRefreshes.size > 0 };
  scope.requireDesktopOwner = requireDesktopOwner;
  scope.requireDesktopSender = mainFunction("requireDesktopSender", scope);
  scope.withPreviewHeld = mainFunction("withPreviewHeld", scope);
  const define = handler("debug-task-define", scope), check = handler("debug-task-check", scope);
  const definition = { goal: "Ready is visible", checkpoints: [], finalConditions: [{ id: "ready", selector: { resourceId: root.resourceId }, state: "visible" }] };
  return { directory, session, sender, event, scope, reads, inputs, snapshot, target, definition, define, check,
    dispose: async () => { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}

test("desktop task define/check use the authorized session and exactly two fresh observations", async () => {
  const h = harness();
  try {
    const defined = await h.define(h.event, { sessionId: h.session.state.id, definition: h.definition });
    assert.equal(defined.isError, undefined); assert.equal(h.reads.length, 0); assert.equal(h.inputs.length, 0);
    const result = await h.check(h.event, { sessionId: h.session.state.id, taskId: defined.taskId });
    assert.equal(result.taskResult.status, "passed"); assert.equal(h.reads.length, 2); assert.equal(h.inputs.length, 0);
    assert.ok(h.reads[1] - h.reads[0] >= 340);
    const loaded = await loadTestReport(h.session.state.reportPath!);
    assert.equal(loaded.debug!.taskAssessment!.final!.status, "passed");
    assert.notEqual(debugTaskSnapshotDiff(loaded.debug!, loaded.debug!.task!.checks[0]).status, "unavailable");
    for (const saved of loaded.debug!.snapshots) {
      assert.equal(saved.snapshot!.root!.attributes?.["debug-observation-component"], h.target.component);
      assert.equal(saved.snapshot!.root!.attributes?.["debug-observation-window-id"], h.target.windowId);
      assert.equal(saved.snapshot!.root!.attributes?.["debug-observation-activity-record-id"], h.target.activityRecordId);
    }
    assert.equal(h.snapshot.root.attributes?.["debug-observation-window-id"], undefined, "accepted evidence must not mutate the supplied observation");
  } finally { await h.dispose(); }
});

test("desktop task IPC rejects other frames, stale grants, extra fields and device work before creating steps", async () => {
  const h = harness();
  try {
    const input = { sessionId: h.session.state.id, definition: h.definition };
    await assert.rejects(h.define({ ...h.event, senderFrame: {} }, input), /来源/);
    await assert.rejects(h.define({ ...h.event, sender: { ...h.sender, id: 2 } }, input), /来源/);
    await assert.rejects(h.define(h.event, { ...input, sessionId: randomUUID() }), /会话/);
    await assert.rejects(h.define(h.event, { ...input, arbitraryCommand: "tap" }));
    for (const map of ["inspections", "groupCaptures", "viewRefreshes", "connectionDiagnoses"]) {
      h.scope[map].set(1, {}); await assert.rejects(h.define(h.event, input), /等待/); h.scope[map].clear();
    }
    h.scope.debugStarting = true; await assert.rejects(h.define(h.event, input), /等待/); h.scope.debugStarting = false;
    h.session.stop(); await assert.rejects(h.define(h.event, input), /会话/);
    assert.equal(h.session.state.steps.length, 0); assert.equal(h.reads.length, 0);
  } finally { await h.dispose(); }
});

test("stopping authorization while a desktop task waits for preview rejects the late request", async () => {
  const h = harness(); let release!: () => void, yielding = false;
  try {
    h.scope.previews.set(1, { yieldForCapture: () => { yielding = true; return new Promise<void>(resolve => { release = resolve; }); } });
    const pending = h.define(h.event, { sessionId: h.session.state.id, definition: h.definition });
    assert.equal(yielding, true); assert.equal(h.scope.previewHolds.get(1), 1);
    h.session.stop(); release(); await assert.rejects(pending, /会话/);
    assert.equal(h.scope.previewHolds.size, 0); assert.equal(h.session.state.task, null); assert.equal(h.reads.length, 0);
  } finally { await h.dispose(); }
});

test("desktop task check rejects a stale task and cannot redefine a fixed task", async () => {
  const h = harness();
  try {
    await h.define(h.event, { sessionId: h.session.state.id, definition: h.definition });
    const again = await h.define(h.event, { sessionId: h.session.state.id, definition: { ...h.definition, goal: "different" } });
    assert.equal(again.isError, true); assert.equal(h.session.state.task!.definition.goal, h.definition.goal);
    const result = await h.check(h.event, { sessionId: h.session.state.id, taskId: randomUUID() });
    assert.equal(result.isError, true); assert.equal(h.reads.length, 0); assert.equal(h.inputs.length, 0);
  } finally { await h.dispose(); }
});
