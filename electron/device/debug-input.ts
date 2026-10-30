import { createCommandRunner, type CommandRecord } from "../platform/command-runner";
import type { DebugInputEvidence } from "../../shared/types";

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
};

export class DebugInputError extends Error {
  constructor(readonly evidence: DebugInputEvidence) {
    super(`${explanations[evidence.classification]}${evidence.spawned ? " 操作结果未知，请重新观察，不要自动重试。" : " 未发出操作。"}`);
  }
}

export async function runDebugInputCommand(executable: string, args: string[], signal?: AbortSignal,
  onEvidence?: (evidence: DebugInputEvidence) => void): Promise<void> {
  const runner = createCommandRunner(executable);
  const cancellation = signal ?? new AbortController().signal;
  try { await runner.execute(args, 5_000, cancellation); }
  catch { /* Raw replies and termination facts are retained in the owned runner's record. */ }
  const record = runner.snapshot()[0];
  const evidence: DebugInputEvidence = record ? classifyDebugInput(record) : {
    classification: cancellation.aborted ? "cancelled" : "spawn-failed", spawned: false, closed: true,
    exitCode: null, signal: null, durationMs: 0, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
  };
  onEvidence?.(evidence);
  if (evidence.classification !== "accepted") throw new DebugInputError(evidence);
}
