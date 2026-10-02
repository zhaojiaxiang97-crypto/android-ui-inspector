#!/usr/bin/env bun
// 试验探针：对比 content CLI 调用与本地会话通道（open-session + adb forward + LocalServerSocket）的每次调用开销。
// 只读：打开会话、跑同一批 handler、核对响应与文件摘要，然后关闭会话。
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

const serial = process.argv[2];
const pkg = process.argv[3] ?? "com.smile.gifmaker";
if (!serial) {
  console.error("usage: bun scripts/session-probe.ts SERIAL [PACKAGE]");
  process.exit(2);
}
const uri = `content://${pkg}.inspector`;
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8" }).toString();
const adbBuffer = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { maxBuffer: 256 * 1024 * 1024 }) as Buffer;

function contentCall(method: string, arg?: string, extras: string[] = []) {
  const started = performance.now();
  const args = ["shell", "content", "call", "--uri", uri, "--method", method];
  if (arg) args.push("--arg", arg);
  for (const extra of extras) args.push("--extra", extra);
  let stdout = "";
  let code = 0;
  try {
    stdout = adb(...args);
  } catch (error) {
    const failure = error as { stdout?: Buffer | string; status?: number };
    stdout = String(failure.stdout ?? "");
    code = failure.status ?? 1;
  }
  return { ms: Math.round(performance.now() - started), stdout: stdout.trim(), code };
}

const field = (text: string, name: string) => new RegExp(`\\b${name}=([^,}\\]]+)`).exec(text)?.[1];
const nonce = () => randomBytes(8).toString("hex");

// 1) content CLI 基线（capture 与 capture-visible 各一次）
const baselineCapture = contentCall("capture");
console.log(`[content] capture            ${String(baselineCapture.ms).padStart(6)}ms  ${baselineCapture.stdout.slice(0, 110)}`);

// 2) 打开会话
const open = contentCall("open-session");
const socket = field(open.stdout, "socket");
console.log(`[content] open-session       ${String(open.ms).padStart(6)}ms  socket=${socket ?? "-"}  ${open.stdout.slice(0, 100)}`);
if (!socket || field(open.stdout, "result") !== "ok") {
  console.error("open-session failed");
  process.exit(3);
}

const pid = adb("shell", "pidof", pkg).trim().split(/\s+/)[0];
const threadLine = adb("shell", `ps -T -p ${pid} 2>/dev/null | grep inspector-s || true`).trim();
console.log(`pid=${pid} session thread: ${threadLine || "<not found>"}`);

// 3) 建立转发与连接
const port = Number(adb("forward", "tcp:0", `localabstract:${socket}`).trim());
console.log(`forward 127.0.0.1:${port} -> localabstract:${socket}`);
const sock: net.Socket = await new Promise((resolve, reject) => {
  const s = net.connect(port, "127.0.0.1", () => resolve(s));
  s.on("error", reject);
});
let buffer = "";
const pending: Array<(line: string) => void> = [];
sock.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    pending.shift()?.(line);
  }
});
function sessionCall(method: string, arg: string | null, extras?: Record<string, unknown>) {
  const started = performance.now();
  return new Promise<{ ms: number; line: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 120_000);
    pending.push((line) => {
      clearTimeout(timer);
      resolve({ ms: Math.round(performance.now() - started), line });
    });
    sock.write(`${JSON.stringify({ method, arg, extras: extras ?? {} })}\n`);
  });
}

// 4) 会话调用：capture（与 content 基线同 handler）
const capture = await sessionCall("capture", null);
console.log(`[session] capture            ${String(capture.ms).padStart(6)}ms  ${capture.line.slice(0, 110)}`);

// 5) 会话调用：capture-visible + withTree，验证树文件与层文件摘要
for (let round = 1; round <= 3; round++) {
  const n = nonce();
  const visible = await sessionCall("capture-visible", n, { withTree: true });
  const result = field(visible.line, "result");
  const count = field(visible.line, "count");
  const bytes = Number(field(visible.line, "bytes"));
  const durationMs = field(visible.line, "durationMs");
  const treeHead = adbBuffer("exec-out", "run-as", pkg, "head", "-c", "24", `no_backup/inspector-tree-${n}.json`).toString("utf8");
  let fileNote = "";
  if (round === 1) {
    const file = adbBuffer("exec-out", "run-as", pkg, "head", "-c", "64000001", "no_backup/inspector-visible-layers.bin");
    const digest = createHash("sha256").update(file).digest("hex");
    fileNote = ` file=${file.length}/${bytes} shaMatch=${digest === field(visible.line, "sha256")}`;
  }
  console.log(`[session] capture-visible#${round} ${String(visible.ms).padStart(6)}ms  result=${result} tree=${field(visible.line, "tree")} count=${count} durationMs=${durationMs} treeFile=${JSON.stringify(treeHead.slice(0, 16))}${fileNote}`);
}

// 6) content CLI 的 capture-visible 对照（同 handler，含固定税）
const baselineVisible = contentCall("capture-visible", nonce(), ["withTree:b:true"]);
console.log(`[content] capture-visible    ${String(baselineVisible.ms).padStart(6)}ms  result=${field(baselineVisible.stdout, "result")} tree=${field(baselineVisible.stdout, "tree")} count=${field(baselineVisible.stdout, "count")} durationMs=${field(baselineVisible.stdout, "durationMs")}`);

// 7) 关闭会话并清理
const close = contentCall("close-session");
console.log(`[content] close-session      ${String(close.ms).padStart(6)}ms  ${close.stdout.slice(0, 80)}`);
sock.end();
adb("forward", "--remove", `tcp:${port}`);
console.log("done");
