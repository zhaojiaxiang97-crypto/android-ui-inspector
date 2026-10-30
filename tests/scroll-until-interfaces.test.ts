import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { debugCommand, scrollUntilInput, type DebugCommand } from "../shared/debug-protocol";
import { createInspectorMcpServer } from "../electron/automation/mcp-server";
import { openLiveBridge } from "../electron/automation/mcp-live";

const sessionId = randomUUID(), requestId = randomUUID(), snapshotId = randomUUID();
const base = { sessionId, requestId, target: { selector: { resourceId: "app:id/list" } },
  direction: "down", until: { selector: { text: "没有更多了" }, kind: "end_marker" } };
function directory() {
  const parent = resolve(".benchmarks");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, "scroll-until-interfaces-"));
}

test("bounded scroll schema rejects unsafe extensions and shares its defaults across entry points", () => {
  const parsed = scrollUntilInput.parse(base);
  assert.equal(parsed.backend, "uiautomator");
  assert.equal(scrollUntilInput.parse({ ...base, backend: "accessibility-helper" }).backend, "accessibility-helper");
  assert.equal(scrollUntilInput.safeParse({ ...base, backend: "auto" }).success, false);
  assert.deepEqual({ maxScrolls: parsed.maxScrolls, timeoutMs: parsed.timeoutMs, distance: parsed.distance, durationMs: parsed.durationMs },
    { maxScrolls: 6, timeoutMs: 120_000, distance: 0.6, durationMs: 350 });
  assert.equal(scrollUntilInput.parse({ ...base, until: { selector: { text: "最后一条" } } }).until.kind, "target");
  assert.equal(debugCommand.parse({ name: "scroll_until", input: base }).name, "scroll_until");
  assert.deepEqual(scrollUntilInput.parse({ ...base, target: { ...base.target, within: { resourceId: "app:id/favorites" } },
    loading: { text: "加载中" }, empty: { text: "暂无收藏" },
    visualConfirmation: { snapshotId, description: "  收藏列表可见  " } }).visualConfirmation,
  { snapshotId, description: "收藏列表可见" });
  for (const input of [
    { ...base, requestId: "bad" }, { ...base, target: { selector: {} } }, { ...base, until: undefined },
    { ...base, target: { ...base.target, target: "clickable-parent" } }, { ...base, target: { ...base.target, within: {} } },
    { ...base, until: { selector: { text: "没有更多了" }, kind: "no_progress" } },
    { ...base, until: { selector: { text: "没有更多了" }, state: "absent" } },
    { ...base, loading: {} }, { ...base, empty: { text: "暂无收藏", regex: ".*" } },
    { ...base, direction: "diagonal" }, { ...base, maxScrolls: 0 }, { ...base, maxScrolls: 13 }, { ...base, maxScrolls: 1.5 },
    { ...base, timeoutMs: 999 }, { ...base, timeoutMs: 120_001 },
    { ...base, distance: 0.81 }, { ...base, durationMs: 149 }, { ...base, durationMs: 1001 },
    { ...base, x: 0 }, { ...base, continue: true },
    { ...base, visualConfirmation: { snapshotId, description: "看过", inherit: true } },
  ]) assert.equal(scrollUntilInput.safeParse(input).success, false, JSON.stringify(input));
});

test("MCP bounded scroll forwards defaults and keeps detailed evidence out of the concise text", async () => {
  const dir = directory(), path = join(dir, "current.json"), seen: DebugCommand[] = [];
  const progress = { stopReason: "end_reached", observationIds: [randomUUID(), snapshotId],
    iterations: [{ index: 0, startedAt: new Date().toISOString(), durationMs: 10, dispatchState: "sent", progress: "changed",
      inputEvidence: { stdout: "details stay in structured evidence" } }] };
  let failed = false;
  const bridge = await openLiveBridge(path, async command => {
    seen.push(command);
    return { requestId, requestState: "completed", dispatchState: "sent", snapshotId, verified: !failed, scrollTask: progress,
      ...(failed ? { isError: true, message: "观察失败", recoveryHint: "查询原请求" } : {}) };
  });
  const server = createInspectorMcpServer(path), client = new Client({ name: "scroll-until-interface-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const call = async (name: string, input: Record<string, unknown>) => await client.callTool({ name, arguments: input }) as CallToolResult;
  try {
    const tool = (await client.listTools()).tools.find(item => item.name === "scroll_until")!;
    assert.ok(tool); assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations?.readOnlyHint, false); assert.equal(tool.annotations?.destructiveHint, true);
    assert.equal(tool.annotations?.idempotentHint, true);
    const result = await call("scroll_until", base);
    assert.ok(!result.isError); assert.ok(result.content.every(item => item.type === "text"));
    assert.deepEqual(seen[0], debugCommand.parse({ name: "scroll_until", input: base }));
    assert.deepEqual(result.structuredContent!.scrollTask, progress);
    const brief = JSON.parse(result.content.find(item => item.type === "text")!.text);
    assert.equal(brief.requestId, requestId); assert.equal(brief.stopReason, "end_reached");
    assert.equal(brief.iterationCount, 1); assert.equal(brief.sentCount, 1); assert.equal(brief.observationCount, 2);
    assert.equal(brief.verified, true); assert.ok(!JSON.stringify(brief).includes("details stay"));
    await call("get_ui_step", { sessionId, requestId });
    await call("resume_ui_step", { sessionId, requestId });
    assert.deepEqual(seen.map(command => command.name), ["scroll_until", "get_ui_step", "resume_ui_step"]);
    assert.equal((await call("scroll_until", { ...base, maxScrolls: 13 })).isError, true);
    assert.equal((await call("resume_ui_step", { sessionId, requestId, maxScrolls: 1 })).isError, true);
    assert.equal(seen.length, 3);
    failed = true;
    const failure = await call("scroll_until", base);
    assert.equal(failure.isError, true); assert.equal(failure.structuredContent!.dispatchState, "sent");
    assert.match(failure.content.find(item => item.type === "text")!.text, /观察失败/);
  } finally { await client.close(); await server.close(); bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("CLI bounded scroll normalizes flags, rejects mixed JSON, and preserves uncertain receipts", { timeout: 30_000 }, async () => {
  const dir = directory(), path = join(dir, "current.json"), entry = join(dir, "android-ui.cjs"), seen: DebugCommand[] = [];
  execFileSync("bun", ["build", resolve("electron/automation/cli.ts"), "--outfile", entry, "--target", "node", "--format", "cjs"], { stdio: "pipe" });
  let failure: "sent" | "unknown" | undefined;
  const bridge = await openLiveBridge(path, async command => {
    seen.push(command);
    return failure ? { isError: true, message: "读取中断", requestId, dispatchState: failure }
      : { requestId, verified: false, received: command };
  });
  const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile("node", [entry, ...args, "--snapshot-file", path], { timeout: 10_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? typeof error.code === "number" ? error.code : -1 : 0, stdout, stderr }));
  });
  const okay = async (...args: string[]) => {
    const result = await run(...args); assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const bad = async (...args: string[]) => {
    const count = seen.length, result = await run(...args);
    assert.equal(result.code, 1, result.stdout); assert.equal(result.stdout, ""); assert.equal(seen.length, count);
  };
  const flags = ["scroll-until", "--session", sessionId, "--request-id", requestId, "--resource-id", "app:id/list",
    "--direction", "down", "--until-json", JSON.stringify(base.until)];
  try {
    assert.match((await run("--help")).stdout, /scroll-until/);
    assert.deepEqual((await okay(...flags)).received.input, scrollUntilInput.parse(base));
    assert.equal((await okay(...flags, "--backend", "accessibility-helper")).received.input.backend, "accessibility-helper");
    const semantic = await okay(...flags, "--backend", "accessibility-helper", "--class", "android.widget.ScrollView", "--input-method", "accessibility");
    assert.equal(semantic.received.input.inputMethod, "accessibility");
    await bad(...flags, "--input-method", "accessibility");
    await bad(...flags, "--backend", "auto");
    const detailed = await okay(...flags, "--within-json", '{"text":"收藏"}', "--loading-json", '{"text":"加载中"}', "--empty-json", '{"text":"暂无收藏"}',
      "--max-scrolls", "3", "--timeout-ms", "20000", "--distance", "0.5", "--duration-ms", "400",
      "--visual-snapshot-id", snapshotId, "--visual-confirmation", "  列表可见  ");
    assert.deepEqual(detailed.received.input, scrollUntilInput.parse({ ...base, target: { ...base.target, within: { text: "收藏" } },
      loading: { text: "加载中" }, empty: { text: "暂无收藏" }, maxScrolls: 3, timeoutMs: 20000, distance: 0.5, durationMs: 400,
      visualConfirmation: { snapshotId, description: "列表可见" } }));
    assert.deepEqual((await okay("scroll-until", "--input-json", JSON.stringify(base))).received.input, scrollUntilInput.parse(base));
    for (const args of [["--max-scrolls", "13"], ["--timeout-ms", "120001"], ["--max-scrolls", "NaN"], ["--empty-json", "{"],
      ["--visual-confirmation", "已看"], ["--target", "clickable-parent"], ["--input-json", JSON.stringify(base)]]) await bad(...flags, ...args);
    await bad("scroll-until", "--session", sessionId, "--request-id", requestId, "--direction", "down", "--until-json", JSON.stringify(base.until));
    await bad("scroll-until", "--input-json", JSON.stringify({ ...base, until: undefined }));
    await bad("scroll-until", "--input-json", JSON.stringify(base), "--input-json", JSON.stringify(base));
    for (const state of ["sent", "unknown"] as const) {
      failure = state;
      const failed = await run(...flags), error = JSON.parse(failed.stderr);
      assert.equal(failed.code, 1); assert.equal(error.requestId, requestId); assert.equal(error.dispatchState, state);
      assert.match(error.recoveryHint, /get-step/);
    }
  } finally { bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});
