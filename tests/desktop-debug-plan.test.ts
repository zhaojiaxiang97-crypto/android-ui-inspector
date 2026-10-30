import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { debugCommand } from "../shared/debug-protocol";
import type { DebugPlanRun } from "../shared/debug-plan";
import type { DebugSessionState } from "../shared/types";
import { DebugPlanRunner, parseDebugPlanDraft } from "../src/features/automation/DebugPlanRunner";

const source = ts.createSourceFile("main.ts", readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function find(predicate: (node: ts.Node) => boolean, tree: ts.SourceFile = source) {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); };
  visit(tree); assert.ok(found); return found;
}
function evaluate(expression: string, scope: Record<string, any>) {
  const code = ts.transpileModule(`const callback = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("scope", `with(scope) { ${code} return callback; }`)(scope);
}
const definition = () => ({ version: 1, title: "安全检查", startConditions: [{ selector: { text: "Ready" }, state: "visible" }],
  finalConditions: [{ selector: { text: "Ready" }, state: "visible" }], steps: [{ id: "ready", kind: "wait", condition: { selector: { text: "Ready" }, state: "visible" } }] });
function harness() {
  const id = randomUUID(), runId = randomUUID(), sender = { id: 1, mainFrame: {} }, event = { sender, senderFrame: sender.mainFrame };
  const requests: string[] = [], session = { state: { id, active: true }, hasPendingWork: false, request: async (command: any) => {
    requests.push(command.name);
    if (command.name === "get_debug_plan") return scope.existing ? { run: scope.existing } : { found: false, runId };
    if (scope.failure) return { isError: true, message: "引擎拒绝" };
    return { run: { runId, status: command.name === "cancel_debug_plan" ? "cancelled" : "running" } };
  } };
  const scope: Record<string, any> = { debugCommand, debugSession: session, debugStarting: false, connectionDiagnoses: new Map(),
    inspectionService: { hasActivity: () => scope.inspecting }, inspecting: false, previewCalls: 0,
    requireDesktopSender: (value: any) => { if (value.sender !== sender || value.senderFrame !== sender.mainFrame) throw new Error("无效来源"); },
    withPreviewHeld: async (_owner: number, action: () => Promise<unknown>) => { scope.previewCalls++; return action(); } };
  const call = find(node => ts.isCallExpression(node) && node.expression.getText(source) === "ipcMain.handle"
    && node.arguments[0]?.getText(source) === '"debug-plan-command"') as ts.CallExpression;
  const handler = evaluate(call.arguments[1].getText(source), scope);
  return { scope, session, requests, event, id, runId, handler };
}

test("desktop plan IPC permits only owned fixed commands and rejects bad definitions before any session request", async () => {
  const h = harness(), input = { name: "start_debug_plan", input: { sessionId: h.id, runId: h.runId, definition: definition() } };
  await assert.rejects(h.handler({ ...h.event, senderFrame: {} }, input), /来源/);
  await assert.rejects(h.handler({ ...h.event, sender: {} }, input), /来源/);
  for (const command of [null, { name: "perform_ui_step", input: {} }, { name: "start_debug_plan", input: { ...input.input, runId: "invalid" } },
    { ...input, shell: "anything" }, { ...input, input: { ...input.input, definition: { ...definition(), steps: [] } } }])
    await assert.rejects(h.handler(h.event, command));
  await assert.rejects(h.handler(h.event, { ...input, input: { ...input.input, sessionId: randomUUID() } }), /会话/);
  assert.equal(h.requests.length, 0);
  assert.equal((await h.handler(h.event, input)).run.status, "running");
  assert.deepEqual(h.requests, ["get_debug_plan", "start_debug_plan"]); assert.equal(h.scope.previewCalls, 1);
});

test("desktop plan queries, cancellation and exact-ID replay remain available while new execution is blocked", async () => {
  const h = harness(), identity = { sessionId: h.id, runId: h.runId }, start = { name: "start_debug_plan", input: { ...identity, definition: definition() } };
  h.scope.inspecting = true;
  await assert.rejects(h.handler(h.event, start), /等待/);
  assert.equal((await h.handler(h.event, { name: "get_debug_plan", input: identity })).found, false);
  assert.equal((await h.handler(h.event, { name: "cancel_debug_plan", input: identity })).run.status, "cancelled");
  assert.equal(h.session.state.active, true);
  h.scope.existing = { runId: h.runId }; h.session.hasPendingWork = true; h.session.state.active = false;
  assert.equal((await h.handler(h.event, start)).run.status, "running"); assert.equal(h.scope.previewCalls, 0);
  h.scope.existing = null;
  await assert.rejects(h.handler(h.event, start), /会话已结束/);
  assert.equal((await h.handler(h.event, { name: "get_debug_plan", input: identity })).found, false);
  h.scope.failure = true;
  await assert.rejects(h.handler(h.event, { name: "cancel_debug_plan", input: identity }), /引擎拒绝/);
});

test("desktop preview cannot capture between plan steps or during input cleanup", () => {
  const property = find(node => ts.isPropertyAssignment(node) && node.name.getText(source) === "isBusy"
    && ts.isArrowFunction(node.initializer) && node.initializer.getText(source).includes("previewHolds")) as ts.PropertyAssignment;
  const scope: Record<string, any> = { inspectionService: { hasActivity: () => false }, connectionDiagnoses: new Map(), previewHolds: new Map(),
    debugStarting: false, debugSession: { hasPendingWork: false, state: { plan: { status: "running" } } } };
  const busy = evaluate(property.initializer.getText(source), scope);
  assert.equal(busy(), true);
  scope.debugSession.state.plan.status = "cancelled"; scope.debugSession.hasPendingWork = true; assert.equal(busy(), true);
  scope.debugSession.hasPendingWork = false; assert.equal(busy(), false);
});

test("plan draft validation rejects oversized UTF8, invalid JSON, missing expectations and unknown execution fields", () => {
  assert.ok(parseDebugPlanDraft(JSON.stringify(definition())).definition);
  for (const value of ["", "{broken", "字".repeat(5000), JSON.stringify({ ...definition(), arbitraryShell: "cmd" }),
    JSON.stringify({ ...definition(), steps: [{ id: "tap", kind: "step", input: { action: { kind: "tap" }, target: { selector: { text: "Ready" } } } }] })])
    assert.ok(parseDebugPlanDraft(value).error);
});

test("plan UI preserves the original submission after a lost ACK and not-found query, and retries the same ID and definition", async () => {
  const ui = ts.createSourceFile("DebugPlanRunner.tsx", readFileSync(new URL("../src/features/automation/DebugPlanRunner.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const initializer = (name: string) => (find(node => ts.isVariableDeclaration(node) && node.name.getText(ui) === name, ui) as ts.VariableDeclaration).initializer!.getText(ui);
  const id = randomUUID(), runId = randomUUID(), canonical = parseDebugPlanDraft(JSON.stringify(definition())).definition!;
  const commands: any[] = [], targets: any[] = [], messages: any[] = [];
  let generatedIds = 0, pending: Promise<void> | undefined;
  const scope: Record<string, any> = { target: null, state: { id, active: true, busy: false }, disabled: false, running: false, unresolved: false,
    checked: true, parsed: { definition: canonical }, run: null, busyRef: { current: false }, revision: { current: 0 }, sessionId: { current: id },
    crypto: { randomUUID: () => { generatedIds++; return runId; } }, setBusy: () => {}, setLocalRun: () => {},
    setTarget: (value: any) => { targets.push(value); scope.target = value; }, setMessage: (value: any) => messages.push(value),
    command: async (value: any) => {
      commands.push(value);
      if (value.name === "get_debug_plan") return { found: false, runId };
      if (commands.length === 1) throw new Error("ACK丢失，桌面仍可能接受原提交");
      return { run: { sessionId: id, runId, status: "running" } };
    } };
  const request = evaluate(initializer("request"), scope);
  scope.request = (...args: any[]) => (pending = request(...args));
  const start = evaluate(initializer("start"), scope), retry = evaluate(initializer("retry"), scope);
  start(); await pending;
  const submitted = scope.target;
  assert.equal(generatedIds, 1); assert.deepEqual(submitted, { sessionId: id, runId, definition: canonical });
  scope.unresolved = new Function("scope", `with(scope) { return ${initializer("unresolved")}; }`)(scope);
  assert.equal(scope.unresolved, true);
  const identity = new Function("scope", `with(scope) { return ${initializer("identity")}; }`)(scope);
  assert.deepEqual(identity, { sessionId: id, runId });
  await scope.request({ name: "get_debug_plan", input: identity }, "查询失败");
  assert.strictEqual(scope.target, submitted); assert.equal(targets.length, 1);
  assert.match(messages.at(-1), /原提交可能仍在等待/);
  scope.parsed = { definition: { ...canonical, title: "编辑器中的另一份计划" } };
  start(); assert.equal(generatedIds, 1); assert.equal(commands.length, 2);
  retry(); await pending;
  assert.deepEqual(commands[2], commands[0]); assert.strictEqual(commands[2].input.definition, canonical);
  assert.equal(generatedIds, 1); assert.equal(targets.length, 1);
  scope.state.active = false; retry(); assert.equal(commands.length, 3);
});

test("plan UI renders separate grant, current step, cancellation and pending result without inventing success", () => {
  const state: DebugSessionState = { id: randomUUID(), active: false, busy: false, serial: "fixture", packageName: "com.example.plan",
    expiresAt: new Date().toISOString(), steps: [], evidencePath: null, stopReason: null };
  const command = async () => ({ found: false as const, runId: randomUUID() });
  const idle = renderToStaticMarkup(createElement(DebugPlanRunner, { state, command }));
  assert.match(idle, /先开启自动调试/); assert.match(idle, /disabled="">运行计划/);
  assert.equal(renderToStaticMarkup(createElement(DebugPlanRunner, { state })), "");
  state.active = true; state.busy = true;
  state.plan = { sessionId: state.id, runId: randomUUID(), title: "<script>plan</script>", planHash: "a".repeat(64), status: "running",
    startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, currentStepId: "open", completedSteps: 0, totalSteps: 1,
    steps: [{ id: "open", kind: "wait", status: "pending", requestId: null, productStepIds: [], durationMs: null, message: "等待检查" }],
    checkpointStepIds: [], reportPath: null, ledgerPath: "/fixture/plan.json", message: "运行中", stopCode: null } satisfies DebugPlanRun;
  const running = renderToStaticMarkup(createElement(DebugPlanRunner, { state, command, disabled: true }));
  for (const value of ["正在执行", "当前步骤 open", "待执行", "取消计划", "查询状态"]) assert.ok(running.includes(value));
  assert.ok(!running.includes("<script>")); assert.match(running, /&lt;script&gt;/);
  assert.match(running, /class="close-button">取消计划/);
  state.plan.status = "failed"; state.plan.message = "最终条件缺少完整证据";
  const failed = renderToStaticMarkup(createElement(DebugPlanRunner, { state, command }));
  assert.match(failed, /未通过/); assert.match(failed, /最终条件缺少完整证据/); assert.ok(!failed.includes(">取消计划<"));
});
