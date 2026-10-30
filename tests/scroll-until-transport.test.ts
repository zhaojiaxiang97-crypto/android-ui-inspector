import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { debugCommand } from "../shared/debug-protocol";
import { createInspectorMcpServer } from "../electron/automation/mcp-server";
import { callLiveBridge, openLiveBridge } from "../electron/automation/mcp-live";

function fixture() {
  const parent = resolve(".benchmarks");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "scroll-until-transport-"));
  return { directory, path: join(directory, "current.json"), command: debugCommand.parse({ name: "scroll_until", input: {
    sessionId: randomUUID(), requestId: randomUUID(), target: { selector: { resourceId: "app:id/list" } },
    direction: "down", until: { selector: { text: "end" }, kind: "end_marker" }, timeoutMs: 120000,
  } }) };
}

test("bridge request-body timeout does not cancel a scroll result taking longer than five seconds", { timeout: 10000 }, async () => {
  const setup = fixture();
  let aborted = false;
  const bridge = await openLiveBridge(setup.path, async (command, signal) => {
    assert.deepEqual(command, setup.command);
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    await delay(5500);
    return { requestId: setup.command.input.requestId, verified: false, message: "no phone input" };
  });
  try {
    const result = await callLiveBridge(setup.path, setup.command);
    assert.equal(result.requestId, setup.command.input.requestId);
    assert.equal(aborted, false);
  } finally { bridge.close(); rmSync(setup.directory, { recursive: true, force: true }); }
});

test("MCP client deadline propagates cancellation to an in-flight desktop scroll request", { timeout: 5000 }, async () => {
  const setup = fixture();
  let calls = 0, acknowledge!: () => void;
  const cancelled = new Promise<void>(resolve => { acknowledge = resolve; });
  const bridge = await openLiveBridge(setup.path, async (_command, signal) => {
    calls++;
    await new Promise<void>(resolve => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    acknowledge();
    return { requestId: setup.command.input.requestId, verified: false, dispatchState: "not_sent" };
  });
  const server = createInspectorMcpServer(setup.path), client = new Client({ name: "scroll-deadline-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote); await client.connect(local);
  try {
    await assert.rejects(client.callTool({ name: setup.command.name, arguments: setup.command.input }, undefined, { timeout: 100 }), /timed out/i);
    await Promise.race([cancelled, delay(2000).then(() => { throw new Error("Desktop did not receive caller cancellation"); })]);
    assert.equal(calls, 1);
  } finally { await client.close(); await server.close(); bridge.close(); rmSync(setup.directory, { recursive: true, force: true }); }
});
