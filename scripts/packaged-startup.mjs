import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const output = join(project, ".benchmarks", "native-packaged", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });

function executableCandidates() {
  const explicit = process.env.INSPECTOR_PACKAGED_EXECUTABLE;
  if (explicit) return [explicit];
  if (process.platform === "win32") return [join(project, "release", "win-unpacked", "Android UI Inspector.exe")];
  if (process.platform === "darwin") return [join(project, "release", "mac", "Android UI Inspector.app", "Contents", "MacOS", "Android UI Inspector")];
  return [
    join(project, "release", "linux-unpacked", "Android UI Inspector"),
    join(project, "release", "linux-unpacked", "android-ui-inspector"),
  ];
}

const executable = executableCandidates().find(existsSync);
if (!executable) throw new Error(`找不到当前平台的打包可执行文件：${executableCandidates().join(", ")}`);

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [
  "--remote-debugging-port=0",
  "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=${join(output, "profile")}`,
  "--enable-logging=stderr",
], { cwd: project, env: environment, windowsHide: true });

let stderr = "";
let stdout = "";
let endpoint = null;
let exited = false;
child.stdout?.on("data", (value) => { stdout += String(value); });
child.stderr?.on("data", (value) => {
  stderr += String(value);
  const match = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
  if (match) endpoint = match[1];
});
child.on("exit", () => { exited = true; });
child.on("error", (error) => { stderr += `\n${String(error)}`; exited = true; });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(operation, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`打包应用在${label}期间退出：${stderr.slice(-1600)}`);
    const result = await operation();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`打包应用${label}超时`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("打包应用调试连接超时")); }, 5_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("打包应用调试连接失败")); }, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown" || message.method === "Network.loadingFailed" || (message.method === "Log.entryAdded" && message.params.entry.level === "error")) errors.push(message);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error("打包应用调试连接断开")); }
    pending.clear();
  });
  return {
    errors,
    close: () => socket.close(),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`调试命令超时：${method}`)); }, 20_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    }),
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  executable: relative(project, executable),
  success: false,
};
let connection = null;
try {
  await until(() => endpoint, "调试端口启动");
  const address = new URL(endpoint);
  const page = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${address.port}/json/list`, { signal: AbortSignal.timeout(5_000) })).json();
    return pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  }, "窗口页面加载");
  connection = await connect(page.webSocketDebuggerUrl);
  await connection.send("Runtime.enable");
  await connection.send("Log.enable");
  await connection.send("Network.enable");
  const evaluate = async (expression) => {
    const result = await connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const state = await until(() => evaluate(`(() => ({
    title: document.title,
    heading: document.querySelector('h1')?.textContent || null,
    appShell: Boolean(document.querySelector('.app-shell')),
    runtime: window.electronApi?.runtime || null,
    nodeExposed: typeof window.require !== 'undefined',
    viewport: { width: innerWidth, height: innerHeight },
  }))()`), "React 和 preload 加载");
  assert.equal(state.title, "Android UI Inspector");
  assert.equal(state.heading, "Android UI Inspector");
  assert.equal(state.appShell, true);
  assert.equal(state.runtime?.contextIsolated, true);
  assert.equal(state.runtime?.sandboxed, true);
  assert.equal(state.nodeExposed, false);
  const screenshot = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(output, "app.png"), Buffer.from(screenshot.data, "base64"));
  report.state = state;
  report.rendererErrors = connection.errors;
  assert.equal(connection.errors.length, 0);
  report.success = true;
} catch (error) {
  report.error = String(error);
  report.rendererErrors = connection?.errors ?? [];
  process.exitCode = 1;
} finally {
  connection?.close();
  if (!exited) {
    child.kill();
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2_000)]);
  }
  report.stderr = stderr.slice(-2000);
  report.stdout = stdout.slice(-2000);
  writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, ...report }, null, 2));
}
