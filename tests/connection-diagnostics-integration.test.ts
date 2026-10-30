import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { openLiveBridge } from "../electron/automation/mcp-live";
import type { ConnectionDiagnosticReport } from "../shared/connection-diagnostics";

test("packaged CLI and MCP use the common diagnosis without writes, including missing live connection, authorization, lock and timeout", { timeout: 40_000, skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "connection-diagnosis-")), platform = join(directory, "platform-tools");
  mkdirSync(platform);
  copyFileSync(resolve("tests/fixtures/connection-diagnostic-adb.cjs"), join(platform, "adb"));
  execFileSync("chmod", ["700", join(platform, "adb")]);
  const entry = join(directory, "cli.cjs"), mcpEntry = join(directory, "mcp.cjs"), path = join(directory, "current.json"), log = join(directory, "adb.log");
  execFileSync("bun", ["build", resolve("electron/automation/cli.ts"), "--outfile", entry, "--target", "node", "--format", "cjs"], { stdio: "pipe" });
  execFileSync("bun", ["build", resolve("electron/automation/mcp.ts"), "--outfile", mcpEntry, "--target", "node", "--format", "cjs"], { stdio: "pipe" });
  const env = { ...process.env, ANDROID_HOME: directory, ANDROID_UI_INSPECTOR_MCP_SNAPSHOT: path, DIAGNOSTIC_ADB_LOG: log };
  const run = (extra: Record<string, string> = {}, args: string[] = []) => new Promise<{ code: number; report: ConnectionDiagnosticReport; stderr: string }>(resolve => {
    execFile("node", [entry, "diagnose", "--serial", "diagnostic-fixture", "--package", "com.example.diagnostics", ...args], { env: { ...env, ...extra }, timeout: 15_000 },
      (error, stdout, stderr) => resolve({ code: error && typeof error.code === "number" ? error.code : error ? -1 : 0, report: JSON.parse(stdout), stderr }));
  });
  let bridge: Awaited<ReturnType<typeof openLiveBridge>> | undefined;
  const client = new Client({ name: "diagnosis-fixture", version: "1" });
  try {
    bridge = await openLiveBridge(path, async command => {
      assert.equal(command.name, "get_debug_session");
      return { active: true, serial: "diagnostic-fixture", packageName: "com.example.diagnostics" };
    });
    const cli = await run();
    assert.equal(cli.code, 0, cli.stderr); assert.equal(cli.report.client, "cli"); assert.equal(cli.report.outcome, "ready");
    assert.equal(cli.report.checks.find(check => check.id === "sdk")!.code, "sdk-enhancement-disabled");
    await client.connect(new StdioClientTransport({ command: "node", args: [mcpEntry], env, stderr: "pipe" }));
    const tool = (await client.listTools()).tools.find(tool => tool.name === "diagnose_connection")!;
    assert.equal(tool.annotations?.readOnlyHint, true); assert.equal(tool.annotations?.destructiveHint, false);
    assert.ok(!Object.prototype.hasOwnProperty.call(tool.inputSchema.properties ?? {}, "inspectionMode"), "MCP exposes no SDK override");
    const result = await client.callTool({ name: "diagnose_connection", arguments: { serial: "diagnostic-fixture", packageName: "com.example.diagnostics" } }) as CallToolResult;
    assert.equal(result.isError, undefined);
    const report = result.structuredContent as ConnectionDiagnosticReport;
    assert.equal(report.client, "mcp"); assert.equal(report.outcome, "ready");
    assert.equal(report.checks.find(check => check.id === "sdk")!.code, "sdk-enhancement-disabled");
    assert.equal(report.checks.find(check => check.id === "automation")!.status, "pass");
    const locked = await run({ DIAGNOSTIC_LOCKED: "1" });
    assert.equal(locked.code, 2); assert.equal(locked.report.checks.find(check => check.id === "screen")!.code, "screen-locked");
    const unauthorized = await run({ DIAGNOSTIC_DEVICE_STATE: "unauthorized" });
    assert.equal(unauthorized.code, 2); assert.equal(unauthorized.report.checks.find(check => check.id === "authorization")!.code, "device-unauthorized");
    const timeout = await run({ DIAGNOSTIC_ADB_DELAY: "1" }, ["--timeout-ms", "1000"]);
    assert.equal(timeout.code, 2); assert.equal(timeout.report.status, "timed_out");
    bridge.close(); bridge = undefined;
    const noLive = await run();
    assert.equal(noLive.code, 2); assert.equal(noLive.report.checks.find(check => check.id === "automation")!.code, "automation-connection-failed");
    const commands = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.ok(commands.length > 20);
    for (const command of commands) assert.ok(!command.includes("input") && !command.includes("put") && !command.includes("install")
      && !command.includes("content") && !command.includes("forward") && !command.includes("uiautomator") && !command.includes("screencap"));
    assert.ok(!commands.some(command => command.includes("package")), "CLI/MCP never probe SDK declarations without a trusted desktop mode");
  } finally { bridge?.close(); await client.close(); rmSync(directory, { recursive: true, force: true }); }
});
