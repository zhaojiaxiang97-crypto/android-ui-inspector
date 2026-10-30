import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { debugToolSchemas, type DebugCommand } from "../shared/debug-protocol";
import { isUiSnapshot } from "../shared/snapshot-validation";
import type { UiNode, UiSnapshot } from "../shared/types";
import { parseUiHierarchy } from "../electron/capture/xml-tree";
import { createInspectorMcpServer } from "../electron/automation/mcp-server";
import { publishMcpSnapshot } from "../electron/automation/mcp-snapshot";
import { openLiveBridge } from "../electron/automation/mcp-live";

const sessionId = "00000000-0000-4000-8000-000000000001";
const snapshotId = "00000000-0000-4000-8000-000000000002";
const input = { sessionId, snapshotId, nodeId: "0" };
const parsedNode = (visibility?: string) => parseUiHierarchy(`<hierarchy><node text="收藏" class="android.widget.TextView" package="com.example.test" bounds="[0,0][100,100]"${visibility === undefined ? "" : ` visible-to-user="${visibility}"`}/></hierarchy>`).root;
const fixture = (root: UiNode): UiSnapshot => ({ serial: "visual-contract-fixture", root, nodeCount: 1 + root.children.length,
  xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null, inspectionSource: "uiautomator", captureMode: "fast" });

test("visual confirmation is optional, trimmed, bounded, strict and limited to tap/scroll", () => {
  for (const name of ["tap_node", "scroll_node"] as const) {
    const value = name === "tap_node" ? input : { ...input, direction: "down" };
    assert.equal(debugToolSchemas[name].safeParse(value).success, true);
    assert.deepEqual(debugToolSchemas[name].parse({ ...value, visualConfirmation: { description: "  整屏中收藏入口可见  " } }).visualConfirmation,
      { description: "整屏中收藏入口可见" });
    assert.equal(debugToolSchemas[name].safeParse({ ...value, visualConfirmation: { description: "字".repeat(512) } }).success, true);
    for (const visualConfirmation of [null, true, "可见", {}, { description: "" }, { description: " \n " },
      { description: 123 }, { description: "字".repeat(513) }, { description: "可见", force: true }, { description: "可见", x: 20 }]) {
      assert.equal(debugToolSchemas[name].safeParse({ ...value, visualConfirmation }).success, false, JSON.stringify(visualConfirmation));
    }
  }
  assert.equal(debugToolSchemas.press_back.safeParse({ sessionId, snapshotId, visualConfirmation: { description: "可见" } }).success, false);
});

test("XML preserves explicit visibility evidence without promoting absent or invalid flags", () => {
  for (const [raw, evidence, legacy] of [
    ["true", "visible", true], ["1", "visible", true], ["false", "hidden", false], ["0", "hidden", false],
    [undefined, "unknown", true], ["", "unknown", true], ["TRUE", "unknown", true], ["invalid", "unknown", true],
  ] as const) {
    const node = parsedNode(raw);
    assert.equal(node.visibilityEvidence, evidence, String(raw));
    assert.equal(node.visibleToUser, legacy, String(raw));
    assert.equal(isUiSnapshot(fixture(node)), true);
  }
});

test("snapshot validation accepts legacy nodes but rejects invalid visibility evidence at every depth", () => {
  const root = parsedNode("true");
  delete root.visibilityEvidence;
  assert.equal(isUiSnapshot(fixture(root)), true);
  for (const invalid of [null, false, 1, "TRUE", "", "occluded", {}, []]) {
    const child = { ...parsedNode(), id: "0/0", visibilityEvidence: invalid };
    assert.equal(isUiSnapshot(fixture({ ...root, children: [child as UiNode] })), false, JSON.stringify(invalid));
  }
});

test("MCP tree/search/node summaries distinguish unknown visibility and expose confirmation contracts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-visual-contracts-")), path = join(directory, "current.json");
  const server = createInspectorMcpServer(path), client = new Client({ name: "visual-contract-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as CallToolResult;
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent!;
  };
  try {
    const root = parsedNode(); delete root.visibilityEvidence;
    root.children = ["true", "false", undefined].map((raw, index) => ({ ...parsedNode(raw), id: `0/${index}` }));
    const { id } = publishMcpSnapshot(path, fixture(root), null);
    const current = await call("get_snapshot");
    assert.equal((current.root as Record<string, unknown>).visibilityEvidence, "unknown");
    const tree = await call("get_tree", { snapshotId: id });
    assert.deepEqual((tree.items as Array<Record<string, unknown>>).map(node => node.visibilityEvidence), ["unknown", "visible", "hidden", "unknown"]);
    const search = await call("search_nodes", { snapshotId: id, query: "收藏", visible: true });
    assert.deepEqual((search.items as Array<Record<string, unknown>>).map(node => node.visibilityEvidence), ["unknown", "visible", "unknown"]);
    const node = (await call("get_node", { snapshotId: id, nodeId: "0/2" })).node as Record<string, unknown>;
    assert.equal(node.visible, true); assert.equal(node.visibilityEvidence, "unknown");
    for (const name of ["tap_node", "scroll_node"]) {
      const tool = (await client.listTools()).tools.find(tool => tool.name === name)!;
      const schema = tool.inputSchema.properties!.visualConfirmation as Record<string, unknown>;
      assert.equal(schema.additionalProperties, false);
      assert.match(schema.description as string, /整屏/);
      assert.match(tool.description!, /visual_confirmation_required/);
    }
  } finally { await client.close(); await server.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("CLI sends visual descriptions through the validated bridge only for tap and scroll", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-visual-cli-")), path = join(directory, "current.json"), binary = join(directory, "cli.cjs");
  const seen: DebugCommand[] = [];
  const bridge = await openLiveBridge(path, async command => { seen.push(command); return { dispatchState: "not_sent", verified: false }; });
  const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolveRun => {
    execFile("node", [binary, ...args, "--snapshot-file", path], { timeout: 10_000 }, (error, stdout, stderr) =>
      resolveRun({ code: error ? 1 : 0, stdout, stderr }));
  });
  try {
    execFileSync("bun", ["build", resolve("electron/automation/cli.ts"), "--outfile", binary, "--target", "node", "--format", "cjs"], { stdio: "pipe" });
    const target = ["--session", sessionId, "--snapshot", snapshotId, "--node", "0"];
    for (const action of ["tap", "scroll"]) {
      const result = await run(action, ...target, ...(action === "scroll" ? ["--direction", "down"] : []), "--visual-confirm", "  整屏中收藏入口清晰可见  ");
      assert.equal(result.code, 0, result.stderr);
      const command = seen.at(-1)!;
      assert.ok(command.name === "tap_node" || command.name === "scroll_node");
      assert.deepEqual(command.input.visualConfirmation, { description: "整屏中收藏入口清晰可见" });
    }
    const count = seen.length;
    assert.equal((await run("tap", ...target, "--visual-confirm", " ")).code, 1);
    assert.equal((await run("tap", ...target, "--visual-confirm", "字".repeat(513))).code, 1);
    assert.equal((await run("back", "--session", sessionId, "--snapshot", snapshotId, "--visual-confirm", "可见")).code, 1);
    assert.equal(seen.length, count, "invalid confirmations must not reach the bridge");
  } finally { bridge.close(); rmSync(directory, { recursive: true, force: true }); }
});
