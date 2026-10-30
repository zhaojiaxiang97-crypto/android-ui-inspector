/** Explicit, one-shot isolated executor. Importing this module never executes a command. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { COMMAND_TIMEOUT_MS, type CommandResult } from "../../../electron/device/runtime";
import { remainingSignalBudget } from "../../../electron/device/signal-deadline";
import { createControlJournal } from "../../capture-control-entry";
import { createTargetBatchRequest, decodeTargetBatch, TARGET_BATCH_LIMIT, type TargetBatchRequest } from "./target-batch-candidate";

export const TARGET_BATCH_STDERR_LIMIT = 64 * 1024;
export const TARGET_BATCH_TERM_GRACE_MS = 250;
export const TARGET_BATCH_CLOSE_GRACE_MS = 1000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type ExecutionRecord = {
  version: 1; runId: string; requestId: string | null; adbPath: string; serial: string; packageName: string;
  status: "prepared" | "running" | "stopping" | "completed" | "failed" | "cancelled";
  startedAt: string; finishedAt: string | null; elapsedMs: number; budgetMs: number; inheritedBudgetMs: number | null;
  pid: number | null; failure: string | null; archiveError: boolean; processError: string | null;
  exit: { code: number | null; signal: string | null; confirmed: boolean; closeConfirmed: boolean };
  termination: { requested: boolean; escalated: boolean; forcedStreamClose: boolean };
  stdout: { receivedBytes: number; retainedBytes: number; sha256: string | null };
  stderr: { receivedBytes: number; retainedBytes: number; sha256: string | null };
  packetValidated: boolean; queryExitCodes: { activity: number | null; debug: number | null } | null;
  remoteCleanup: "not-verified" | "script-reported" | "reported-failed"; targetVerified: false;
};
export class TargetBatchExecutionError extends Error {
  constructor(readonly code: string, readonly reportPath: string | null, readonly record: ExecutionRecord) {
    super(`隔离窗口查询未完成：${code}`); this.name = "TargetBatchExecutionError";
  }
}

/** The caller must still supply its original grant, selected device and parent deadline. No retries. */
export async function runBoundedTargetBatch(options: {
  directory: string; adbPath: string; serial: string; packageName: string; request: TargetBatchRequest; signal: AbortSignal;
}): Promise<CommandResult> {
  assert(isAbsolute(options.directory), "A new absolute execution directory is required");
  mkdirSync(options.directory, { mode: 0o700 }); // Existing records are never resumed or overwritten.
  assert(!lstatSync(options.directory).isSymbolicLink());
  const directory = realpathSync(options.directory), started = performance.now();
  const inherited = remainingSignalBudget(options.signal), budget = Math.min(COMMAND_TIMEOUT_MS, inherited ?? Infinity);
  const record: ExecutionRecord = { version: 1, runId: randomUUID(), requestId: uuid.test(options.request.requestId) ? options.request.requestId : null,
    adbPath: options.adbPath, serial: options.serial, packageName: options.packageName, status: "prepared", startedAt: new Date().toISOString(),
    finishedAt: null, elapsedMs: 0, budgetMs: budget, inheritedBudgetMs: inherited ?? null, pid: null, failure: null, archiveError: false, processError: null,
    exit: { code: null, signal: null, confirmed: false, closeConfirmed: false },
    termination: { requested: false, escalated: false, forcedStreamClose: false },
    stdout: { receivedBytes: 0, retainedBytes: 0, sha256: null }, stderr: { receivedBytes: 0, retainedBytes: 0, sha256: null },
    packetValidated: false, queryExitCodes: null, remoteCleanup: "not-verified", targetVerified: false };
  let reportPath: string | null = join(directory, "execution.json");
  const checkpoint = createControlJournal(reportPath, record);
  const expired = () => (remainingSignalBudget(options.signal) ?? Infinity) <= 0 || performance.now() - started >= budget;
  const cancellation = () => (expired() || options.signal.reason?.name === "TimeoutError") ? "deadline_exceeded" : "cancelled";
  let reply: CommandResult = { code: null, stdout: Buffer.alloc(0), stderr: "" };
  try {
    assert(process.platform === "darwin" || process.platform === "linux", "unsupported_platform");
    assert(isAbsolute(options.adbPath) && /^[\w.:-]{1,256}$/.test(options.serial), "invalid_scope");
    assert(record.requestId && Buffer.byteLength(options.request.script) <= 16 * 1024, "invalid_request");
    const expected = createTargetBatchRequest(options.packageName);
    assert.equal(options.request.script, expected.script.split(expected.requestId).join(options.request.requestId), "invalid_request");
    if (options.signal.aborted || expired()) record.failure = cancellation();
    if (!record.failure) reply = await new Promise<CommandResult>(resolve => {
      const out: Buffer[] = [], err: Buffer[] = [];
      let child: ReturnType<typeof spawn> | undefined, settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const send = (signal: NodeJS.Signals) => {
        if (child?.pid) try { process.kill(-child.pid, signal); } catch { /* An exited owned group still requires close acknowledgement. */ }
      };
      const finish = (closed: boolean, code: number | null, signal: string | null) => {
        if (settled) return; settled = true;
        clearTimeout(killTimer); clearTimeout(closeTimer); clearTimeout(deadlineTimer);
        options.signal.removeEventListener("abort", abort);
        record.exit.closeConfirmed = closed; record.exit.code = code; record.exit.signal = signal;
        if (!closed) {
          record.failure ??= "close_unconfirmed"; record.termination.forcedStreamClose = true;
          send("SIGKILL"); child?.stdout?.destroy(); child?.stderr?.destroy();
        }
        const stdout = Buffer.concat(out), stderr = Buffer.concat(err);
        record.stdout.sha256 = createHash("sha256").update(stdout).digest("hex");
        record.stderr.sha256 = createHash("sha256").update(stderr).digest("hex");
        resolve({ code, stdout, stderr: stderr.toString("utf8") });
      };
      const closeWatchdog = () => {
        closeTimer ??= setTimeout(() => finish(false, record.exit.code, record.exit.signal), TARGET_BATCH_CLOSE_GRACE_MS);
      };
      const stop = (code: string) => {
        if (settled) return;
        record.failure ??= code;
        if (record.termination.requested) return;
        record.termination.requested = true; record.status = "stopping"; send("SIGTERM");
        killTimer = setTimeout(() => { record.termination.escalated = true; send("SIGKILL"); closeWatchdog(); }, TARGET_BATCH_TERM_GRACE_MS);
      };
      const save = () => { try { checkpoint(record); } catch { record.archiveError = true; stop("archive_failed"); } };
      const abort = () => stop(cancellation());
      const receive = (name: "stdout" | "stderr", chunks: Buffer[], limit: number, value: Buffer | string) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), bucket = record[name];
        const before = bucket.receivedBytes; bucket.receivedBytes += bytes.length;
        const retained = bytes.subarray(0, Math.max(0, limit - bucket.retainedBytes));
        if (retained.length) { chunks.push(Buffer.from(retained)); bucket.retainedBytes += retained.length; }
        if (before <= limit && bucket.receivedBytes > limit) { stop(`${name}_limit`); save(); }
      };
      try {
        child = spawn(options.adbPath, ["-s", options.serial, "shell", options.request.script], { detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        child.stdout!.on("data", value => receive("stdout", out, TARGET_BATCH_LIMIT, value));
        child.stderr!.on("data", value => receive("stderr", err, TARGET_BATCH_STDERR_LIMIT, value));
        child.once("spawn", () => { if (!settled) { record.pid = child!.pid!; if (!record.termination.requested) record.status = "running"; save(); } });
        child.once("error", error => { if (!settled) { record.processError = "code" in error ? String(error.code) : "unknown"; stop("spawn_error"); closeWatchdog(); } });
        child.once("exit", (code, signal) => { if (!settled) { record.exit = { code, signal, confirmed: true, closeConfirmed: false }; closeWatchdog(); } });
        child.once("close", (code, signal) => finish(true, code, signal));
        options.signal.addEventListener("abort", abort, { once: true });
        deadlineTimer = setTimeout(() => stop("deadline_exceeded"), Math.max(0, budget - (performance.now() - started)));
        if (options.signal.aborted || expired()) abort();
      } catch { record.failure ??= "spawn_error"; finish(false, null, null); }
    });
    if (!record.failure && (options.signal.aborted || expired())) record.failure = cancellation();
    if (!record.failure && (!record.exit.closeConfirmed || reply.code !== 0 || record.exit.signal)) record.failure = "process_exit";
    if (reply.code === 124) record.remoteCleanup = "reported-failed";
    if (!record.failure) {
      try {
        const parsed = decodeTargetBatch(reply, options.request.requestId);
        record.packetValidated = true; record.queryExitCodes = { activity: parsed.activity.code, debug: parsed.debug.code };
        record.remoteCleanup = "script-reported";
      } catch { record.failure = "protocol_invalid"; }
    }
  } catch (error) {
    record.failure ??= error instanceof assert.AssertionError ? error.message.split("\n")[0] : "invalid_request";
  }
  record.elapsedMs = performance.now() - started; record.finishedAt = new Date().toISOString();
  record.stdout.sha256 ??= createHash("sha256").update(reply.stdout).digest("hex");
  record.stderr.sha256 ??= createHash("sha256").update(reply.stderr).digest("hex");
  record.status = record.failure === "cancelled" ? "cancelled" : record.failure ? "failed" : "completed";
  try { checkpoint(record); }
  catch {
    record.archiveError = true; record.failure ??= "archive_failed"; record.status = "failed";
    reportPath = join(directory, `failure-${randomUUID()}.json`);
    try { createControlJournal(reportPath, record); }
    catch { reportPath = null; throw new TargetBatchExecutionError("archive_unavailable", null, structuredClone(record)); }
  }
  if (record.failure) throw new TargetBatchExecutionError(record.failure, reportPath, structuredClone(record));
  return reply;
}
