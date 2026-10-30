import type { DebugStep } from "../../shared/types";
import { DEBUG_LOG_LIMITS, type DebugLogCapture, type DebugLogEvidence } from "../../shared/debug-report";
import { createCommandRunner, type CommandRunner } from "../platform/command-runner";
import { automationAdb } from "../device/target";
import { parseAppPid, verifyAppProcessName } from "../device/app-process";

const sensitiveKey = /(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i;
export const debugLogConfigurationSecrets = () => Object.entries(process.env).filter(([key]) => sensitiveKey.test(key)).map(([, value]) => value!).filter(Boolean);
export function sanitizeDebugLogText(value: string, secrets: string[] = []) {
  let text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  for (const secret of secrets.filter(value => value.length >= 4).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[已隐藏]");
  return text.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[已隐藏]@")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, "$1 [已隐藏]")
    .replace(/((?:["']?)[\w.-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key)[\w.-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi, "$1[已隐藏]");
}

export function boundedDebugLogText(value: string, secrets: string[] = []) {
  const lines = sanitizeDebugLogText(value, secrets).split(/\r?\n/).filter(line => line.trim());
  const selected: string[] = [];
  let bytes = 0, truncated = lines.length > DEBUG_LOG_LIMITS.maxLines;
  for (const line of lines.slice(-DEBUG_LOG_LIMITS.maxLines).reverse()) {
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > DEBUG_LOG_LIMITS.maxBytes) {
      truncated = true;
      const remaining = DEBUG_LOG_LIMITS.maxBytes - bytes - 1;
      if (remaining >= 64) {
        const partial = Buffer.from(line).subarray(0, remaining).toString("utf8").replace(/\uFFFD$/, "");
        if (partial) { selected.unshift(partial); bytes += Buffer.byteLength(partial) + 1; }
      }
      break;
    }
    selected.unshift(line); bytes += size;
  }
  return { text: selected.length ? `${selected.join("\n")}\n` : null, lineCount: selected.length, truncated };
}

type Scope = NonNullable<DebugLogEvidence["androidScope"]>;
type Execute = (args: string[], signal: AbortSignal) => Promise<Buffer>;
async function abortableLogCommand(execute: Execute, args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  let cancel = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? new Error("日志命令已取消。"));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try { return await Promise.race([execute(args, signal), aborted]); }
  finally { signal.removeEventListener("abort", cancel); }
}
export type DebugLogWindow = { startedAt: string; scope: Scope | null; issue: string | null; cancelled: boolean; execute: Execute | null; runner: CommandRunner | null };

export function parseAndroidLogLines(output: string, scope: Scope) {
  const raw = output.split(/\r?\n/).filter(line => line.trim() && !line.startsWith("---------"));
  const selected: string[] = [];
  for (const line of raw) {
    const entry = /^\s*(\d+\.\d+)\s+(\d+)\s+\d+\s+([EF])\s+/.exec(line);
    if (!entry) throw new Error("Android日志缺少可确认的时间、进程或错误级别，未关联内容。");
    const timestamp = Number(entry[1]) * 1000;
    if (Number(entry[2]) !== scope.pid) throw new Error("Android日志包含其他进程，未关联内容。");
    if (timestamp >= scope.deviceStartedAt && timestamp <= scope.deviceFinishedAt) selected.push(line);
  }
  return { text: selected.join("\n"), truncated: raw.length >= 401 };
}

/** Only bounded on-demand reads, never logcat -c, a device setting, or an unowned stream. */
export class DebugStepLogCollector {
  private readonly controller = new AbortController();
  private readonly runners = new Set<CommandRunner>();
  private readonly secrets: string[];
  constructor(private readonly options: { serial: string; packageName: string; sessionId: string; androidLogs?: boolean;
    execute?: Execute; secrets?: string[] }) {
    this.secrets = [...(options.secrets ?? []), ...debugLogConfigurationSecrets()];
  }

  private async identity(execute: Execute, signal: AbortSignal) {
    const pid = parseAppPid(0, (await execute(["shell", "pidof", this.options.packageName], signal)).toString("utf8"));
    verifyAppProcessName(0, await execute(["exec-out", "cat", `/proc/${pid}/cmdline`], signal), this.options.packageName);
    const stat = (await execute(["exec-out", "cat", `/proc/${pid}/stat`], signal)).toString("utf8").trim();
    const fields = new RegExp(`^${pid} \\([^\\n]*\\) (.+)$`).exec(stat)?.[1].split(/\s+/);
    const processStartTicks = fields?.[19];
    if (!processStartTicks || !/^\d{1,24}$/.test(processStartTicks)) throw new Error("无法确认Android进程启动身份，未关联日志。");
    return { pid, processStartTicks };
  }

  private async deviceTime(execute: Execute, signal: AbortSignal) {
    const before = Date.now();
    const value = (await execute(["shell", "date", "+%s.%3N"], signal)).toString("utf8").trim();
    const time = /^\d{10,13}\.\d{3}$/.test(value) ? Number(value) * 1000 : NaN;
    if (!Number.isFinite(time) || Math.abs(time - before) > 2000 || Math.abs(time - Date.now()) > 2000)
      throw new Error("无法确认Android日志与本次会话的时间范围，未关联内容。");
    return time;
  }

  async begin(step: DebugStep, signal: AbortSignal, cancellationSignal: AbortSignal = signal): Promise<DebugLogWindow> {
    const window: DebugLogWindow = { startedAt: step.time, scope: null, issue: null, cancelled: false, execute: null, runner: null };
    if (!this.options.androidLogs) return window;
    const deadline = AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(5000)]);
    try {
      if (!/^[\w]+(?:\.[\w]+)+$/.test(this.options.packageName)) throw new Error("目标App包名无效，未读取Android日志。");
      if (this.options.execute) window.execute = (args, signal) => abortableLogCommand(this.options.execute!, args, signal);
      else {
        const runner = createCommandRunner(automationAdb(this.options.serial), ["-s", this.options.serial]);
        this.runners.add(runner); window.runner = runner;
        window.execute = (args, signal) => abortableLogCommand((args, signal) => runner.execute(args, 1800, signal), args, signal);
      }
      const identity = await this.identity(window.execute, deadline);
      const deviceStartedAt = await this.deviceTime(window.execute, deadline);
      window.scope = { ...identity, deviceStartedAt, deviceFinishedAt: deviceStartedAt };
    } catch (error) {
      window.cancelled = cancellationSignal.aborted || this.controller.signal.aborted;
      window.issue = window.cancelled ? "本次日志采集已取消。" : signal.aborted ? "操作已到时限，日志范围检查未完成。"
        : sanitizeDebugLogText(error instanceof Error ? error.message : "日志范围检查失败。", this.secrets).slice(0, 16000);
    }
    return window;
  }

  private base(step: DebugStep, finishedAt: string, source: DebugLogEvidence["source"]): DebugLogEvidence {
    return { source, sessionId: this.options.sessionId, stepId: step.id, packageName: this.options.packageName,
      startedAt: step.time, finishedAt, status: "empty", attribution: source === "session" ? "confirmed" : "missing",
      reason: null, truncated: false, lineCount: 0, file: null, androidScope: null };
  }

  local(step: DebugStep, finishedAt: string): DebugLogCapture {
    const lines = [step.error, ...(step.recordingErrors ?? [])].filter(Boolean).map(error =>
      `[${finishedAt}] ERROR ${error!.category}/${error!.phase}/${error!.code} ${error!.message.replace(/\r?\n/g, " ")}`);
    const content = boundedDebugLogText(lines.join("\n"), this.secrets);
    return { evidence: { ...this.base(step, finishedAt, "session"), status: content.text ? "available" : "empty",
      lineCount: content.lineCount, truncated: content.truncated, reason: content.text ? null : "本程序在此步骤没有记录错误。" }, text: content.text };
  }

  cancelled(step: DebugStep, finishedAt: string): DebugLogCapture[] {
    return [this.local(step, finishedAt), { evidence: { ...this.base(step, finishedAt, "android"), status: "cancelled",
      reason: this.options.androidLogs ? "停止会话，Android日志采集已取消；缺少本步日志证据。" : "未开启Android日志。" }, text: null }];
  }

  localOnly(step: DebugStep, finishedAt: string): DebugLogCapture[] {
    return [this.local(step, finishedAt), { evidence: { ...this.base(step, finishedAt, "android"), status: "unavailable",
      reason: this.options.androidLogs ? "日志范围检查未完成；缺少证据。" : "未开启Android日志；可在下次授权前显式开启。" }, text: null }];
  }

  async finish(window: DebugLogWindow, step: DebugStep, finishedAt: string, signal: AbortSignal): Promise<DebugLogCapture[]> {
    const local = this.local(step, finishedAt), evidence = this.base(step, finishedAt, "android");
    const done = (reason: string, status: DebugLogEvidence["status"] = "unavailable") => {
      evidence.status = status; evidence.reason = reason;
      return [local, { evidence, text: null }];
    };
    try {
      if (!this.options.androidLogs) return done("未开启Android日志；可在下次授权前显式开启。", "unavailable");
      if (signal.aborted || this.controller.signal.aborted || window.cancelled) return done("本次Android日志采集已取消；缺少证据。", "cancelled");
      if (step.status !== "failed") return done("Android日志仅在失败步骤读取。", "empty");
      if (window.issue || !window.scope || !window.execute) return done(`${window.issue ?? "无法确认日志范围。"} 缺少Android日志证据。`);
      const deadline = AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(5000)]);
      const identity = await this.identity(window.execute, deadline);
      if (identity.pid !== window.scope.pid || identity.processStartTicks !== window.scope.processStartTicks)
        return done("目标App进程在步骤期间重启或变化，无法确认日志归属；缺少证据。");
      const deviceFinishedAt = await this.deviceTime(window.execute, deadline);
      if (deviceFinishedAt < window.scope.deviceStartedAt) return done("设备时间发生倒退，无法确认本步日志范围；缺少证据。");
      const scope = { ...window.scope, deviceFinishedAt };
      const output = await window.execute(["logcat", "-d", "-v", "threadtime,epoch", `--pid=${scope.pid}`, "-t", "401", "*:E"], deadline);
      const after = await this.identity(window.execute, deadline);
      if (after.pid !== scope.pid || after.processStartTicks !== scope.processStartTicks) return done("读取期间目标进程发生变化，无法确认日志归属；缺少证据。");
      const selected = parseAndroidLogLines(output.toString("utf8"), scope), content = boundedDebugLogText(selected.text, this.secrets);
      return [local, { evidence: { ...evidence, status: content.text ? "available" : "empty", attribution: "confirmed",
        androidScope: scope, reason: "仅目标App主进程的错误日志；范围从步骤启动身份检查完成到日志收尾检查，不含子进程或系统日志。",
        truncated: selected.truncated || content.truncated, lineCount: content.lineCount }, text: content.text }];
    } catch (error) {
      return done(signal.aborted || this.controller.signal.aborted ? "Android日志采集已取消；缺少证据。"
        : `${sanitizeDebugLogText(error instanceof Error ? error.message : "Android日志读取失败。", this.secrets).slice(0, 15000)} 缺少证据。`,
      signal.aborted || this.controller.signal.aborted ? "cancelled" : "unavailable");
    } finally {
      if (window.runner) {
        if (await window.runner.finish(2000)) this.runners.delete(window.runner);
        else { evidence.status = "unavailable"; evidence.reason = "无法确认日志子进程已经退出；缺少日志证据。"; }
      }
    }
  }

  stop() {
    this.controller.abort(new Error("会话停止，日志采集已取消。"));
    for (const runner of this.runners) void runner.finish(2000).then(released => { if (released) this.runners.delete(runner); });
  }
}
