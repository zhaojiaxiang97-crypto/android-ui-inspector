import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { debugCommand, type DebugCommand } from "../shared/debug-protocol";
import { writePrivateJson } from "./mcp-snapshot";

type Endpoint = { port: number; token: string; ownerPid: number };
const endpointPath = (snapshotPath: string) => `${snapshotPath}.live`;

// Internal desktop bridge, not a remotely accessible MCP service. Stdio remains the client transport.
export async function openLiveBridge(snapshotPath: string, request: (command: DebugCommand, signal: AbortSignal) => Promise<Record<string, unknown>>) {
  const token = randomBytes(32).toString("hex");
  let endpoint: Endpoint;
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.method !== "POST" || req.url !== "/" || req.headers.origin || req.headers.host !== `127.0.0.1:${endpoint.port}`
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(403).end(); return;
    }
    const controller = new AbortController();
    res.once("close", () => { if (!res.writableEnded) controller.abort(new Error("MCP 客户端已断开")); });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 16_384) { res.writeHead(413).end(); return; }
        chunks.push(buffer);
      }
      const command = debugCommand.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const result = await request(command, controller.signal);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(result));
    } catch (error) {
      if (!res.destroyed) res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ isError: true, message: error instanceof Error ? error.message : "调试请求失败。" }));
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  endpoint = { port: (server.address() as AddressInfo).port, token, ownerPid: process.pid };
  try { writePrivateJson(endpointPath(snapshotPath), endpoint); }
  catch (error) { server.close(); throw error; }
  return {
    close() { rmSync(endpointPath(snapshotPath), { force: true }); server.close(); server.closeIdleConnections(); },
  };
}

export function clearLiveEndpoint(snapshotPath: string) { rmSync(endpointPath(snapshotPath), { force: true }); }

export async function callLiveBridge(snapshotPath: string, command: DebugCommand, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const path = endpointPath(snapshotPath);
  let endpoint: Endpoint;
  try {
    if (statSync(path).size > 4096) throw new Error("无效的会话配置。");
    endpoint = JSON.parse(readFileSync(path, "utf8"));
    if (!endpoint || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535
      || !/^[a-f0-9]{64}$/.test(endpoint.token) || !Number.isSafeInteger(endpoint.ownerPid) || endpoint.ownerPid <= 0) throw new Error("无效的会话配置。");
    process.kill(endpoint.ownerPid, 0);
  } catch { throw new Error("自动调试未授权或程序已退出。请在桌面软件中开启‘自动调试’。"); }
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/`, {
    method: "POST", headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command), signal: AbortSignal.any([AbortSignal.timeout(130_000), ...(signal ? [signal] : [])]),
    redirect: "error",
  });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.message ?? "桌面调试连接失败。"));
  return data;
}
