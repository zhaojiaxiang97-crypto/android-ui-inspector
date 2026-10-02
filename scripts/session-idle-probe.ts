#!/usr/bin/env bun
// 会话通道空闲回收验证：桌面以短阈值启动（INSPECTOR_SESSION_IDLE_MS）→ 采集 + 稳态刷新（会话必须打开）
// → 空闲等待 → 断言会话转发按阈值回收 → 再次刷新（自愈重建且成功）。全程 1s 采样 adb forward 并落日志。
// 默认场景=样例 App stress-large 页（稳定快）；业务 App 用法：
//   bun scripts/session-idle-probe.ts --serial=<serial> --pkg=com.smile.gifmaker \
//     --activity=com.yxcorp.gifshow.HomeActivity --warm-ms=75000 --require-device
// 判定：① 刷新期会话出现过；② 空闲前有会话；③ 空闲后已回收；④ 二次刷新自愈重建。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UiNode } from "../shared/types";
import { adbForwardList, awaitEndpoint, shutdownProbeElectron, connectCdp as connect, createWaits, delay, evaluateValue, pageTarget, spawnProbeElectron, waitForElectronApi, type CdpCall } from "./lib/probe-harness";

const project = fileURLToPath(new URL("../", import.meta.url));
const cliValue = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const serial = cliValue("serial") ?? execFileSync("adb", ["get-serialno"], { encoding: "utf8" }).trim();
const requireDevice = process.argv.includes("--require-device");
const idleMs = Number(cliValue("idle-ms") ?? 20000);
const pkg = cliValue("pkg") ?? "com.androiduiinspector.sample";
const activity = cliValue("activity") ?? ".MainActivity";
const warmMs = Number(cliValue("warm-ms") ?? (pkg === "com.smile.gifmaker" ? 75000 : 8000));
const modeExtra = pkg === "com.smile.gifmaker" ? null : (cliValue("mode") ?? "stress-large");

const devices = execFileSync("adb", ["devices"], { encoding: "utf8" })
  .split(/\r?\n/).slice(1).map((line) => line.split("\t")).filter((cells) => cells.length === 2);
const device = devices.find((cells) => cells[0] === serial && cells[1] === "device");
if (!device) {
  if (requireDevice) throw new Error(`--require-device 需要 ${serial} 在线`);
  console.log(`[skip] 未找到 ${serial}，跳过会话空闲回收探针。`);
} else {
  await runProbe();
}

async function runProbe(): Promise<void> {
  const output = join(project, ".benchmarks", "session-idle-probe", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(output, { recursive: true });
  console.log(`Session idle probe output: ${output}`);
  const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args]);

  console.log(`restarting ${pkg} ...`);
  adb("shell", "svc", "power", "stayon", "usb");
  adb("shell", "am", "force-stop", pkg);
  const startArgs = ["shell", "am", "start", "-n", `${pkg}/${activity}`];
  if (modeExtra) startArgs.push("--es", "mode", modeExtra);
  adb(...startArgs);
  await delay(warmMs);
  if (pkg === "com.smile.gifmaker") {
    adb("shell", "input", "tap", "324", "2312");
    await delay(4000);
  }

  const { child, endpoint } = spawnProbeElectron({
    project, userDataDir: join(output, "profile"), logDir: output,
    env: { INSPECTOR_SESSION_IDLE_MS: String(idleMs) },
  });
  const { waitForValue } = createWaits(child);

  // 1s 粒度采样会话转发（tcp:… localabstract:*.inspector.session），10s 心跳证明采样器存活。
  type Phase = "phase1" | "idle" | "phase2" | "done";
  let phase: Phase = "phase1";
  let lastSession = false;
  let sawPhase1 = false;
  let beforeIdle = false;
  let afterIdle = false;
  let sawRevive = false;
  const startedAt = Date.now();
  const sessionForwardPresent = () => {
    try { return /inspector\.session/.test(adbForwardList()); } catch { return null; }
  };
  const poller = setInterval(() => {
    const present = sessionForwardPresent();
    if (present === null) return;
    if (present !== lastSession) {
      lastSession = present;
      console.log(`[fwd] t+${((Date.now() - startedAt) / 1000).toFixed(0)}s ${phase}：会话转发 ${present ? "出现" : "消失"}`);
    }
    if (phase === "phase1" && present) sawPhase1 = true;
    if (phase === "phase2" && present) sawRevive = true;
  }, 1000);
  const heartbeat = setInterval(() => {
    console.log(`[fwd] t+${((Date.now() - startedAt) / 1000).toFixed(0)}s ${phase} 心跳：会话转发=${lastSession}`);
  }, 10000);

  let connection: CdpCall | null = null;
  try {
    const endpointUrl = await awaitEndpoint(endpoint, "debugger startup", 20000);
    const address = new URL(endpointUrl);
    const debuggerPort = Number(address.port);
    connection = await connect(await waitForValue("application window", 30000, () => pageTarget(debuggerPort).catch(() => null)));
    await waitForElectronApi(connection, 30000);

    const requestId = `session-idle-${Date.now()}`;
    const capture = await evaluateValue<{ error: string | null; nodeCount: number; root: UiNode; inspectionSource?: string }>(connection,
      `window.electronApi.inspectDevice(${JSON.stringify(serial)}, ${JSON.stringify(requestId)}).then(r => ({ error: r.error, nodeCount: r.nodeCount, root: r.root, inspectionSource: r.inspectionSource }))`);
    const page = capture.value;
    console.log(`[idle] 采集：${capture.durationMs}ms、${page?.nodeCount ?? 0} 节点、source=${page?.inspectionSource ?? "-"}、error=${capture.exceptionText ?? page?.error ?? "null"}`);
    assert.ok(!capture.exceptionText, `采集 evaluate 异常：${capture.exceptionText}`);
    assert.ok(page && !page.error && page.root, `采集未成功（error=${page?.error}），无法继续刷新路径验证`);
    const flat: UiNode[] = [];
    const walk = (node: UiNode) => { flat.push(node); for (const entry of node.children) walk(entry); };
    walk(page!.root);
    const target = flat.find((node) => node.attributes?.["view-ref"] && node.children.length === 0 && node.visibleToUser) ?? flat.find((node) => node.attributes?.["view-ref"]);
    assert.ok(target, "快照中没有可用于刷新的节点");

    const refreshExpression = `window.electronApi.refreshViewNode(${JSON.stringify(requestId)}, ${JSON.stringify(target!.id)}, "node").then(r => ({ failures: r.failures, branch: r.branch ? true : false, error: r.error ?? null }))`;
    const refresh1 = await evaluateValue<{ failures: unknown[]; branch: boolean; error: string | null }>(connection, refreshExpression);
    console.log(`[idle] 刷新 1：${JSON.stringify(refresh1.exceptionText ?? refresh1.value)}（${refresh1.durationMs}ms）`);
    assert.ok(!refresh1.exceptionText, `刷新 1 被拒绝：${refresh1.exceptionText}`);
    beforeIdle = lastSession;
    phase = "idle";
    console.log(`[idle] 空闲等待 ${(idleMs + 15000) / 1000}s（刷新后会话转发=${beforeIdle}）...`);
    await delay(idleMs + 15000);
    afterIdle = lastSession;
    console.log(`[idle] 空闲结束：会话转发=${afterIdle}`);
    phase = "phase2";
    const refresh2 = await evaluateValue<{ failures: unknown[]; branch: boolean; error: string | null }>(connection, refreshExpression);
    console.log(`[idle] 刷新 2：${JSON.stringify(refresh2.exceptionText ?? refresh2.value)}（${refresh2.durationMs}ms）`);
    phase = "done";
    clearInterval(poller); clearInterval(heartbeat);
    const pass = sawPhase1 && beforeIdle && !afterIdle && sawRevive;
    console.log(`[idle] 判定：刷新期会话出现过=${sawPhase1}；空闲前有会话=${beforeIdle}；空闲后已回收=${beforeIdle && !afterIdle}；二次刷新自愈重建=${sawRevive}。`);
    assert.ok(pass, "会话空闲回收验证未通过（见上）");
    console.log("[pass] 会话空闲回收验证通过。");

    const version = await (await fetch(`http://127.0.0.1:${debuggerPort}/json/version`)).json() as any;
    const browser = await connect(version.webSocketDebuggerUrl);
    await shutdownProbeElectron(child, browser);
    console.log(`[idle] 退出后转发：${JSON.stringify(adbForwardList().split(/\r?\n/).filter(Boolean))}`);
  } finally {
    clearInterval(poller);
    clearInterval(heartbeat);
    connection?.close();
    if (child.exitCode === null) child.kill();
  }
}
