#!/usr/bin/env bun
// 设备健康门控：重启目标 App + 预热 + 单次整页采集计时（业务验收前先跑，避免带病硬测）。
// 判定：采集成功（error=null）、来源为 debug-view/debug-hybrid、耗时 < 阈值（默认 15s）→ 健康。
// 退出码：0=健康；1=不健康（仍可继续观察，但不宜跑验收探针）；2=运行失败。
// 用法：bun scripts/device-health-check.ts --serial=<serial> --require-device
//   业务 App（默认）：--app=com.smile.gifmaker --activity=com.yxcorp.gifshow.HomeActivity --warm-ms=70000
//   样例 App：--app=com.androiduiinspector.sample --activity=.MainActivity --warm-ms=8000 --mode=stress-large
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UiNode } from "../shared/types";
import { awaitEndpoint, connectCdp as connect, createWaits, delay, evaluateValue, pageTarget, shutdownProbeElectron, spawnProbeElectron, waitForElectronApi } from "./lib/probe-harness";

const project = fileURLToPath(new URL("../", import.meta.url));
const cliValue = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const serial = cliValue("serial") ?? execFileSync("adb", ["get-serialno"], { encoding: "utf8" }).trim();
const requireDevice = process.argv.includes("--require-device");
const appArgument = cliValue("app") ?? "com.smile.gifmaker";
const activity = cliValue("activity") ?? "com.yxcorp.gifshow.HomeActivity";
const warmMs = Number(cliValue("warm-ms") ?? (appArgument === "com.smile.gifmaker" ? 70000 : 8000));
const modeExtra = cliValue("mode") ?? (appArgument === "com.smile.gifmaker" ? null : "stress-large");
const thresholdMs = Number(cliValue("threshold-ms") ?? 15000);

const devices = execFileSync("adb", ["devices"], { encoding: "utf8" })
  .split(/\r?\n/).slice(1).map((line) => line.split("\t")).filter((cells) => cells.length === 2);
if (!devices.find((cells) => cells[0] === serial && cells[1] === "device")) {
  if (requireDevice) throw new Error(`--require-device 需要 ${serial} 在线`);
  console.log(`[skip] 未找到 ${serial}，跳过健康检查。`);
  process.exit(0);
}

const output = join(project, ".benchmarks", "device-health-check", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
console.log(`Device health check output: ${output}`);
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args]);

console.log(`restarting ${appArgument} ...`);
adb("shell", "svc", "power", "stayon", "usb");
adb("shell", "am", "force-stop", appArgument);
const startArgs = ["shell", "am", "start", "-n", `${appArgument}/${activity}`];
if (modeExtra) startArgs.push("--es", "mode", modeExtra);
adb(...startArgs);
console.log(`warming ${warmMs}ms ...`);
await delay(warmMs);
if (appArgument === "com.smile.gifmaker") {
  adb("shell", "input", "tap", "324", "2312"); // 精选 feed
  await delay(4000);
}

const { child, endpoint } = spawnProbeElectron({ project, userDataDir: join(output, "profile"), logDir: output });
let exitCode = 2;
try {
  const endpointUrl = await awaitEndpoint(endpoint, "debugger startup", 20000);
  const address = new URL(endpointUrl);
  const debuggerPort = Number(address.port);
  const { waitForValue } = createWaits(child);
  const connection = await connect(await waitForValue("application window", 30000, () => pageTarget(debuggerPort).catch(() => null)));
  await waitForElectronApi(connection, 30000);

  const captureOnce = async (requestId: string) => {
    const outcome = await evaluateValue<{ error: string | null; nodeCount: number; root: UiNode; inspectionSource?: string }>(connection,
      `window.electronApi.inspectDevice(${JSON.stringify(serial)}, ${JSON.stringify(requestId)}).then(r => ({ error: r.error, nodeCount: r.nodeCount, root: r.root, inspectionSource: r.inspectionSource }))`);
    if (outcome.exceptionText) throw new Error(`采集 evaluate 异常：${outcome.exceptionText}`);
    return { value: outcome.value!, duration: outcome.durationMs };
  };
  let attempt = await captureOnce(`health-${Date.now()}`);
  if (attempt.value.error && /冷启动|等待页面稳定|尚未就绪|请等待页面就绪/.test(attempt.value.error)) {
    console.log(`[retry] 采集被护栏拒绝（${attempt.value.error.slice(0, 40)}），等 25s 重试。`);
    await delay(25000);
    attempt = await captureOnce(`health-${Date.now()}-retry`);
  }
  const { value, duration } = attempt;
  const source = value.inspectionSource ?? "unknown";
  const healthy = !value.error && duration < thresholdMs && (source === "debug-view" || source === "debug-hybrid");
  console.log(`[health] ${JSON.stringify({ error: value.error, nodeCount: value.nodeCount, inspectionSource: source, durationMs: duration, thresholdMs })}`);
  console.log(healthy ? `[health] 结论：健康（${Math.round(duration / 1000)}s，${value.nodeCount} 节点，${source}）` : "[health] 结论：不健康（见上；可沉降后再测，不宜跑验收探针）。");
  exitCode = healthy ? 0 : 1;

  const version = await (await fetch(`http://127.0.0.1:${debuggerPort}/json/version`)).json() as any;
  const browser = await connect(version.webSocketDebuggerUrl);
  await shutdownProbeElectron(child, browser);
} catch (error) {
  console.error(`[health] 运行失败：${(error as Error).message}`);
} finally {
  if (child.exitCode === null) child.kill();
}
process.exit(exitCode);
