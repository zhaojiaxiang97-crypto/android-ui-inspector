/** Opt-in diagnostic command evidence. The caller supplies its authorized, serial execution scope. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CommandRecord, CommandRunner } from "../../../electron/platform/command-runner";
import { remainingSignalBudget } from "../../../electron/device/signal-deadline";
import { createControlJournal } from "../../capture-control-entry";

export type ProbeCommandEvidence = {
  version: 1; name: string; status: "prepared" | "running" | "completed" | "failed";
  startedAt: string; finishedAt: string | null; elapsedMs: number;
  command: CommandRecord | null; failure: string | null; error: string | null; archiveError: boolean;
};
export class ProbeCommandEvidenceError extends Error {
  constructor(readonly code: string, readonly reportPath: string | null, readonly record: ProbeCommandEvidence) {
    super(`诊断命令 ${record.name} 未完成：${code}`); this.name = "ProbeCommandEvidenceError";
  }
}

/** Uses the house runner's bounded streams and close acknowledgement; never retries a command. */
export async function recordProbeCommand(options: {
  directory: string; name: string; runner: CommandRunner; args: string[]; timeoutMs: number; signal: AbortSignal;
}): Promise<Buffer> {
  assert(isAbsolute(options.directory) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(options.name), "Invalid diagnostic scope");
  mkdirSync(options.directory, { mode: 0o700 });
  const started = performance.now();
  const record: ProbeCommandEvidence = { version: 1, name: options.name, status: "prepared", startedAt: new Date().toISOString(),
    finishedAt: null, elapsedMs: 0, command: null, failure: null, error: null, archiveError: false };
  let reportPath: string | null = join(options.directory, "command.json"), commandId: number | undefined, output: Buffer | undefined;
  const checkpoint = createControlJournal(reportPath, record);
  const late = () => options.signal.aborted || (remainingSignalBudget(options.signal) ?? Infinity) <= 0;
  try {
    options.signal.throwIfAborted();
    const budget = Math.min(options.timeoutMs, remainingSignalBudget(options.signal) ?? Infinity);
    assert(budget > 0, "Parent deadline expired");
    output = await options.runner.execute(options.args, budget, options.signal, { onDispatch: () => {
      record.command = options.runner.snapshot().at(-1)!; assert(record.command);
      commandId = record.command.id; record.status = "running"; checkpoint(record);
    } });
  } catch (error) {
    record.failure = commandId === undefined ? "not_dispatched" : "command_failed";
    record.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  }
  if (commandId !== undefined) record.command = options.runner.snapshot().find(c => c.id === commandId)!;
  if (!record.failure && (!record.command?.closed || record.command.status !== "completed")) record.failure = "close_unconfirmed";
  // Capability checks cannot count a partial evidence prefix as a complete result.
  if (!record.failure && (record.command?.stdoutTruncated || record.command?.stderrTruncated)) record.failure = "evidence_truncated";
  if (!record.failure && late()) record.failure = "parent_cancelled_or_expired";
  const finish = () => {
    record.finishedAt = new Date().toISOString(); record.elapsedMs = performance.now() - started;
    record.status = record.failure ? "failed" : "completed";
  };
  const persist = () => {
    finish();
    try { checkpoint(record); }
    catch (error) {
      record.archiveError = true; record.failure ??= "archive_failed"; record.status = "failed";
      record.error ??= (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      reportPath = join(options.directory, `failure-${randomUUID()}.json`);
      try { createControlJournal(reportPath, record); }
      catch { throw new ProbeCommandEvidenceError("archive_unavailable", null, structuredClone(record)); }
    }
  };
  persist();
  if (!record.failure && late()) { record.failure = "parent_cancelled_or_expired"; persist(); }
  if (record.failure) throw new ProbeCommandEvidenceError(record.failure, reportPath, structuredClone(record));
  return output!;
}
