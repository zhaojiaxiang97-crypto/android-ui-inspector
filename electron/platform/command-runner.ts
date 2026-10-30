// Bounded, shell-free, owned child processes. Construction/import never spawns a command.
import { spawn } from "node:child_process";

export type CommandRecord = {
  id: number; command: string[]; startedAt: string; dispatchMono: number; durationMs?: number;
  status: "running" | "completed" | "failed"; spawned: boolean;
  stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean;
  exitCode?: number | null; signal?: string | null; errorCode?: string;
  stopReason?: "cancelled" | "timeout" | "output-limit"; closed: boolean;
};
const textLimit = 4096, stdoutLimit = 2 * 1024 * 1024, stderrLimit = 8192;
type Dispatch = { onDispatch?: (at: number) => void };
export type CommandRunner = ReturnType<typeof createCommandRunner>;

/** Resolves/rejects only after this child's close event, not merely after requesting a kill.
 * Timeouts/cancellation send SIGKILL only to the owned child, never adb's shared server.
 * A host that cannot confirm child exit is handled as unknown by the caller's outer deadline.
 */
export function createCommandRunner(executable: string, prefix: string[] = [],
  clock: () => number = () => performance.now()) {
  if (typeof executable !== "string" || !executable || executable.length > 4096 || executable.includes("\0")
    || !Array.isArray(prefix) || prefix.length > 8 || prefix.some(s => typeof s !== "string" || s.includes("\0") || s.length > 4096))
    throw Error("Invalid startup command executable");
  const pinnedPrefix = [...prefix], records: CommandRecord[] = [];
  const active = new Map<number, { done: Promise<void>; stop: () => void }>();
  const snapshot = () => records.map(record => ({ ...record, command: [...record.command] }));
  return {
    now: clock, snapshot,
    async execute(args: string[], timeoutMs: number, signal: AbortSignal, options: Dispatch = {}): Promise<Buffer> {
      signal.throwIfAborted();
      if (!Array.isArray(args) || args.length > 32 || args.some(s => typeof s !== "string" || s.includes("\0") || s.length > 4096)
        || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 18000 || records.length >= 256)
        throw Error("Invalid startup command or command limit exceeded");
      const command = [executable, ...pinnedPrefix, ...args], dispatchMono = clock(), started = performance.now();
      if (!Number.isFinite(dispatchMono) || dispatchMono < 0) throw Error("Invalid startup command clock");
      const record: CommandRecord = { id: records.length + 1, command, dispatchMono,
        startedAt: new Date().toISOString(), status: "running", spawned: false, stdout: "", stderr: "",
        stdoutTruncated: false, stderrTruncated: false, closed: false };
      records.push(record);
      let child: ReturnType<typeof spawn>;
      try {
        options.onDispatch?.(dispatchMono); signal.throwIfAborted();
        child = spawn(executable, [...pinnedPrefix, ...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      } catch (failure) {
        record.status = "failed"; record.durationMs = performance.now() - started;
        record.errorCode = "DISPATCH_REJECTED";
        throw failure;
      }
      let resolveDone: () => void = () => {};
      const done = new Promise<void>(resolve => { resolveDone = resolve; });
      return await new Promise<Buffer>((resolve, reject) => {
        const output: Buffer[] = [], errors: Buffer[] = []; let outBytes = 0, errBytes = 0, failure: unknown;
        const stop = (reason: NonNullable<CommandRecord["stopReason"]>) => {
          record.stopReason ??= reason;
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill("SIGKILL"); } catch (error) { failure ??= error; record.errorCode = "KILL_FAILED"; }
          } else { child.stdout?.destroy(); child.stderr?.destroy(); }
        };
        const cancel = () => { failure ??= signal.reason; stop("cancelled"); };
        const timer = setTimeout(() => stop("timeout"), timeoutMs);
        active.set(record.id, { done, stop: () => stop("cancelled") });
        signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
        const collect = (data: Buffer, stderr: boolean) => {
          const bytes = stderr ? errBytes : outBytes, limit = stderr ? stderrLimit : stdoutLimit;
          if (bytes < limit) (stderr ? errors : output).push(Buffer.from(data.subarray(0, limit - bytes)));
          if (stderr) errBytes += data.length; else outBytes += data.length;
          // Keep bounded partial evidence even when the outer deadline cannot confirm close.
          if (bytes < textLimit) {
            const prefix = Buffer.concat(stderr ? errors : output, Math.min(bytes + data.length, textLimit)).toString("utf8");
            if (stderr) record.stderr = prefix; else record.stdout = prefix;
          }
          if (stderr) record.stderrTruncated = errBytes > textLimit; else record.stdoutTruncated = outBytes > textLimit;
          if ((stderr ? errBytes : outBytes) > limit) stop("output-limit");
        };
        child.stdout!.on("data", data => collect(data, false)); child.stderr!.on("data", data => collect(data, true));
        child.once("spawn", () => { record.spawned = true; });
        child.once("error", error => { failure ??= error; record.errorCode = (error as NodeJS.ErrnoException).code; });
        child.once("exit", () => {
          // An inherited pipe must not delay cancellation after our own child's exit is known.
          if (record.stopReason) { child.stdout?.destroy(); child.stderr?.destroy(); }
        });
        child.once("close", (code, exitSignal) => {
          clearTimeout(timer); signal.removeEventListener("abort", cancel); active.delete(record.id);
          const stdout = Buffer.concat(output), stderr = Buffer.concat(errors);
          record.durationMs = performance.now() - started; record.exitCode = code; record.signal = exitSignal;
          record.closed = true; record.stdout = stdout.subarray(0, textLimit).toString("utf8");
          record.stderr = stderr.subarray(0, textLimit).toString("utf8");
          record.stdoutTruncated = outBytes > textLimit; record.stderrTruncated = errBytes > textLimit;
          record.status = code === 0 && !failure && !record.stopReason ? "completed" : "failed";
          resolveDone();
          if (record.status === "completed") resolve(stdout);
          else {
            const error = Object.assign(Error(failure instanceof Error ? failure.message :
              `Startup command ${record.stopReason ?? record.errorCode ?? `exit ${code}`}`), {
              code, signal: exitSignal, stdout: Buffer.from(stdout.subarray(0, textLimit)),
              stderr: Buffer.from(stderr.subarray(0, textLimit)), commandId: record.id,
            });
            reject(error);
          }
        });
      });
    },
    async finish(budgetMs: number): Promise<boolean> {
      if (!active.size) return true;
      for (const task of active.values()) task.stop();
      if (!Number.isFinite(budgetMs) || budgetMs <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([Promise.all([...active.values()].map(task => task.done)).then(() => !active.size),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), budgetMs); })]);
      } finally { clearTimeout(timer); }
    },
  };
}
