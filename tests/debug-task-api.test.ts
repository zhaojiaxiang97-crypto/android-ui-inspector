import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession } from "../electron/automation/debug-session";
import { openLiveBridge } from "../electron/automation/mcp-live";
import { createInspectorMcpServer } from "../electron/automation/mcp-server";
import { loadTestReport } from "../electron/desktop/test-report";
import { debugTaskDefinition, type DebugTaskCheckResult } from "../shared/debug-task";
import { debugCommand } from "../shared/debug-protocol";
import type { UiSnapshot } from "../shared/types";

const packageName = "com.example.taskapi";
const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "taskapi-window", activityRecordId: "taskapi-activity" };
const definition = {
  goal: "从准备状态到达完成状态",
  checkpoints: [{ id: "ready", title: "确认准备状态", conditions: [{ id: "start", selector: { text: "START" }, state: "visible" as const }] }],
  finalConditions: [{ id: "done", selector: { text: "DONE" }, state: "enabled" as const }],
};
async function fixtureImage(width = 100, height = 200, background = "#e5eef5") {
  const bytes = await sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
function fixture(image: string, text: string): UiSnapshot {
  const root = makeNode("0"), label = makeNode("0/0");
  root.package = label.package = packageName;
  root.text = null; root.clickable = root.scrollable = false;
  root.bounds = { left: 0, top: 0, right: 100, bottom: 200, raw: "[0,0][100,200]" };
  label.bounds = { left: 10, top: 20, right: 80, bottom: 60, raw: "[10,20][80,60]" };
  label.resourceId = `${packageName}:id/status`; label.text = text; label.enabled = label.visibleToUser = true;
  root.children = [label];
  const frame = { width: 100, height: 200, rotation: 0 as const };
  return { serial: "taskapi-device", root, nodeCount: 2, rawXml: null, xmlSize: 0, screenshotDataUrl: image,
    error: null, warning: null, inspectionSource: "uiautomator", captureMode: "fast", hierarchyDumpMode: "full",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } };
}
const toolData = (result: CallToolResult) => {
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(result.structuredContent);
  return result.structuredContent!;
};
const taskResult = (value: Record<string, unknown>) => value.taskResult as DebugTaskCheckResult;
function standaloneCli(directory: string, snapshotPath: string) {
  const entry = join(directory, "cli.cjs");
  execFileSync("bun", ["build", resolve("electron/automation/cli.ts"), "--outfile", entry, "--target", "node", "--format", "cjs"], { stdio: "pipe" });
  return (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolveResult => {
    execFile("node", [entry, ...args, "--snapshot-file", snapshotPath], { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => resolveResult({ code: error ? typeof error.code === "number" ? error.code : -1 : 0, stdout, stderr }));
  });
}

test("MCP task flow keeps the original goal, checks stages read-only, and reloads final tree evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-task-api-")), snapshotPath = join(directory, "current.json");
  const image = await fixtureImage(); let text = "START", observations = 0, inputs = 0;
  const session = new DebugSession({ serial: "taskapi-device", packageName, directory, snapshotPath, onEvent: () => {},
    observe: async () => { observations++; return { snapshot: fixture(image, text), target }; },
    input: async () => { inputs++; throw new Error("Read-only task checker attempted input"); } });
  const bridge = await openLiveBridge(snapshotPath, (command, signal) => session.request(command, signal));
  const server = createInspectorMcpServer(snapshotPath), client = new Client({ name: "task-api-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair(); await server.connect(remote); await client.connect(local);
  const call = (name: string, arguments_: Record<string, unknown>) => client.callTool({ name, arguments: arguments_ }) as Promise<CallToolResult>;
  try {
    const tools = (await client.listTools()).tools;
    assert.ok(tools.find(item => item.name === "check_debug_task")?.annotations?.readOnlyHint);
    const created = toolData(await call("define_debug_task", { sessionId: session.state.id, definition }));
    assert.equal(observations, 0); assert.equal(inputs, 0);
    const taskId = created.taskId;
    assert.equal(typeof taskId, "string");
    assert.equal((await call("define_debug_task", { sessionId: session.state.id, definition: { ...definition, goal: "临时改目标" } })).isError, true);
    assert.equal(session.state.task?.definition.goal, definition.goal);
    const premature = taskResult(toolData(await call("check_debug_task", { sessionId: session.state.id, taskId })));
    assert.equal(premature.status, "insufficient_evidence"); assert.equal(observations, 0);
    assert.equal((await call("check_debug_task", { sessionId: session.state.id, taskId: randomUUID() })).isError, true);
    const checkpoint = taskResult(toolData(await call("check_debug_task", { sessionId: session.state.id, taskId, checkpointId: "ready" })));
    assert.equal(checkpoint.status, "passed"); assert.equal(observations, 2);
    assert.notEqual(checkpoint.observations.first?.snapshotId, checkpoint.observations.second?.snapshotId);
    const falseFinal = taskResult(toolData(await call("check_debug_task", { sessionId: session.state.id, taskId })));
    assert.equal(falseFinal.status, "failed"); assert.equal(observations, 4);
    text = "DONE";
    const final = taskResult(toolData(await call("check_debug_task", { sessionId: session.state.id, taskId })));
    assert.equal(final.status, "passed"); assert.equal(observations, 6); assert.equal(inputs, 0);
    session.stop("Offline task API finished"); await session.settled();
    assert.ok(session.state.reportPath);
    const loaded = await loadTestReport(session.state.reportPath!);
    assert.equal(loaded.debug?.task?.definition.goal, definition.goal);
    assert.equal(loaded.debug?.taskAssessment?.final?.status, "passed");
    assert.notEqual(loaded.index.run.status, "passed");
    const proof = loaded.debug?.task?.checks.find(item => item.checkpointId === null)?.observations;
    for (const observation of [proof?.first, proof?.second]) {
      assert.ok(observation);
      assert.ok(loaded.debug?.snapshots.find(item => item.evidence.snapshotId === observation.snapshotId)?.snapshot?.root);
    }
  } finally {
    session.stop(); await session.settled(); bridge.close(); await client.close(); await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("standalone CLI task definition and evaluation preserve exit statuses, bounded files and zero input", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-task-cli-")), snapshotPath = join(directory, "current.json");
  const run = standaloneCli(directory, snapshotPath);
  const image = await fixtureImage(); let text = "START", observations = 0, inputs = 0;
  const session = new DebugSession({ serial: "taskapi-device", packageName, directory, snapshotPath, onEvent: () => {},
    observe: async () => { observations++; return { snapshot: fixture(image, text), target }; },
    input: async () => { inputs++; throw new Error("Read-only task checker attempted input"); } });
  const bridge = await openLiveBridge(snapshotPath, (command, signal) => session.request(command, signal));
  const taskFile = join(directory, "task.json"); writeFileSync(taskFile, JSON.stringify(definition));
  try {
    const oversized = join(directory, "too-big.json"); writeFileSync(oversized, " ".repeat(16385));
    const invalid = await run("task-define", "--session", session.state.id, "--task-file", oversized);
    assert.equal(invalid.code, 1); assert.equal(invalid.stdout, ""); assert.equal(session.state.task ?? null, null);
    const defined = await run("task-define", "--session", session.state.id, "--task-file", taskFile);
    assert.equal(defined.code, 0, defined.stderr); const taskId = JSON.parse(defined.stdout).taskId;
    assert.equal(observations, 0);
    const early = await run("task-check", "--session", session.state.id, "--task-id", taskId);
    assert.equal(early.code, 2); assert.equal(early.stderr, ""); assert.equal(JSON.parse(early.stdout).taskResult.status, "insufficient_evidence");
    const checkpoint = await run("task-check", "--session", session.state.id, "--task-id", taskId, "--checkpoint", "ready");
    assert.equal(checkpoint.code, 0, checkpoint.stderr); assert.equal(JSON.parse(checkpoint.stdout).taskResult.status, "passed");
    const failed = await run("task-check", "--session", session.state.id, "--task-id", taskId);
    assert.equal(failed.code, 2); assert.equal(failed.stderr, ""); assert.equal(JSON.parse(failed.stdout).taskResult.status, "failed");
    text = "DONE";
    const passed = await run("task-check", "--session", session.state.id, "--task-id", taskId);
    assert.equal(passed.code, 0, passed.stderr); assert.equal(JSON.parse(passed.stdout).taskResult.status, "passed");
    assert.equal(observations, 6); assert.equal(inputs, 0);
    const attached = await run("attach"); assert.equal(JSON.parse(attached.stdout).task.definition.goal, definition.goal);
  } finally { session.stop(); await session.settled(); bridge.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("fixed sample dynamic task crosses CLI and MCP with one self tap, six observations and a reloadable stopped report", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-sample-task-api-")), snapshotPath = join(directory, "current.json");
  const run = standaloneCli(directory, snapshotPath), taskFile = resolve("tests/fixtures/sample-dynamic-task.json");
  const fixedTask = debugTaskDefinition.parse(JSON.parse(readFileSync(taskFile, "utf8")));
  const [beforeImage, afterImage] = await Promise.all([fixtureImage(160, 320), fixtureImage(160, 320, "#dcefe3")]);
  const samplePackage = "com.androiduiinspector.sample";
  const sampleTarget = { ...target, packageName: samplePackage, activityName: ".MainActivity", component: `${samplePackage}/.MainActivity` };
  const page = fixture(beforeImage, "RED CHILD"), root = page.root!, red = root.children[0];
  root.package = red.package = samplePackage; root.resourceId = red.resourceId = null;
  root.bounds = { left: 0, top: 0, right: 160, bottom: 320, raw: "[0,0][160,320]" };
  red.className = "android.widget.TextView"; red.clickable = true; red.scrollable = false;
  red.bounds = { left: 20, top: 100, right: 140, bottom: 150, raw: "[20,100][140,150]" };
  const frame = { width: 160, height: 320, rotation: 0 as const };
  page.captureGeometry = { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 };
  let observations = 0, inputs = 0, bridge: Awaited<ReturnType<typeof openLiveBridge>> | null = null;
  const session = new DebugSession({ serial: page.serial, packageName: samplePackage, directory, snapshotPath,
    onEvent: event => { if (!event.state.active) bridge?.close(); },
    observe: async (_serial, _package, mode, _signal, backend) => {
      observations++; assert.equal(mode, "fast"); assert.equal(backend, "uiautomator");
      return { snapshot: structuredClone(page), target: sampleTarget };
    }, input: async (_serial, freshTarget, action, actualFrame) => {
      assert.deepEqual(freshTarget, sampleTarget); assert.deepEqual(actualFrame, frame);
      assert.deepEqual(action, { kind: "tap", x: 80, y: 125 }); assert.equal(red.text, "RED CHILD");
      assert.equal(++inputs, 1, "样例任务只允许一次输入");
      red.text = "UPDATED CHILD";
      const added = makeNode("0/1", 1); added.package = samplePackage; added.resourceId = added.contentDesc = null;
      added.text = "NEW VIEW"; added.className = "android.widget.TextView"; added.clickable = added.scrollable = false;
      added.bounds = { left: 30, top: 200, right: 130, bottom: 235, raw: "[30,200][130,235]" };
      root.children.push(added); page.nodeCount++; page.screenshotDataUrl = afterImage;
    } });
  bridge = await openLiveBridge(snapshotPath, (command, signal) => session.request(command, signal));
  const server = createInspectorMcpServer(snapshotPath), client = new Client({ name: "sample-dynamic-task-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair(); await server.connect(remote); await client.connect(local);
  const call = (name: string, arguments_: Record<string, unknown> = {}) => client.callTool({ name, arguments: arguments_ }) as Promise<CallToolResult>;
  try {
    const defined = await run("task-define", "--session", session.state.id, "--task-file", taskFile);
    assert.equal(defined.code, 0, defined.stderr); const taskId = JSON.parse(defined.stdout).taskId;
    assert.equal(observations, 0); assert.equal(inputs, 0); assert.equal(session.state.task?.definition.goal, fixedTask.goal);
    const ready = taskResult(toolData(await call("check_debug_task", { sessionId: session.state.id, taskId, checkpointId: "ready" })));
    assert.equal(ready.status, "passed"); assert.equal(ready.conditions.length, 3); assert.ok(ready.conditions.every(item => item.status === "passed"));
    assert.equal(observations, 2);
    const snapshotId = ready.observations.second!.snapshotId, nodeId = ready.conditions.find(item => item.conditionId === "ready_red_enabled")!.secondNodeId!;
    const detail = toolData(await call("get_node", { snapshotId, nodeId })), node = detail.node as Record<string, unknown>;
    assert.equal(detail.snapshotId, snapshotId); assert.equal(node.text, "RED CHILD"); assert.equal(node.className, "android.widget.TextView");
    assert.equal(node.package, samplePackage); assert.equal(node.clickable, true); assert.equal(node.visible, true); assert.equal(node.enabled, true);
    assert.equal(observations, 2); assert.equal(inputs, 0);
    const tapped = await run("tap", "--session", session.state.id, "--snapshot", snapshotId, "--node", nodeId, "--target", "self");
    assert.equal(tapped.code, 0, tapped.stderr); const dispatched = JSON.parse(tapped.stdout);
    assert.equal(dispatched.dispatchState, "sent"); assert.equal(dispatched.verified, false); assert.equal(inputs, 1); assert.equal(observations, 4);
    const final = taskResult(toolData(await call("check_debug_task", { sessionId: session.state.id, taskId })));
    assert.equal(final.status, "passed"); assert.equal(final.conditions.length, 3); assert.ok(final.conditions.every(item => item.status === "passed"));
    assert.equal(observations, 6); assert.equal(inputs, 1);
    const stopped = await run("stop", "--session", session.state.id);
    assert.equal(stopped.code, 0, stopped.stderr); assert.equal(JSON.parse(stopped.stdout).stopped, true);
    await session.settled(); assert.equal(session.state.active, false);
    assert.equal(existsSync(snapshotPath), false); assert.equal(existsSync(`${snapshotPath}.live`), false);
    assert.equal((await run("attach")).code, 1);
    assert.equal((await call("get_node", { snapshotId, nodeId })).isError, true);
    assert.equal((await call("check_debug_task", { sessionId: session.state.id, taskId })).isError, true);
    assert.ok(session.state.reportPath); const loaded = await loadTestReport(session.state.reportPath!);
    assert.equal(loaded.debug?.task?.definition.goal, fixedTask.goal); assert.deepEqual(loaded.debug?.task?.definition, fixedTask);
    assert.equal(loaded.debug?.taskAssessment?.final?.status, "passed"); assert.equal(loaded.debug?.taskAssessment?.checks.length, 2);
    for (const value of loaded.debug!.taskAssessment!.checks) {
      assert.equal(value.effective.status, "passed"); assert.equal(value.effective.conditions.length, 3);
      assert.ok(value.effective.conditions.every(item => item.status === "passed"));
    }
    assert.equal(loaded.debug?.session.active, false); assert.equal(loaded.debug?.session.totalSteps, 4);
    assert.deepEqual(loaded.debug?.steps.map(item => item.step.action), ["define_debug_task", "check_debug_task", "tap_node", "check_debug_task"]);
    assert.equal(loaded.debug?.snapshots.length, 6); assert.ok(loaded.debug?.snapshots.every(item => item.snapshot?.root && !item.treeError));
    assert.equal(loaded.debug?.steps[2].step.resolvedInput?.anchorNodeId, nodeId);
    assert.notEqual(loaded.index.run.status, "passed"); assert.equal(observations, 6); assert.equal(inputs, 1);
  } finally {
    session.stop(); await session.settled(); bridge.close(); await client.close(); await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("task protocol bounds UTF-8 wire size and rejects duplicate IDs or undeclared execution features", () => {
  const sessionId = randomUUID();
  const valid = debugCommand.parse({ name: "define_debug_task", input: { sessionId, definition } });
  assert.ok(Buffer.byteLength(JSON.stringify(valid)) < 16384);
  assert.equal(debugTaskDefinition.safeParse({ ...definition, finalConditions: [{ ...definition.finalConditions[0], id: "start" }] }).success, false);
  assert.equal(debugTaskDefinition.safeParse({ ...definition, run: "tap" }).success, false);
  assert.equal(debugTaskDefinition.safeParse({ goal: "large", finalConditions: Array.from({ length: 10 }, (_, id) => ({
    id: `condition${id}`, selector: { text: "字".repeat(512), resourceId: "字".repeat(512) }, state: "visible",
  })) }).success, false);
  assert.equal(debugCommand.safeParse({ name: "check_debug_task", input: { sessionId, taskId: randomUUID(), checkpointId: "final", tap: true } }).success, false);
});
