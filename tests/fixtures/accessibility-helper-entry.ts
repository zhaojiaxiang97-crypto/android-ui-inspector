import type { ProviderClient } from "../../electron/sdk/provider-session";
// Isolated production-path fixture: every ADB command goes to the local stub.
import { createServer, type Server } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { observeDebugApp } from "../../electron/automation/device-actions";
import { DebugSession } from "../../electron/automation/debug-session";
import { openLiveBridge } from "../../electron/automation/mcp-live";
import { HelperCaptureError } from "../../electron/capture/accessibility-helper";

const directory = mkdtempSync(join(tmpdir(), "helper-observer-"));
const packageName = "com.example.helper", serial = "helper-fixture";
const token = "fixture_token_for_local_test_only";
const scenario = process.env.HELPER_FIXTURE_CASE ?? "success";
const commands: string[][] = [];
const controller = new AbortController();
let helper: Server | undefined, mapping: { local: string; remote: string } | undefined;
let requests = 0, activityReads = 0, displayReads = 0, removed = false;
let bodyReads = 0, bodyReadPending = false;
const transportCancellation = scenario === "cancel-cli" || scenario === "cancel-mcp";
let cancelClient: () => void = () => {}, httpDisconnectedBeforeResponse = false;
const nativeFetch = globalThis.fetch;
const listen = (server: Server, port = 0) => new Promise<number>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});
const close = async (server?: Server) => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
};
const node = (attrs: string, children = "") => `<node package="${packageName}" class="android.view.View" bounds="[0,0][1,1]" enabled="true" visible-to-user="true" ${attrs}>${children}</node>`;
const xml = `<hierarchy rotation="0">${node('window-id="7" window-type="application" window-focused="true"',
  node('resource-id="account_input" text="" hint="Account name" error="Account is required" state-description="Paused"'))}</hierarchy>`;
const payload = { success: true, truncated: scenario === "truncated", xml: scenario === "foreign-window" ? xml.split(packageName).join("com.other.app") : xml,
  width: 1, height: 1, rotation: 0, window_count: 1, node_count: 2 };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1EAAAAASUVORK5CYII=";
const control = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const args: string[] = JSON.parse(body);
    if (args[0] !== "-s" || args[1] !== serial) throw Error("Unexpected device");
    const action = args.slice(2); commands.push(action);
    let stdout = "", stdoutBase64: string | undefined;
    if (action.join(" ") === "shell dumpsys activity activities") {
      activityReads++;
      const id = scenario === "activity-moved" && activityReads > 1 ? "ccc" : "aaa";
      stdout = `mResumedActivity: ActivityRecord{${id} u0 ${packageName}/.Main t1}`;
    } else if (action.join(" ") === `shell run-as ${packageName} id`) stdout = "uid=10000";
    else if (action.join(" ") === "shell dumpsys window windows") stdout = `mCurrentFocus=Window{bbb u0 ${packageName}/.Main}`;
    else if (action.join(" ") === "shell dumpsys input") {
      displayReads++;
      const rotation = scenario === "geometry-moved" && displayReads > 1 ? 1 : 0;
      stdout = `Viewport INTERNAL: displayId=0, orientation=${rotation}, logicalFrame=[0, 0, 1, 1], physicalFrame=[0, 0, 1, 1], deviceSize=[1, 1], isActive=[1]`;
    } else if (action.join(" ") === "exec-out screencap -p") stdoutBase64 = scenario === "bad-png" ? Buffer.from("invalid PNG").toString("base64") : png;
    else if (action.join(" ") === "forward --list") stdout = mapping ? `${serial} ${mapping.local} ${mapping.remote}\n` : "";
    else if (action[0] === "forward" && action[1] === "--no-rebind" && action[3]?.startsWith("localabstract:inspector.queue.")) {
      if (mapping) throw Error("Forward already exists");
      mapping = { local: action[2], remote: action[3] };
    } else if (action[0] === "forward" && action[1] === mapping?.local && action[2] === "tcp:18888") {
      mapping.remote = action[2];
      helper = createServer((request, response) => {
        requests++;
        if (request.method !== "GET" || request.url !== "/dump?fields=xml" || request.headers["x-artemis-token"] !== token) {
          response.writeHead(400).end(); return;
        }
        if (scenario === "cancel") { controller.abort(Error("fixture cancellation")); return; }
        if (transportCancellation && requests === 1) {
          response.once("close", () => {
            httpDisconnectedBeforeResponse = !response.writableEnded;
            response.end(JSON.stringify(payload)); // A late reply on the closed request must not be published.
          });
          cancelClient(); // Only the CLI/MCP client cancels; the session receives the transport's signal.
          return;
        }
        if (scenario === "cancel-body") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.write("{"); // Leave the real HTTP body incomplete until cancellation.
          return;
        }
        response.writeHead(scenario === "unauthorized" ? 401 : 200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      });
      await listen(helper, Number(mapping.local.slice(4)));
    } else if (action[0] === "forward" && action[1] === "--remove" && action[2] === mapping?.local) {
      mapping = undefined; removed = true; await close(helper); helper = undefined;
    } else throw Error(`Unapproved fixture command: ${action.join(" ")}`);
    res.end(JSON.stringify({ stdout, stdoutBase64, code: 0 }));
  } catch (error) { res.end(JSON.stringify({ stdout: "", stderr: String(error), code: 1 })); }
});

const provider: ProviderClient = {
  open: async () => { throw new Error("Helper fixture cannot open a Provider session"); },
  call: async () => { throw new Error("Helper fixture cannot call a Provider"); },
};

async function cancelThroughClient() {
  const path = join(directory, "current.json"), entry = join(directory, "client.cjs");
  let captures = 0, inputCalls = 0, requestSignalAborted = false;
  const session = new DebugSession({ serial, packageName, snapshotPath: path, directory,
    observe: async (...args) => {
      args[3]!.addEventListener("abort", () => { requestSignalAborted = true; }, { once: true });
      return observeDebugApp(provider, ...args);
    },
    input: async () => { inputCalls++; throw Error("Fixture does not allow device input"); },
    onEvent: event => { if (event.snapshot) captures++; },
  });
  const bridge = await openLiveBridge(path, (command, signal) => session.request(command, signal));
  const client = new Client({ name: "helper-cancel-fixture", version: "1" });
  let error = "", cliExitCode: number | string | null | undefined;
  try {
    execFileSync("bun", ["build", resolve(`electron/automation/${scenario === "cancel-cli" ? "cli" : "mcp"}.ts`),
      "--outfile", entry, "--target", "node", "--format", "cjs"], { stdio: "pipe" });
    if (scenario === "cancel-cli") {
      await new Promise<void>((done, reject) => {
        const child = execFile("node", [entry, "capture", "--session", session.state.id, "--backend", "accessibility-helper", "--snapshot-file", path],
          { env: process.env, timeout: 10_000 }, (failure, stdout, stderr) => {
            try {
              cliExitCode = failure?.code;
              if (stdout) throw Error("Cancelled CLI unexpectedly returned a result");
              error = JSON.parse(stderr).message; done();
            } catch (failure) { reject(failure); }
          });
        cancelClient = () => { child.kill("SIGINT"); };
      });
    } else {
      await client.connect(new StdioClientTransport({ command: "node", args: [entry],
        env: { ...process.env, ANDROID_UI_INSPECTOR_MCP_SNAPSHOT: path } as Record<string, string>, stderr: "pipe" }));
      cancelClient = () => controller.abort(Error("fixture MCP client cancellation"));
      try {
        await client.callTool({ name: "capture_ui", arguments: { sessionId: session.state.id, backend: "accessibility-helper" } },
          undefined, { timeout: 10_000, signal: controller.signal });
        throw Error("Cancelled MCP unexpectedly returned a result");
      } catch (failure) { error = String(failure); }
    }
    await session.settled();
    const beforeRecovery = { newSnapshots: captures, snapshotExists: existsSync(path), requestSignalAborted,
      active: session.state.active, stepStatus: session.state.steps.at(-1)?.status, httpDisconnectedBeforeResponse };
    const recovered = scenario === "cancel-mcp"
      ? (await client.callTool({ name: "capture_ui", arguments: { sessionId: session.state.id, backend: "accessibility-helper" } }) as CallToolResult).structuredContent!
      : await session.request({ name: "capture_ui", input: { sessionId: session.state.id, mode: "fast", backend: "accessibility-helper" } });
    return { error, cliExitCode, beforeRecovery, recoverySource: recovered.source, recoveryNodeCount: recovered.nodeCount, inputCalls, captures };
  } finally {
    session.stop(); await session.settled(); await client.close(); bridge.close();
  }
}

try {
  if (scenario === "cancel-body") globalThis.fetch = async (input, options) => {
    const response = await nativeFetch(input, options);
    if (String(input).endsWith("/dump?fields=xml") && response.body) {
      const stream = response.body;
      const getReader = stream.getReader.bind(stream) as () => ReadableStreamDefaultReader<Uint8Array>;
      Object.defineProperty(stream, "getReader", { value: () => {
        const reader = getReader(), read = reader.read.bind(reader);
        reader.read = () => {
          const pending = read();
          if (++bodyReads === 2) {
            let settled = false;
            pending.then(() => { settled = true; }, () => { settled = true; });
            queueMicrotask(() => {
              bodyReadPending = !settled;
              controller.abort(Error("fixture cancellation during pending body read"));
            });
          }
          return pending;
        };
        return reader;
      } });
    }
    return response;
  };
  const port = await listen(control);
  const sdk = join(directory, "sdk"), adb = join(sdk, "platform-tools", "adb"), tokenPath = join(directory, "token");
  mkdirSync(join(sdk, "platform-tools"), { recursive: true });
  writeFileSync(adb, `#!/usr/bin/env node\n(async () => {
    const reply = await fetch(process.env.HELPER_FIXTURE_CONTROL, { method: 'POST', body: JSON.stringify(process.argv.slice(2)) });
    const data = await reply.json();
    process.stdout.write(data.stdoutBase64 === undefined ? data.stdout : Buffer.from(data.stdoutBase64, 'base64'));
    if (data.stderr) process.stderr.write(data.stderr);
    process.exitCode = data.code;
  })().catch(() => { process.exitCode = 1; });\n`, { mode: 0o755 });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  process.env.ANDROID_HOME = process.env.ANDROID_SDK_ROOT = sdk;
  process.env.HELPER_FIXTURE_CONTROL = `http://127.0.0.1:${port}`;
  process.env.ANDROID_UI_INSPECTOR_HELPER_TOKEN_FILE = tokenPath;
  let result: Record<string, unknown>;
  try {
    if (transportCancellation) result = await cancelThroughClient();
    else {
      const { snapshot } = await observeDebugApp(provider, serial, packageName, "fast", controller.signal, "accessibility-helper");
      const input = snapshot.root!.children[0];
      result = { source: snapshot.inspectionSource, mode: snapshot.captureMode, nodeCount: snapshot.nodeCount,
        text: input.text, attributes: input.attributes, rawXml: snapshot.rawXml, image: Boolean(snapshot.screenshotDataUrl),
        hierarchyDumpMode: snapshot.hierarchyDumpMode ?? null };
    }
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error), code: error instanceof HelperCaptureError ? error.code : null };
  }
  process.stdout.write(JSON.stringify({ ...result, requests, commands, removed, mapping: mapping ?? null, bodyReads, bodyReadPending }));
} finally { globalThis.fetch = nativeFetch; await close(helper); await close(control); rmSync(directory, { recursive: true, force: true }); }
