// Checks delivered resources with a private synthetic share; no user session or adb.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { publishMcpSnapshot, revokeMcpSnapshot } from "../electron/automation/mcp-snapshot";
import { makeNode } from "../benchmarks/fixtures";

const evidence = createRequire(import.meta.url)("./lib/packaged-check-evidence.cjs");
const options = evidence.parseArgs(process.argv.slice(2));
const output = evidence.createEvidence(resolve(".benchmarks/packaged-readonly"), options);
const path = join(output, "share", "current.json");
const report = { ...options, output, passed: false, checks: [] as string[], phoneOperations: 0,
  installedAcceptance: false, resourceIdentity: null as unknown, resourcesUnchanged: false, error: null as string | null };
const client = new Client({ name: "packaged-readonly-check", version: "1" });
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  const identity = evidence.resourceIdentity(options.resources); report.resourceIdentity = identity;
  if (identity.candidate) assert.equal(identity.candidate, options.candidate, "Candidate identifier mismatch");
  const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8", timeout: 5000 }).trim();
  const env = { ...process.env, ANDROID_UI_INSPECTOR_MCP_SNAPSHOT: path } as Record<string, string>;
  const cli = (...args: string[]) => JSON.parse(execFileSync(node, [join(options.resources, "cli/android-ui.cjs"), ...args, "--snapshot-file", path],
    { env, encoding: "utf8", timeout: 5000 }));
  const transport = new StdioClientTransport({ command: node, args: [join(options.resources, "mcp/server.cjs")], env });
  timer = setTimeout(() => {
    report.error = "Packaged read-only check exceeded 30 seconds";
    evidence.writeResult(output, report); console.error(report.error, output); process.exit(1);
  }, 30000);
  const call = (name: string) => client.callTool({ name, arguments: {} }, undefined, { timeout: 5000 });
  assert.equal(cli("--version").version, identity.version); report.checks.push("CLI matches candidate version");
  await client.connect(transport, { timeout: 5000 });
  const tools = (await client.listTools(undefined, { timeout: 5000 })).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "get_snapshot", "search_nodes", "get_node", "get_image", "measure_nodes", "get_tree",
    "get_debug_session", "capture_ui", "define_debug_task", "check_debug_task", "tap_node",
    "scroll_node", "press_back", "wait_for_ui", "stop_debug_session", "diagnose_connection",
    "start_debug_plan", "get_debug_plan", "cancel_debug_plan", "get_ui_step",
    "perform_ui_step", "resume_ui_step", "scroll_until",
  ].sort());
  for (const name of ["define_debug_task", "check_debug_task"]) {
    assert.equal(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint, true);
  }
  report.checks.push("MCP 23 named tools; task definition/check annotated read-only");
  assert.equal((await call("get_snapshot")).isError, true);
  assert.equal((await call("get_debug_session")).isError, true);
  report.checks.push("private missing share/live endpoint refused");
  const root = makeNode("0"); root.children = [makeNode("0/0", 1)];
  const entry = publishMcpSnapshot(path, { serial: "synthetic-packaged-check", root, nodeCount: 2, xmlSize: 0,
    rawXml: null, screenshotDataUrl: null, error: null, warning: null, inspectionSource: "debug-view" }, "0/0");
  assert.equal(cli("snapshot").snapshotId, entry.id);
  assert.equal(cli("tree").total, 2);
  const result = await call("get_snapshot");
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as { snapshotId: string }).snapshotId, entry.id);
  report.checks.push("CLI/MCP synthetic share readable");
  revokeMcpSnapshot(path);
  assert.equal((await call("get_snapshot")).isError, true); report.checks.push("revoked share refused");
  evidence.verifyUnchanged(identity, options.resources); report.resourcesUnchanged = true;
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  try { await client.close(); revokeMcpSnapshot(path); }
  catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
  if (timer) clearTimeout(timer);
  evidence.writeResult(output, report);
  console.log(JSON.stringify(report));
}
