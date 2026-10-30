import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { ProviderClient } from "../../electron/sdk/provider-session";
import { createAccessibilityHelperSession } from "../../electron/capture/helper-session";
import { observeDebugApp } from "../../electron/automation/device-actions";
import { assertActionableHelperSnapshot } from "../../shared/helper-observation";
import { helperCapabilities, helperFrame, helperPackage, helperPayload, helperSerial, helperToken } from "./helper-protocol";

const directory = mkdtempSync(join(tmpdir(), "helper-v1-observer-")), scenario = process.env.HELPER_OBSERVER_CASE ?? "success";
const controller = new AbortController(), commands: string[][] = [], requests: string[] = [];
let mapping: { local: string; remote: string } | undefined, helper: Server | undefined, capture = 0, frames = 0, targets = 0;
const image = (await sharp({ create: { ...helperFrame, channels: 4, background: "red" } }).png().toBuffer()).toString("base64");
const listen = (server: Server, port = 0) => new Promise<number>((resolve, reject) => {
  server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});
const close = async (server?: Server) => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
const control = createServer(async (req, res) => {
  try {
    let body = ""; for await (const part of req) body += part;
    const all: string[] = JSON.parse(body);
    if (all[0] !== "-s" || all[1] !== helperSerial) throw Error("Unexpected serial");
    const args = all.slice(2); commands.push(args); let stdout = "";
    if (args.join(" ") === "shell dumpsys activity activities") {
      targets++; const id = scenario === "activity-changed" && targets > 1 ? "ccc" : "aaa";
      stdout = `mResumedActivity: ActivityRecord{${id} u0 ${helperPackage}/.Main t1}`;
    } else if (args.join(" ") === `shell run-as ${helperPackage} id`) stdout = "uid=10000";
    else if (args.join(" ") === "shell dumpsys window windows") stdout = `mCurrentFocus=Window{bbb u0 ${helperPackage}/.Main}`;
    else if (args.join(" ") === "shell dumpsys input") {
      frames++; const rotation = scenario === "geometry-changed" && frames > 1 ? 1 : 0;
      stdout = `Viewport INTERNAL: displayId=0, orientation=${rotation}, logicalFrame=[0, 0, 10, 20], physicalFrame=[0, 0, 10, 20], deviceSize=[10, 20], isActive=[1]`;
    } else if (args.join(" ") === "forward --list") stdout = mapping ? `${helperSerial} ${mapping.local} ${mapping.remote}\n` : "";
    else if (args[0] === "forward" && args[1] === "--no-rebind") {
      if (mapping) throw Error("Forward already allocated"); mapping = { local: args[2], remote: args[3] };
    } else if (args[0] === "forward" && args[1] === mapping?.local && args[2] === "tcp:18888") {
      mapping.remote = args[2];
      helper = createServer((request, response) => {
        requests.push(request.url!);
        if (request.method !== "GET" || request.headers["x-artemis-token"] !== helperToken) { response.writeHead(401).end(); return; }
        if (request.url === "/inspector/capabilities") response.end(JSON.stringify(helperCapabilities));
        else if (request.url === "/inspector/snapshot") response.end(JSON.stringify(helperPayload(image, ++capture * 100)));
        else response.writeHead(404).end();
      });
      await listen(helper, Number(mapping.local.slice(4)));
    } else if (args[0] === "forward" && args[1] === "--remove" && args[2] === mapping?.local) {
      mapping = undefined; await close(helper); helper = undefined;
    } else throw Error(`Unexpected command: ${args.join(" ")}`);
    res.end(JSON.stringify({ stdout, code: 0 }));
  } catch (error) { res.end(JSON.stringify({ stdout: "", stderr: String(error), code: 1 })); }
});
const client = createAccessibilityHelperSession({ sessionId: randomUUID(), serial: helperSerial, signal: controller.signal });
const provider: ProviderClient = { open: async () => { throw Error("Not SDK capture"); }, call: async () => { throw Error("Not SDK capture"); } };
try {
  const controlPort = await listen(control), sdk = join(directory, "sdk"), adb = join(sdk, "platform-tools", "adb"), tokenFile = join(directory, "token");
  mkdirSync(join(sdk, "platform-tools"), { recursive: true });
  writeFileSync(adb, `#!/usr/bin/env node\n(async () => { const r=await fetch(process.env.HELPER_V1_CONTROL,{method:'POST',body:JSON.stringify(process.argv.slice(2))}); const data=await r.json(); process.stdout.write(data.stdout); if(data.stderr)process.stderr.write(data.stderr); process.exitCode=data.code; })().catch(()=>{process.exitCode=1});\n`, { mode: 0o755 });
  writeFileSync(tokenFile, helperToken, { mode: 0o600 });
  process.env.ANDROID_HOME = process.env.ANDROID_SDK_ROOT = sdk;
  process.env.ANDROID_UI_INSPECTOR_HELPER_TOKEN_FILE = tokenFile;
  process.env.HELPER_V1_CONTROL = `http://127.0.0.1:${controlPort}`;
  let result: Record<string, unknown>;
  try {
    const read = () => observeDebugApp(provider, helperSerial, helperPackage, "fast", controller.signal, "accessibility-helper", "standard", "after-hierarchy", client);
    const first = await read(); assertActionableHelperSnapshot(first.snapshot);
    const second = await read(); assertActionableHelperSnapshot(second.snapshot);
    result = { source: second.snapshot.inspectionSource, captures: capture, target: second.target.packageName,
      newCapture: first.snapshot.helperObservation!.captureId !== second.snapshot.helperObservation!.captureId };
  } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
  await client.close();
  process.stdout.write(JSON.stringify({ ...result, commands, requests, mapping: mapping ?? null }));
} finally { await client.close().catch(() => undefined); await close(helper); await close(control); rmSync(directory, { recursive: true, force: true }); }
