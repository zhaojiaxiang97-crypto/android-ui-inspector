import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { debugCommand, debugToolSchemas, getUiStepInput, performUiStepInput, resumeUiStepInput, type DebugCommand } from "../shared/debug-protocol";
import { createInspectorMcpServer } from "../electron/automation/mcp-server";
import { openLiveBridge } from "../electron/automation/mcp-live";

const sessionId = randomUUID(), requestId = randomUUID(), snapshotId = randomUUID();
const base = { sessionId, requestId, target: { selector: { text: "我" } }, action: { kind: "tap" } };
function directory() {
  const parent = resolve(".benchmarks");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "ui-step-interfaces-"));
}

test("composite step schema fixes defaults and rejects ambiguous or unauthorized input shapes", () => {
  const parsed = performUiStepInput.parse({ ...base, expect: { selector: { text: "收藏" } } });
  assert.equal(parsed.target!.target, "self");
  assert.equal(parsed.expect!.state, "visible");
  assert.equal(parsed.timeoutMs, 45_000);
  assert.equal(parsed.requestId, requestId);
  assert.deepEqual(performUiStepInput.parse({ ...base, action: { kind: "scroll", direction: "down" } }).action,
    { kind: "scroll", direction: "down", distance: 0.6, durationMs: 350 });
  assert.deepEqual(performUiStepInput.parse({ ...base, visualConfirmation: { snapshotId, description: "  截图中我的入口可见  " } }).visualConfirmation,
    { snapshotId, description: "截图中我的入口可见" });
  assert.equal(performUiStepInput.parse({ ...base, target: { selector: { text: " 我 " }, within: { resourceId: "app:id/footer" }, clickable: false, scrollable: false } }).target!.selector.text, " 我 ");
  for (const input of [
    { ...base, sessionId: "bad" }, { ...base, requestId: "bad" }, { ...base, target: undefined },
    { ...base, target: { selector: {} } }, { ...base, target: { selector: { text: "我", regex: ".*" } } },
    { ...base, target: { selector: { text: "我" }, within: {} } },
    { ...base, target: { selector: { text: "我" }, clickable: "true" } },
    { ...base, target: { selector: { text: "我" }, uniqueMatch: 1 } }, { ...base, uniqueMatch: 1 },
    { ...base, target: { selector: { text: "我" }, expectedMatchCount: 1 } },
    { ...base, action: { kind: "back" } },
    { sessionId, requestId, action: { kind: "back" }, visualConfirmation: { snapshotId, description: "看过" } },
    { ...base, action: { kind: "tap", x: 1 } },
    { ...base, action: { kind: "scroll", direction: "down" }, target: { selector: { text: "我" }, target: "clickable-parent" } },
    { ...base, action: { kind: "scroll", direction: "down", distance: 0.09 } },
    { ...base, action: { kind: "scroll", direction: "down", durationMs: 1001 } },
    { ...base, action: { kind: "scroll", direction: "diagonal" } },
    { ...base, timeoutMs: 999 }, { ...base, timeoutMs: 60_001 }, { ...base, timeoutMs: "1000" },
    { ...base, expect: { selector: { text: "收藏" }, state: "selected" } },
    { ...base, expect: { selector: { text: "收藏" }, code: "return true" } },
    { ...base, visualConfirmation: { snapshotId: "bad", description: "看过" } },
    { ...base, visualConfirmation: { snapshotId, description: "  " } },
    { ...base, visualConfirmation: { snapshotId, description: "字".repeat(513) } },
    { ...base, visualConfirmation: { snapshotId, description: "看过", force: true } },
  ]) assert.equal(performUiStepInput.safeParse(input).success, false, JSON.stringify(input));
  for (const timeoutMs of [1000, 60_000]) assert.equal(performUiStepInput.parse({ ...base, timeoutMs }).timeoutMs, timeoutMs);
  for (const direction of ["up", "down", "left", "right"])
    assert.equal(performUiStepInput.safeParse({ ...base, action: { kind: "scroll", direction, distance: 0.8, durationMs: 150 } }).success, true);
  assert.equal(performUiStepInput.safeParse({ sessionId, requestId, action: { kind: "back" } }).success, true);
  assert.equal(performUiStepInput.safeParse({ ...base, target: { ...base.target, target: "clickable-parent" } }).success, true);
});

test("query and resume carry only the original request identity and old interfaces stay compatible", () => {
  assert.deepEqual(getUiStepInput.parse({ sessionId, requestId }), { sessionId, requestId });
  assert.deepEqual(resumeUiStepInput.parse({ sessionId, requestId }), { sessionId, requestId, timeoutMs: 30_000 });
  for (const schema of [getUiStepInput, resumeUiStepInput]) {
    assert.equal(schema.safeParse({ sessionId, requestId, action: { kind: "tap" } }).success, false);
    assert.equal(schema.safeParse({ sessionId, requestId, target: base.target }).success, false);
  }
  for (const timeoutMs of [999, 60_001]) assert.equal(resumeUiStepInput.safeParse({ sessionId, requestId, timeoutMs }).success, false);
  for (const [name, input] of [["perform_ui_step", base], ["get_ui_step", { sessionId, requestId }], ["resume_ui_step", { sessionId, requestId }]] as const)
    assert.equal(debugCommand.parse({ name, input }).name, name);
  assert.deepEqual(debugToolSchemas.tap_node.parse({ sessionId, snapshotId, nodeId: "0/1", visualConfirmation: { description: "可见" } }),
    { sessionId, snapshotId, nodeId: "0/1", visualConfirmation: { description: "可见" } });
  assert.deepEqual(debugToolSchemas.press_back.parse({ sessionId, snapshotId }), { sessionId, snapshotId });
});

test("MCP registers the shared schemas, forwards normalized requests and never attaches a stale image", async () => {
  const dir = directory(), path = join(dir, "current.json"), seen: DebugCommand[] = [];
  const bridge = await openLiveBridge(path, async command => {
    seen.push(command);
    return { requestId, status: "observing", dispatchState: "sent", snapshotId, verified: false };
  });
  const server = createInspectorMcpServer(path), client = new Client({ name: "ui-step-interface-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const call = async (name: string, input: Record<string, unknown>) => await client.callTool({ name, arguments: input }) as CallToolResult;
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ["perform_ui_step", "get_ui_step", "resume_ui_step"]) {
      const tool = tools.find(item => item.name === name)!;
      assert.ok(tool);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.annotations?.readOnlyHint, name !== "perform_ui_step");
      assert.equal(tool.annotations?.idempotentHint, true);
    }
    const result = await call("perform_ui_step", base);
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(result.content.every(item => item.type === "text"));
    assert.equal(result.structuredContent!.snapshotId, snapshotId);
    assert.deepEqual(seen[0], debugCommand.parse({ name: "perform_ui_step", input: base }));
    await call("perform_ui_step", base);
    assert.ok(seen[1].name === "perform_ui_step");
    assert.equal(seen[1].input.requestId, requestId);
    await call("get_ui_step", { sessionId, requestId });
    await call("resume_ui_step", { sessionId, requestId });
    assert.deepEqual(seen.map(command => command.name), ["perform_ui_step", "perform_ui_step", "get_ui_step", "resume_ui_step"]);
    assert.deepEqual(seen[3].input, { sessionId, requestId, timeoutMs: 30_000 });
    assert.equal((await call("perform_ui_step", { ...base, action: { kind: "back" } })).isError, true);
    assert.equal((await call("resume_ui_step", { sessionId, requestId, action: { kind: "tap" } })).isError, true);
    assert.equal(seen.length, 4);
  } finally { await client.close(); await server.close(); bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("CLI step flags, JSON input and recovery commands share validation without device operations", { timeout: 30_000 }, async () => {
  const dir = directory(), path = join(dir, "current.json"), entry = join(dir, "android-ui.cjs"), seen: DebugCommand[] = [];
  execFileSync("bun", ["build", resolve("electron/automation/cli.ts"), "--outfile", entry, "--target", "node", "--format", "cjs"], { stdio: "pipe" });
  let fail = false;
  const bridge = await openLiveBridge(path, async command => {
    seen.push(command);
    return fail ? { isError: true, message: "观察失败", requestId, dispatchState: "sent" }
      : { requestId, status: "verified", dispatchState: "sent", verified: true, received: command };
  });
  const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile("node", [entry, ...args, "--snapshot-file", path], { timeout: 10_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? typeof error.code === "number" ? error.code : -1 : 0, stdout, stderr }));
  });
  const okay = async (...args: string[]) => {
    const result = await run(...args); assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const bad = async (...args: string[]) => {
    const before = seen.length, result = await run(...args);
    assert.equal(result.code, 1, result.stdout); assert.equal(result.stdout, ""); assert.equal(seen.length, before);
    return JSON.parse(result.stderr);
  };
  const auth = ["--session", sessionId, "--request-id", requestId];
  try {
    assert.match((await run("--help")).stdout, /resume-step/);
    const tapped = await okay("step", ...auth, "--action", "tap", "--text", "我", "--within-json", '{"resourceId":"app:id/footer"}',
      "--clickable", "true", "--scrollable", "false", "--expect-json", '{"selector":{"text":"收藏"}}');
    assert.deepEqual(tapped.received.input.target, { selector: { text: "我" }, within: { resourceId: "app:id/footer" }, clickable: true, scrollable: false, target: "self" });
    assert.deepEqual(tapped.received.input.expect, { selector: { text: "收藏" }, state: "visible" });
    const scrolled = await okay("step", ...auth, "--action", "scroll", "--resource-id", "app:id/list", "--direction", "down", "--distance", "0.5", "--duration-ms", "500");
    assert.deepEqual(scrolled.received.input.action, { kind: "scroll", direction: "down", distance: 0.5, durationMs: 500 });
    assert.equal((await okay("step", ...auth, "--action", "back")).received.input.target, undefined);
    const visual = await okay("step", ...auth, "--action", "tap", "--desc", "进入", "--target", "clickable-parent",
      "--visual-snapshot-id", snapshotId, "--visual-confirmation", "  入口可见  ", "--timeout-ms", "20000");
    assert.deepEqual(visual.received.input.visualConfirmation, { snapshotId, description: "入口可见" });
    assert.equal(visual.received.input.timeoutMs, 20_000);
    assert.deepEqual((await okay("step", "--input-json", JSON.stringify(base))).received.input, performUiStepInput.parse(base));
    assert.equal((await okay("get-step", ...auth)).received.name, "get_ui_step");
    assert.deepEqual((await okay("resume-step", ...auth, "--timeout-ms", "1000")).received.input, { sessionId, requestId, timeoutMs: 1000 });
    await bad("step", ...auth, "--action", "tap");
    await bad("step", ...auth, "--action", "back", "--text", "我");
    await bad("step", ...auth, "--action", "tap", "--text", "我", "--distance", "0.5");
    await bad("step", ...auth, "--action", "tap", "--text", "我", "--clickable", "yes");
    await bad("step", ...auth, "--action", "tap", "--text", "我", "--within-json", "{");
    await bad("step", ...auth, "--action", "tap", "--text", "我", "--visual-confirmation", "可见");
    await bad("step", ...auth, "--action", "scroll", "--text", "列表", "--direction", "down", "--target", "clickable-parent");
    await bad("step", "--input-json", JSON.stringify(base), "--text", "different");
    await bad("step", "--input-json", "null");
    await bad("step", ...auth, "--request-id", randomUUID(), "--action", "back");
    await bad("get-step", ...auth, "--action", "back");
    await bad("resume-step", ...auth, "--timeout-ms", "999");
    fail = true;
    const failure = await run("step", ...auth, "--action", "back");
    assert.equal(failure.code, 1);
    const error = JSON.parse(failure.stderr);
    assert.equal(error.dispatchState, "sent"); assert.equal(error.requestId, requestId); assert.match(error.recoveryHint, /get-step/);
  } finally { bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});
