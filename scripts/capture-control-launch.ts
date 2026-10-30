import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { captureControlConfig, readControlJson, recoverCaptureControlEntry, runCaptureControlEntry } from "./capture-control-entry";
import { createNativeCaptureControl } from "./capture-control-native";

export function parseCaptureControlArguments(args: string[]) {
  assert(args.filter(a => a === "--execute-isolated").length === 1, "Explicit --execute-isolated is required; importing/building never samples");
  let configPath: string | undefined, recoveryOnly = false, recoveryRecord: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--execute-isolated") continue;
    if (args[i] === "--recover-only") { assert(!recoveryOnly); recoveryOnly = true; continue; }
    if (args[i] === "--config") { assert(!configPath); configPath = args[++i]; assert(configPath && isAbsolute(configPath)); continue; }
    if (args[i] === "--recovery-record") { assert(!recoveryRecord); recoveryRecord = args[++i]; assert(recoveryRecord && isAbsolute(recoveryRecord)); continue; }
    throw Error("Unknown isolated entry argument");
  }
  assert(configPath, "Frozen --config is required"); assert(!recoveryRecord || recoveryOnly, "Recovery record cannot enable sampling");
  return { configPath, recoveryOnly, ...(recoveryRecord ? { recoveryRecord } : {}) };
}
export function isCaptureControlMain(mainModule: boolean, processType?: string, executableExports?: unknown) {
  // Electron changes require.main; use its runtime entry exports, since Bun rewrites source filenames.
  return mainModule || processType === "browser" && typeof executableExports === "object" && executableExports !== null
    && Reflect.get(executableExports, "launchCaptureControl") === launchCaptureControl;
}
export async function launchCaptureControl(args: string[]) {
  const input = parseCaptureControlArguments(args), config = captureControlConfig.parse(readControlJson(input.configPath));
  const executable = resolve(process.argv[1]);
  assert(config.sources.some(s => s.path === executable && s.sha256 === createHash("sha256").update(readFileSync(executable)).digest("hex")),
    "The isolated entry bundle must be frozen in config.sources");
  const { app, dialog } = await import("electron");
  assert(!app.isPackaged, "Only the isolated unpackaged entry is allowed");
  const hostDirectory = join(dirname(config.runDirectory), `.capture-control-host-${randomUUID()}`);
  mkdirSync(hostDirectory, { mode: 0o700 });
  app.setPath("userData", hostDirectory); app.setPath("sessionData", hostDirectory);
  await app.whenReady();
  const controller = new AbortController(); let finished = false;
  const cancel = () => controller.abort(new Error("Isolated entry cancelled"));
  app.on("before-quit", event => { if (!finished) { event.preventDefault(); cancel(); } });
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const platform = createNativeCaptureControl(config, { authorize: async (chunk, signal) => {
    const answer = await dialog.showMessageBox({ type: "warning", title: "授权隔离只读对照", message: `允许检查 ${config.packageName}？`,
      detail: `设备：${config.serial}\n分片：${chunk}\n本次最长30分钟。仅启动自有测试页面、读取窗口状态和完整采集，不点击、滚动或返回业务页面。报告保存在本次新目录。结束后核对原安装包、配对、桌面状态和转发；凭据仍由你在手机填写。退出会停止采集并继续恢复。`,
      buttons: ["取消", "授权本次调试"], defaultId: 0, cancelId: 0, noLink: true, signal });
    return answer.response === 1;
  } });
  try {
    const result = input.recoveryOnly ? await recoverCaptureControlEntry(config, platform, input.recoveryRecord)
      : await runCaptureControlEntry(config, platform, { offlineOnly: false, signal: controller.signal });
    process.stdout.write(JSON.stringify({ status: result.status, directory: config.runDirectory, recoveryOnly: input.recoveryOnly,
      failureCode: "failure" in result ? result.failure?.code : null }) + "\n");
    process.exitCode = result.status === "passed" ? 0 : 1;
  } finally { finished = true; process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); app.quit(); }
}

if (typeof require !== "undefined" && isCaptureControlMain(require.main === module, process.type,
  process.argv[1] ? require.cache[resolve(process.argv[1])]?.exports : undefined)) {
  void launchCaptureControl(process.argv.slice(2)).catch(async () => {
    process.stderr.write("隔离入口未通过；请核对执行参数、冻结配置及本次失败记录。\n"); process.exitCode = 1;
    if (process.type === "browser") (await import("electron")).app.exit(1);
  });
}
