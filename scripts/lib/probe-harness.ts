// 探针共享底座：Electron 启动与 DevTools 端点解析、CDP 连接与求值、视觉树与转发辅助。
// 供 branch-refresh / list-refresh / sample-list-refresh / session-idle 等真机探针复用；
// 修改本文件即等价于同时升级所有探针（例如 preload 桥就绪等待、evaluate 异常标准化）。
import { appendFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { UiNode } from "../../shared/types";

const require = createRequire(import.meta.url);

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type CdpCall = { close(): void; send(method: string, params?: Record<string, unknown>): Promise<any> };

/** 启动隔离配置的桌面实例；endpoint 在解析到 DevTools 行时兑现，子进程提前退出则拒绝。 */
export function spawnProbeElectron(options: { project: string; userDataDir: string; logDir?: string; env?: Record<string, string> }): { child: ReturnType<typeof spawn>; endpoint: Promise<string> } {
  const executable = require("electron") as string;
  const launchArgs = [options.project, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    `--user-data-dir=${options.userDataDir}`];
  const environment = { ...process.env, ...(options.env ?? {}) };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_RENDERER_URL;
  const child = spawn(executable, launchArgs, { cwd: options.project, env: environment, detached: process.platform !== "win32" });
  if (options.logDir) {
    child.stdout?.on("data", (value) => appendFileSync(join(options.logDir!, "stdout.log"), value));
    child.stderr?.on("data", (value) => appendFileSync(join(options.logDir!, "stderr.log"), value));
  }
  const endpoint = new Promise<string>((resolve, reject) => {
    child.on("exit", () => reject(new Error("electron 提前退出，未出现 DevTools 端点")));
    child.stderr?.on("data", (value) => {
      const match = String(value).match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
  });
  return { child, endpoint };
}

/** 等待 DevTools 端点（带超时；子进程退出会立即拒绝）。 */
export async function awaitEndpoint(endpoint: Promise<string>, label: string, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      endpoint,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 连接 CDP WebSocket（浏览器页或 Browser 端点均可）。 */
export async function connectCdp(url: string): Promise<CdpCall> {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("debugger 连接超时")); }, 5000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("debugger 连接失败")); }, { once: true });
  });
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String((event as MessageEvent).data));
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  });
  // 连接关闭（对端退出/本地 close）时立即拒绝未决请求并清定时器，避免 300s 悬挂把手持句柄拖住进程。
  socket.addEventListener("close", () => {
    for (const [id, task] of [...pending]) {
      pending.delete(id);
      clearTimeout(task.timer);
      task.reject(new Error("CDP 连接已关闭"));
    }
  });
  return {
    close: () => socket.close(),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 300000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    }),
  };
}

/** 在 /json/list 里找应用页（url 含 dist，避开启动过渡页）。 */
export async function pageTarget(port: number): Promise<string | null> {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) })).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
  return pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl && item.url.includes("dist"))?.webSocketDebuggerUrl ?? null;
}

/** 子进程存活感知的轮询等待（check 为假或子进程退出即超时抛错）。 */
export function createWaits(child: { exitCode: number | null }) {
  const waitForValue = async (label: string, timeout: number, check: () => Promise<string | null>) => {
    const started = Date.now();
    while (Date.now() - started < timeout && child.exitCode === null) {
      const value = await check();
      if (value) return value;
      await delay(200);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const waitFor = (check: () => boolean, label: string, timeout = 20000) => {
    const started = Date.now();
    return (async () => {
      while (Date.now() - started < timeout && child.exitCode === null) {
        if (check()) return;
        await delay(100);
      }
      throw new Error(`Timed out: ${label}`);
    })();
  };
  const waitForAsync = async (label: string, timeout: number, check: () => Promise<boolean>) => {
    const started = Date.now();
    while (Date.now() - started < timeout && child.exitCode === null) {
      if (await check()) return;
      await delay(150);
    }
    throw new Error(`Timed out: ${label}`);
  };
  return { waitForValue, waitFor, waitForAsync };
}

/** Runtime.evaluate 包装：awaitPromise + returnByValue + 异常标准化（不做断言，交由调用方）。 */
export async function evaluateValue<T>(cdp: CdpCall, expression: string): Promise<{ value: T | null; exceptionText: string | null; durationMs: number }> {
  const started = Date.now();
  const reply = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const exceptionText = reply?.exceptionDetails ? JSON.stringify(reply.exceptionDetails).slice(0, 240) : null;
  return { value: (reply?.result?.value ?? null) as T | null, exceptionText, durationMs: Date.now() - started };
}

/** 优雅退出探针桌面：Browser.close（回包可能缺失）→ 等 ≤8s → SIGTERM 兜底（before-quit 仍清会话转发）→ 再等 ≤8s；仍未退出则抛错。 */
export async function shutdownProbeElectron(child: { exitCode: number | null; kill(): boolean }, browser: CdpCall): Promise<void> {
  await Promise.race([
    browser.send("Browser.close").catch(() => undefined),
    delay(2000),
  ]);
  browser.close();
  const graceful = Date.now() + 8000;
  while (Date.now() < graceful && child.exitCode === null) await delay(200);
  if (child.exitCode === null) child.kill();
  const hard = Date.now() + 8000;
  while (Date.now() < hard && child.exitCode === null) await delay(200);
  if (child.exitCode === null) throw new Error("electron 退出失败（Browser.close 与 SIGTERM 均未生效）");
}

/** preload 桥就绪等待：避开「已连上页面但 electronApi 尚未挂载」的启动竞态。 */
export async function waitForElectronApi(cdp: CdpCall, timeoutMs = 30000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const reply = await cdp.send("Runtime.evaluate", { expression: "typeof window.electronApi", returnByValue: true });
    if (reply?.result?.value === "object") return;
    await delay(150);
  }
  throw new Error("Timed out: electronApi ready");
}

export const adbForwardList = () => execFileSync("adb", ["forward", "--list"], { encoding: "utf8" });
export const adbForwardCount = () => adbForwardList().split(/\r?\n/).filter(Boolean).length;

export const nodeClass = (node: UiNode) => (node.className ?? "").split(".").pop();
export const viewRef = (node: UiNode) => node.attributes?.["view-ref"] ?? "";
export const contentOf = (node: UiNode) => `${(node.contentDesc ?? "").trim()}${(node.text ?? "").trim()}`;
export const flattenTree = (root: UiNode) => {
  const nodes: Array<{ node: UiNode; parent: UiNode | null }> = [];
  const walk = (node: UiNode, parent: UiNode | null) => { nodes.push({ node, parent }); for (const entry of node.children) walk(entry, node); };
  for (const entry of root.children) walk(entry, null);
  return nodes;
};
export const subtreeOf = (origin: UiNode) => {
  const all: UiNode[] = [];
  const walk = (node: UiNode) => { all.push(node); for (const entry of node.children) walk(entry); };
  walk(origin);
  return all;
};
export const visibleCount = (nodes: UiNode[]) => nodes.filter((node) => node.visibleToUser).length;
