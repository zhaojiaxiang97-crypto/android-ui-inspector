// Explicit, read-only source diagnostic. Import/construction never dispatches a command.
// No default adb, SDK/JDWP, file discovery, launch, retry or packaged product entry.
import { createHash } from "node:crypto";
import { verifyInstalledQueueApk, verifyQueueProcess } from "../sdk/sdk-queue-identity";
import type { CommandRunner } from "../../../electron/platform/command-runner";

export const startupLogLimits = Object.freeze({ files: 3, fileBytes: 256 * 1024,
  totalBytes: 512 * 1024, lines: 2048, totalLines: 4096, commands: 16, operationMs: 18000, cleanupMs: 3000 });
type ClockAnchor = { sourceRunId: string; bootId: string; epochSeconds: number; uptimeSeconds: number };
export type StartupLogInput = {
  serial: string; packageName: string; apkSha256: string; pid: number; startTicks: string;
  files: string[]; allowExistingLogRead: true; historicalClock: ClockAnchor | null;
};
type Failure = "cancelled" | "deadline" | "clock-unassociated" | "clock-changed" |
  "command-unconfirmed" | "command-warning" | "invalid-reply" | "log-limit" |
  "log-incomplete" | "identity-or-read-failed" | "cleanup-unconfirmed";
type LogFile = { path: string; bytes: number; lines: number; sha256: string; content: Buffer };
export type StartupLogReport = {
  status: "collected" | "stopped"; reason?: Failure; operationReason?: Failure; cleanupConfirmed: boolean;
  // This checks a caller-supplied anchor, NOT the identity/timing of individual log events.
  association: "unknown" | "caller-anchor-checked"; eventAnalysis: "not-performed";
  target: Pick<StartupLogInput, "serial" | "packageName" | "apkSha256" | "pid" | "startTicks">;
  historicalClock: ClockAnchor | null;
  files: LogFile[]; commands: ReturnType<CommandRunner["snapshot"]>;
};
class ReadFailure extends Error { constructor(readonly reason: Failure) { super(reason); } }

// The open FD is checked BEFORE reading bytes. A link outside the exact whitelist is rejected.
// No remote writes; head bounds even a file that grows after stat. Unsupported utilities fail closed.
// Metadata brackets do not prove an atomic snapshot or exclude same-second in-place edits.
export const startupLogFileScript = `set -eu
root=$(pwd -P)
case "$root" in
 /data/data/"$3") ;;
 /data/user/*/"$3") user=\${root#/data/user/}; user=\${user%/"$3"}; case "$user" in ''|*[!0-9]*) exit 64 ;; esac ;;
 *) exit 64 ;;
esac
exec 3<"$1"
fd=/proc/self/fd/3
[ "$(readlink -f "$fd")" = "$root/$1" ] || exit 65
[ -f "$fd" ] || exit 65
before=$(stat -Lc '%d:%i:%s:%Y:%Z' "$fd")
size=$(stat -Lc '%s' "$fd")
[ "$size" -le "$2" ] || exit 66
printf '%s\\n' "$before"
head -c "$(( $2 + 1 ))" <&3
printf '\\n'
[ "$(readlink -f "$root/$1")" = "$root/$1" ] || exit 65
[ "$(stat -Lc '%d:%i:%s:%Y:%Z' "$root/$1")" = "$before" ] || exit 67
after=$(stat -Lc '%d:%i:%s:%Y:%Z' "$fd")
printf '%s\\n' "$after"`;
const clockScript = "cat /proc/sys/kernel/random/boot_id && date +%s && cat /proc/uptime";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function pin(input: StartupLogInput): StartupLogInput {
  if (!input || input.allowExistingLogRead !== true || typeof input.serial !== "string" || !/^[\w.-]{1,128}$/.test(input.serial)
    || typeof input.packageName !== "string" || !/^[\w]+(?:\.[\w]+)+$/.test(input.packageName) || input.packageName.length > 200
    || typeof input.apkSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.apkSha256) || !Number.isSafeInteger(input.pid) || input.pid <= 0
    || typeof input.startTicks !== "string" || !/^\d{1,20}$/.test(input.startTicks) || !Array.isArray(input.files)
    || !input.files.length || input.files.length > startupLogLimits.files
    || new Set(input.files).size !== input.files.length || input.files.some(path => typeof path !== "string"
      || path.length > 180 || path.split("/").length > 5
      // ':' is a legal Android filename character (e.g. hour:minute), not shell syntax.
      || path.split("/").some(part => !/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(part))))
    throw Error("Explicit target and exact relative log whitelist required");
  const anchor = input.historicalClock;
  if (anchor !== null && (!anchor || typeof anchor.sourceRunId !== "string" || !uuid.test(anchor.sourceRunId)
    || typeof anchor.bootId !== "string" || !uuid.test(anchor.bootId)
    || !Number.isSafeInteger(anchor.epochSeconds) || anchor.epochSeconds <= 0
    || !Number.isFinite(anchor.uptimeSeconds) || anchor.uptimeSeconds < 0))
    throw Error("Invalid historical device clock anchor");
  return { ...input, files: [...input.files], historicalClock: anchor && { ...anchor } };
}
function parseFile(path: string, output: Buffer): LogFile {
  const first = output.indexOf(10), last = output.lastIndexOf(10, output.length - 2);
  if (first < 0 || last <= first || output.at(-1) !== 10) throw new ReadFailure("invalid-reply");
  const before = output.subarray(0, first).toString(), after = output.subarray(last + 1, -1).toString();
  const match = /^(\d+):(\d+):(\d+):(-?\d+):(-?\d+)$/.exec(before);
  if (!match || after !== before) throw new ReadFailure("log-incomplete");
  const content = output.subarray(first + 1, last), size = Number(match[3]);
  if (size > startupLogLimits.fileBytes || content.length > startupLogLimits.fileBytes)
    throw new ReadFailure("log-limit");
  if (size !== content.length || (content.length && content.at(-1) !== 10) || content.includes(0))
    throw new ReadFailure("log-incomplete");
  let lines = 0; for (const byte of content) if (byte === 10) lines++;
  if (lines > startupLogLimits.lines) throw new ReadFailure("log-limit");
  // Reject broken UTF-8 instead of silently replacing truncated characters.
  try { new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch { throw new ReadFailure("log-incomplete"); }
  return { path, bytes: content.length, lines, sha256: createHash("sha256").update(content).digest("hex"),
    content: Buffer.from(content) };
}

/** Only a fresh, caller-owned runner is accepted. Raw output is private evidence; do not print
 * or commit reports. Returned partial files NEVER mean the failed round passed.
 * Historical clock/identity inputs must come from that historical round, never current-state
 * backfill. No event table/root-cause claim is made by this collector.
 */
export function createStartupLogReader(input: StartupLogInput, runner: CommandRunner) {
  const target = pin(input);
  if (runner.snapshot().length) throw Error("Fresh owned command runner required");
  let used = false;
  return { async run(parentSignal: AbortSignal): Promise<StartupLogReport> {
    if (used || runner.snapshot().length) throw Error("Read-only log round already used");
    used = true;
    const controller = new AbortController(), start = runner.now();
    let previous = start;
    const remaining = () => {
      const now = runner.now();
      if (!Number.isFinite(start) || !Number.isFinite(now) || now < previous || now < 0) throw new ReadFailure("deadline");
      previous = now;
      const value = startupLogLimits.operationMs - (now - start);
      if (value <= 0) throw new ReadFailure("deadline");
      return value;
    };
    const cancel = () => controller.abort(new ReadFailure("cancelled"));
    parentSignal.addEventListener("abort", cancel, { once: true }); if (parentSignal.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new ReadFailure("deadline")), startupLogLimits.operationMs);
    const report: StartupLogReport = { status: "stopped", cleanupConfirmed: false,
      association: "unknown", eventAnalysis: "not-performed",
      target: { serial: target.serial, packageName: target.packageName, apkSha256: target.apkSha256,
        pid: target.pid, startTicks: target.startTicks },
      historicalClock: target.historicalClock && { ...target.historicalClock }, files: [], commands: [] };
    const execute = async (args: string[], timeout: number, _signal: AbortSignal) => {
      controller.signal.throwIfAborted();
      if (runner.snapshot().length >= startupLogLimits.commands) throw new ReadFailure("log-limit");
      const budget = Math.min(timeout, Math.ceil(remaining()));
      // Outer abort also bounds a runner whose child cannot confirm close. Its late output
      // cannot add files to this report; finish has its own bounded cleanup deadline.
      let abort: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
      });
      let output: Buffer;
      try { output = await Promise.race([runner.execute(args, budget, controller.signal), aborted]); }
      finally { controller.signal.removeEventListener("abort", abort); }
      controller.signal.throwIfAborted(); remaining();
      const record = runner.snapshot().at(-1);
      if (!record || !record.spawned || !record.closed || record.exitCode !== 0 || record.signal !== null
        || record.status !== "completed" || record.stopReason)
        throw new ReadFailure("command-unconfirmed");
      if (record.stderr || record.stderrTruncated) throw new ReadFailure("command-warning");
      if (!Buffer.isBuffer(output) || output.length > startupLogLimits.fileBytes + 512)
        throw new ReadFailure("log-limit");
      return output;
    };
    const identity = async () => {
      await verifyInstalledQueueApk(target, target.apkSha256, controller.signal, execute);
      await verifyQueueProcess(target, controller.signal, execute);
      // exec-out escapes each argv itself; manually quoting would become literal
      // quote characters inside sh's script. Host exit 0 is not remote exit proof;
      // require the exact clock/file framing below before accepting any data.
      const raw = await execute(["-s", target.serial, "exec-out", "sh", "-c", clockScript], 1000, controller.signal);
      const match = /^([a-f0-9-]+)\n(\d+)\n(\d+(?:\.\d+)?) \d+(?:\.\d+)?\n$/.exec(raw.toString());
      if (raw.length > 256 || !match || !Number.isSafeInteger(Number(match[2])) || !Number.isFinite(Number(match[3])))
        throw new ReadFailure("invalid-reply");
      const anchor = target.historicalClock!;
      if (match[1] !== anchor.bootId || Number(match[3]) < anchor.uptimeSeconds
        || Math.abs(Number(match[2]) - Number(match[3]) - (anchor.epochSeconds - anchor.uptimeSeconds)) > 3)
        throw new ReadFailure("clock-changed");
    };
    try {
      controller.signal.throwIfAborted(); remaining();
      if (!target.historicalClock) throw new ReadFailure("clock-unassociated");
      await identity();
      let total = 0, totalLines = 0;
      for (const path of target.files) {
        const byteLimit = Math.min(startupLogLimits.fileBytes, startupLogLimits.totalBytes - total);
        if (byteLimit <= 0) throw new ReadFailure("log-limit");
        const raw = await execute(["-s", target.serial, "exec-out", "run-as", target.packageName,
          "sh", "-c", startupLogFileScript, "log-read", path,
          String(byteLimit), target.packageName], 1500, controller.signal);
        const file = parseFile(path, raw);
        total += file.bytes; totalLines += file.lines;
        if (total > startupLogLimits.totalBytes || totalLines > startupLogLimits.totalLines) throw new ReadFailure("log-limit");
        report.files.push(file);
      }
      await identity();
      report.status = "collected"; report.association = "caller-anchor-checked";
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      report.reason = reason instanceof ReadFailure ? reason.reason : "identity-or-read-failed";
      report.operationReason = report.reason;
    } finally {
      clearTimeout(timer); parentSignal.removeEventListener("abort", cancel);
      controller.abort(new ReadFailure("cancelled"));
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        report.cleanupConfirmed = await Promise.race([runner.finish(startupLogLimits.cleanupMs).catch(() => false),
          new Promise<boolean>(resolve => { cleanupTimer = setTimeout(() => resolve(false), startupLogLimits.cleanupMs); })]);
      } finally { clearTimeout(cleanupTimer); }
      report.commands = runner.snapshot();
      if (!report.cleanupConfirmed || report.commands.some(command => command.spawned && !command.closed)) {
        report.status = "stopped"; report.association = "unknown"; report.reason = "cleanup-unconfirmed";
      }
    }
    return report;
  } };
}
