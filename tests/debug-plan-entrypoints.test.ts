import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createInspectorMcpServer } from "../electron/automation/mcp-server";
import { openLiveBridge } from "../electron/automation/mcp-live";
import { debugPlanDefinition, type DebugPlanRun } from "../shared/debug-plan";

const definition = () => ({ version: 1, title: "页面检查", startConditions: [{ selector: { text: "Ready" }, state: "visible" }],
  finalConditions: [{ selector: { text: "Ready" }, state: "visible" }], steps: [{ id: "ready", kind: "wait", condition: { selector: { text: "Ready" }, state: "visible" }, timeoutMs: 1000 }] });

function planRun(sessionId: string, runId: string): DebugPlanRun {
  return { sessionId, runId, title: "页面检查", planHash: "a".repeat(64), status: "running", startedAt: new Date().toISOString(), finishedAt: null,
    durationMs: null, currentStepId: "ready", completedSteps: 0, totalSteps: 1,
    steps: [{ id: "ready", kind: "wait", status: "running", requestId: null, productStepIds: [], durationMs: null, message: "等待页面" }],
    checkpointStepIds: [], reportPath: null, ledgerPath: "/fixture/plan.json", message: "计划已开始", stopCode: null };
}

test("MCP plan tools expose bounded schemas, correct annotations and exactly the three fixed live commands", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-plan-mcp-")), path = join(directory, "current.json"), sessionId = randomUUID(), runId = randomUUID();
  const commands: string[] = [], runs = new Map<string, DebugPlanRun>();
  const bridge = await openLiveBridge(path, async command => {
    commands.push(command.name);
    if (command.name === "start_debug_plan") {
      const existing = runs.get(command.input.runId), run = existing ?? planRun(sessionId, command.input.runId);
      runs.set(run.runId, run); return { run, ...(existing ? { replayed: true } : {}) };
    }
    if (command.name === "cancel_debug_plan") { const run = runs.get(command.input.runId); if (run) run.status = "cancelled"; return run ? { run } : { found: false, runId: command.input.runId }; }
    if (command.name === "get_debug_plan") return runs.has(command.input.runId) ? { run: runs.get(command.input.runId) } : { found: false, runId: command.input.runId };
    throw new Error("unexpected command");
  });
  const server = createInspectorMcpServer(path), client = new Client({ name: "plan-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  const call = async (name: string, input: Record<string, unknown>) => await client.callTool({ name, arguments: input }) as CallToolResult;
  try {
    const tools = (await client.listTools()).tools;
    const start = tools.find(tool => tool.name === "start_debug_plan")!, get = tools.find(tool => tool.name === "get_debug_plan")!, cancel = tools.find(tool => tool.name === "cancel_debug_plan")!;
    assert.deepEqual(start.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    assert.equal(get.annotations!.readOnlyHint, true); assert.equal(cancel.annotations!.readOnlyHint, false); assert.equal(cancel.annotations!.idempotentHint, true);
    const started = await call("start_debug_plan", { sessionId, runId, definition: definition() });
    assert.ok(!started.isError); assert.equal((started.structuredContent!.run as DebugPlanRun).runId, runId);
    assert.equal((await call("start_debug_plan", { sessionId, runId, definition: definition() })).structuredContent!.replayed, true);
    assert.equal((await call("get_debug_plan", { sessionId, runId })).structuredContent!.run && commands.at(-1), "get_debug_plan");
    assert.equal(((await call("cancel_debug_plan", { sessionId, runId })).structuredContent!.run as DebugPlanRun).status, "cancelled");
    const count = commands.length;
    assert.equal((await call("start_debug_plan", { sessionId, runId: "invalid", definition: definition() })).isError, true);
    assert.equal((await call("start_debug_plan", { sessionId, runId, definition: { ...definition(), arbitraryShell: "input tap" } })).isError, true);
    assert.equal((await call("get_debug_plan", { sessionId, runId, definition: definition() })).isError, true);
    assert.equal(commands.length, count);
    assert.deepEqual(commands, ["start_debug_plan", "start_debug_plan", "get_debug_plan", "cancel_debug_plan"]);
  } finally { await client.close(); await server.close(); bridge.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("CLI plan commands read bounded UTF8 JSON, return an ACK, query the same ID and never cancel when the client exits", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-plan-cli-")), path = join(directory, "current.json"), entry = join(directory, "cli.cjs");
  const sessionId = randomUUID(), runId = randomUUID(), calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  execFileSync("bun", ["build", resolve("electron/automation/cli.ts"), "--outfile", entry, "--target", "node", "--format", "cjs"], { stdio: "pipe" });
  let run: DebugPlanRun | null = null;
  const bridge = await openLiveBridge(path, async command => {
    calls.push({ name: command.name, input: command.input });
    if (command.name === "start_debug_plan") {
      if (command.input.definition.title === "reject") return { isError: true, message: "fixture rejected" };
      const previous = run; run ??= planRun(sessionId, command.input.runId); return { run, ...(previous ? { replayed: true } : {}) };
    }
    if (command.name === "get_debug_plan") return run && run.runId === command.input.runId ? { run } : { found: false, runId: command.input.runId };
    if (command.name === "cancel_debug_plan") { if (run) run.status = "cancelled"; return { run }; }
    throw new Error("unexpected command");
  });
  const invoke = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(done => execFile("node", [entry, ...args],
    { timeout: 5000, maxBuffer: 1024 * 1024, env: { ...process.env, ANDROID_UI_INSPECTOR_MCP_SNAPSHOT: path } },
    (error, stdout, stderr) => done({ code: error ? typeof error.code === "number" ? error.code : -1 : 0, stdout, stderr })));
  try {
    const plan = join(directory, "plan.json"); writeFileSync(plan, JSON.stringify(definition()));
    const auth = ["--session", sessionId, "--run-id", runId];
    const started = await invoke("plan-start", ...auth, "--plan-file", plan);
    assert.equal(started.code, 0, started.stderr); assert.equal(JSON.parse(started.stdout).run.status, "running");
    assert.equal(calls.length, 1); assert.equal(calls[0].name, "start_debug_plan");
    assert.deepEqual(calls[0].input.definition, debugPlanDefinition.parse(definition()));
    const queried = await invoke("plan-status", ...auth);
    assert.equal(queried.code, 0, queried.stderr); assert.equal(JSON.parse(queried.stdout).run.runId, runId);
    assert.equal(calls.filter(item => item.name === "cancel_debug_plan").length, 0);
    assert.equal(JSON.parse((await invoke("plan-start", ...auth, "--plan-file", plan)).stdout).replayed, true);
    const absent = await invoke("plan-status", "--session", sessionId, "--run-id", randomUUID());
    assert.equal(JSON.parse(absent.stdout).found, false);
    const beforeInvalid = calls.length;
    for (const bytes of [Buffer.alloc(12001, " "), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]), Buffer.from("{bad json}"),
      Buffer.from(JSON.stringify({ ...definition(), title: "字".repeat(5000) })), Buffer.from(JSON.stringify({ ...definition(), steps: [] }))]) {
      writeFileSync(plan, bytes); const failed = await invoke("plan-start", ...auth, "--plan-file", plan);
      assert.equal(failed.code, 1); assert.equal(failed.stdout, "");
    }
    writeFileSync(plan, JSON.stringify(definition()));
    const linked = join(directory, "linked.json"); symlinkSync(plan, linked);
    const folder = join(directory, "folder"); mkdirSync(folder);
    for (const file of [linked, folder]) assert.equal((await invoke("plan-start", ...auth, "--plan-file", file)).code, 1);
    for (const args of [["plan-start", ...auth], ["plan-status", ...auth, "--plan-file", plan], ["plan-cancel", ...auth, "--run-id", runId]])
      assert.equal((await invoke(...args)).code, 1);
    assert.equal(calls.length, beforeInvalid);
    writeFileSync(plan, JSON.stringify({ ...definition(), title: "reject" }));
    const rejected = await invoke("plan-start", ...auth, "--plan-file", plan);
    assert.equal(rejected.code, 1); assert.equal(JSON.parse(rejected.stderr).runId, runId); assert.match(JSON.parse(rejected.stderr).recoveryHint, /plan-status/);
    const cancelled = await invoke("plan-cancel", ...auth);
    assert.equal(cancelled.code, 0, cancelled.stderr); assert.equal(JSON.parse(cancelled.stdout).run.status, "cancelled");
    assert.ok(readFileSync(entry).length > 0);
  } finally { bridge.close(); rmSync(directory, { recursive: true, force: true }); }
});
