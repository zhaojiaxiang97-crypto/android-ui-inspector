import { createCommandRunner, type CommandRecord } from "../platform/command-runner";
import type { DebugInputEvidence } from "../../shared/types";
import { randomUUID } from "node:crypto";
import { measureDebugCommand } from "./debug-timing";
import { buildInputInjectionLogCommand, inspectInputInjectionLog, parseInputInjectionMarker,
  type InputInjectionMarker } from "./input-injection-diagnostics";

// Reuse the existing bounded, shell-free child runner; no device command is run on import.
// A quiet exit0 is only a dispatch acknowledgement, never proof that the UI changed.
export function classifyDebugInput(record: CommandRecord): DebugInputEvidence {
  const { spawned, closed, errorCode, stdout, stderr, stdoutTruncated, stderrTruncated } = record;
  const output = `${stdout}\n${stderr}`;
  let classification: DebugInputEvidence["classification"];
  if (!spawned) classification = "spawn-failed";
  else if (!closed) classification = "unconfirmed-exit";
  else if (record.stopReason) classification = record.stopReason;
  else if (/SecurityException|Permission\s+denied|requires.*INJECT_EVENTS|not allowed to inject/i.test(output)) classification = "permission-denied";
  else if (/device.*(?:offline|unauthorized|not found)|no devices\/emulators|device disconnected|error: closed/i.test(output)) classification = "device-unavailable";
  else if (/Unknown command|Invalid arguments|IllegalArgumentException|Usage:\s*input|input:.*not found/i.test(output)) classification = "invalid-command";
  else if (record.exitCode !== 0 || record.signal || errorCode) classification = "command-failed";
  else if (stdoutTruncated || stderrTruncated || output.trim()) classification = "unexpected-output";
  else classification = "accepted";
  return { classification, spawned, closed, exitCode: record.exitCode ?? null, signal: record.signal ?? null,
    ...(errorCode ? { errorCode } : {}), durationMs: Math.round(record.durationMs ?? 0),
    stdout, stderr, stdoutTruncated, stderrTruncated };
}

const explanations: Record<DebugInputEvidence["classification"], string> = {
  accepted: "设备输入命令已返回，尚未验证界面结果。",
  "permission-denied": "设备拒绝输入权限；不会自动修改手机安全设置。",
  "device-unavailable": "设备连接不可用。",
  "invalid-command": "设备不接受当前输入命令。",
  "command-failed": "设备输入命令失败。",
  "unexpected-output": "设备输入返回非预期内容，不能确认派发成功。",
  cancelled: "设备输入已取消。", timeout: "设备输入命令超时。", "output-limit": "设备输入回复超出上限。",
  "spawn-failed": "设备输入进程未启动。", "unconfirmed-exit": "设备输入进程退出未确认。",
  "injection-failed": "Android 系统记录本次输入注入失败；部分触摸事件可能已经发出，已停止后续操作。",
};

export class DebugInputError extends Error {
  constructor(readonly evidence: DebugInputEvidence) {
    super(`${explanations[evidence.classification]}${evidence.spawned ? " 操作结果未知，请重新观察，不要自动重试。" : " 未发出操作。"}`);
  }
}

type InjectionInspection = { nonce: string;
  check: (marker: InputInjectionMarker, signal: AbortSignal) => Promise<NonNullable<DebugInputEvidence["systemInjection"]>> };

export async function runDebugInputCommand(executable: string, args: string[], signal?: AbortSignal,
  onEvidence?: (evidence: DebugInputEvidence) => void, inspection?: InjectionInspection): Promise<void> {
  const runner = createCommandRunner(executable);
  const cancellation = signal ?? new AbortController().signal;
  try { await measureDebugCommand("input", () => runner.execute(args, 5_000, cancellation)); }
  catch { /* Raw replies and termination facts are retained in the owned runner's record. */ }
  const record = runner.snapshot()[0];
  const marker = inspection && record && !record.stdoutTruncated ? parseInputInjectionMarker(record.stdout, inspection.nonce) : null;
  if (marker && record) record.stdout = marker.stdout;
  const evidence: DebugInputEvidence = record ? classifyDebugInput(record) : {
    classification: cancellation.aborted ? "cancelled" : "spawn-failed", spawned: false, closed: true,
    exitCode: null, signal: null, durationMs: 0, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
  };
  if (inspection) {
    evidence.systemInjection = { status: "unavailable" };
    if (!marker && evidence.classification === "accepted") evidence.classification = "unexpected-output";
    if (marker && evidence.classification === "accepted") {
      try { evidence.systemInjection = await inspection.check(marker, cancellation); }
      catch { /* Missing diagnostics never prove that the system accepted the touch. */ }
      if (evidence.systemInjection.status === "rejected") evidence.classification = "injection-failed";
      else if (cancellation.aborted) evidence.classification = "cancelled";
    }
  }
  onEvidence?.(evidence);
  if (evidence.classification !== "accepted") throw new DebugInputError(evidence);
}

/** Read only this system process, input PID and device-time window; no application logs are retained. */
export async function inspectSystemInputInjection(adbPath: string, serial: string, marker: InputInjectionMarker,
  signal: AbortSignal): Promise<NonNullable<DebugInputEvidence["systemInjection"]>> {
  const known = { remotePid: marker.remotePid, systemServerPid: marker.systemServerPid, deviceStartedAt: marker.deviceEpochMs };
  const unavailable = { status: "unavailable" as const, ...known };
  const nonce = randomUUID().replace(/-/g, ""), reader = createCommandRunner(adbPath);
  try {
    const output = await measureDebugCommand("device_query", () => reader.execute(
      ["-s", serial, "shell", buildInputInjectionLogCommand(marker, nonce)], 1500, signal));
    const record = reader.snapshot()[0];
    if (output.length > 65536 || record.stderr || record.stderrTruncated) return unavailable;
    const end = parseInputInjectionMarker(output.toString("utf8"), nonce);
    if (!end || end.systemServerPid !== marker.systemServerPid || end.deviceEpochMs < marker.deviceEpochMs
      || end.deviceEpochMs - marker.deviceEpochMs > 10000) return unavailable;
    const context = { remotePid: marker.remotePid, systemServerPid: marker.systemServerPid,
      deviceStartedAt: marker.deviceEpochMs, deviceFinishedAt: end.deviceEpochMs };
    return { status: inspectInputInjectionLog(end.stdout, context),
      ...known, deviceFinishedAt: end.deviceEpochMs };
  } catch { return unavailable; }
}
