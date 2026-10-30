// Explicit one-launch diagnostic. No I/O on import/construction and no automatic SDK fallback.
import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, mkdtemp, writeFile, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { verifyInstalledQueueApk, observeQueueMainProcess } from "../sdk/sdk-queue-identity";
import { createStartupStackObservation, type StartupStackReport } from "./startup-stack-observation";
import { createCommandRunner, type CommandRunner, type CommandRecord } from "../../../electron/platform/command-runner";

type Input = { serial: string; packageName: string; component: string; apkPath: string; apkSha256: string; outputRoot: string };
type Authorization = Pick<Input, "serial" | "packageName" | "component" | "apkSha256"> & {
  scope: "one-launch-and-main-stack"; acknowledged: true;
};
type Dependencies = { runner: CommandRunner; wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  choosePort?: () => Promise<number> };
export type StartupProbeReport = {
  status: StartupStackReport["status"]; input: Input; authorization: Authorization; runId: string;
  origin?: { runId: string; startedAt: number; authorized: true };
  process?: { pid: number; startTicks: string }; observation?: StartupStackReport;
  attempts: { launchCommands: number; observationCalls: number; captures: 0 };
  commands: CommandRecord[]; errors: { phase: string; message: string; commandId?: number }[];
  commandsSettled: boolean; output?: string; reportSaved: boolean;
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const canonical = (value: string) => value.replace(/\/\./, `/${value.split("/")[0]}.`);

/** Android can return exit 0 after printing a start error/warning to stderr. Starting text
 * proves only a launch request, never readiness. Unknown/warning/reused launches stop here.
 */
export function validateStartupLaunch(stdout: Buffer, stderr: string, expected: string) {
  const match = /^Starting: Intent \{[^\r\n{}]*\bcmp=([\w.$/]+)[^\r\n{}]*\}\s*$/.exec(stdout.toString().trim());
  if (!match || canonical(match[1]) !== canonical(expected) || stderr.trim()) throw Error("Launch reply unknown, failed or reused");
}

async function verifyLocalApk(input: Input, signal: AbortSignal) {
  const file = await open(input.apkPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size <= 0 || before.size > 2 * 1024 ** 3) throw Error("Invalid trusted APK file");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ signal, autoClose: false })) hash.update(chunk);
    signal.throwIfAborted();
    const after = await file.stat(), path = await lstat(input.apkPath);
    if (hash.digest("hex") !== input.apkSha256 || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || path.dev !== before.dev || path.ino !== before.ino || !path.isFile())
      throw Error("Trusted APK digest or file identity changed");
  } finally { await file.close(); }
}

/** Requires explicit target-bound caller acknowledgement. It is NOT a human-authentication
 * service. CLI demands both --run and --allow-launch-and-pause; no historical PID/time input.
 * App must not already run. No force-stop/-S, -W, repeat, install, SDK/tree/image or compile.
 */
export function createStartupStackProbe(input: Input, authorization: Authorization, dependencies: Dependencies) {
  const pinned = Object.freeze({ ...input }), permission = Object.freeze({ ...authorization }), deps = { ...dependencies };
  if (!isAbsolute(pinned.apkPath) || !isAbsolute(pinned.outputRoot) || pinned.apkPath.length > 4096 || pinned.outputRoot.length > 4096
    || pinned.apkPath.includes("\0") || pinned.outputRoot.includes("\0")
    || permission.scope !== "one-launch-and-main-stack" || permission.acknowledged !== true
    || ["serial", "packageName", "component", "apkSha256"].some(key => permission[key as keyof Authorization] !== pinned[key as keyof Input])
    || !deps.runner || deps.runner.snapshot().length !== 0) throw Error("Explicit target-bound launch/pause permission and fresh runner required");
  // Reuse existing scope validation without launching, connecting, sampling or reading files.
  createStartupStackObservation({ ...pinned, pid: 1, startTicks: "1" }, {
    runId: "11111111-1111-1111-1111-111111111111", startedAt: 0, authorized: true,
  }, { execute: deps.runner.execute });
  let used = false;
  return {
    async run(parent: AbortSignal): Promise<StartupProbeReport> {
      if (used) throw Error("Startup probe already consumed"); used = true;
      const report: StartupProbeReport = { status: "observation-failed", input: pinned, authorization: permission,
        runId: randomUUID(), attempts: { launchCommands: 0, observationCalls: 0, captures: 0 }, commands: [],
        errors: [], commandsSettled: false, reportSaved: false };
      const controller = new AbortController(), signal = controller.signal;
      const cancel = () => controller.abort(parent.reason);
      parent.addEventListener("abort", cancel, { once: true }); if (parent.aborted) cancel();
      let timer: ReturnType<typeof setTimeout> | undefined, handle: FileHandle | undefined, phase = "evidence-preflight";
      let last = -1, deadline = Infinity;
      const now = () => {
        const value = deps.runner.now();
        if (!Number.isFinite(value) || value < 0 || value < last) throw Error("Startup driver monotonic clock changed");
        last = value; return value;
      };
      const check = () => { signal.throwIfAborted(); const left = deadline - now(); if (left <= 0) throw Error("Startup driver deadline exceeded"); return left; };
      // The outer deadline must still return an unknown failure if a host cannot confirm exit.
      const untilCancelled = <T>(pending: Promise<T>) => new Promise<T>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
      const read = async (args: string[], timeout: number) => {
        const reply = await untilCancelled(deps.runner.execute(args, Math.min(timeout, check()), signal)); check(); return reply;
      };
      const fail = (at: string, error: unknown) => {
        const id = (error as { commandId?: unknown } | null)?.commandId;
        report.errors.push({ phase: at, message: message(error), ...(typeof id === "number" ? { commandId: id } : {}) });
        report.status = "observation-failed";
      };
      try {
        signal.throwIfAborted();
        if (deps.runner.snapshot().length) throw Error("Startup runner reused before run");
        const root = await lstat(pinned.outputRoot);
        if (!root.isDirectory() || root.isSymbolicLink()) throw Error("Existing non-symlink evidence directory required");
        report.output = await mkdtemp(join(pinned.outputRoot, "startup-stack-"));
        handle = await open(join(report.output, "report.json"), "wx", 0o600);
        await writeFile(join(report.output, "input.json"), JSON.stringify({ input: pinned, authorization: permission, runId: report.runId }, null, 2),
          { flag: "wx", mode: 0o600 });
        await handle.sync(); // Fail before any device command if writable evidence cannot be reserved.
        deadline = now() + 15000;
        timer = setTimeout(() => controller.abort(Error("Startup preflight deadline exceeded")), 15000);
        phase = "local-apk"; await verifyLocalApk(pinned, signal); check();
        phase = "installed-apk"; await verifyInstalledQueueApk(pinned, pinned.apkSha256, signal, read);
        phase = "debug-preflight";
        const debug = await read(["-s", pinned.serial, "exec-out", "run-as", pinned.packageName, "id"], 750);
        if (!/^uid=\d+\([^\r\n]+\) gid=\d+\([^\r\n]+\)[^\r\n]*\s*$/.test(debug.toString())) throw Error("Debug run-as identity unavailable");
        phase = "absence-preflight";
        try {
          const absent = await read(["-s", pinned.serial, "shell", "pidof", pinned.packageName], 250);
          if (absent.toString().trim()) throw Error("App already running; no automatic force-stop allowed");
        } catch (failure) {
          const error = failure as { code?: unknown; stdout?: unknown; stderr?: unknown };
          // Only pidof's known exit1+empty streams is absence. No retry on any other error.
          if (error.code !== 1 || !Buffer.isBuffer(error.stdout) || error.stdout.length || !Buffer.isBuffer(error.stderr) || error.stderr.length) throw failure;
          check();
        }
        phase = "launch"; check();
        const reply = await untilCancelled(deps.runner.execute(["-s", pinned.serial, "shell", "am", "start", "--user", "0", "-n", pinned.component], 3000, signal, {
          onDispatch: at => {
            if (report.origin) throw Error("Launch already dispatched");
            const previous = last, current = now();
            if (!Number.isFinite(at) || at < previous || at > current) throw Error("Launch clock domain changed");
            report.origin = Object.freeze({ runId: report.runId, startedAt: at, authorized: true });
            report.attempts.launchCommands++;
            clearTimeout(timer); deadline = at + 18000;
            timer = setTimeout(() => controller.abort(Error("Startup operation deadline exceeded")), Math.max(1, deadline - current));
          },
        }));
        check();
        const launched = deps.runner.snapshot().at(-1)!;
        if (launched.stderrTruncated) throw Error("Launch stderr evidence truncated; outcome unknown");
        validateStartupLaunch(reply, launched.stderr, pinned.component);
        await writeFile(join(report.output, "launch.json"), JSON.stringify({ origin: report.origin, command: launched }, null, 2), { flag: "wx", mode: 0o600 });
        phase = "process";
        const process = await observeQueueMainProcess(pinned, signal, { execute: read, now, wait: deps.wait }); check();
        report.process = { pid: process.pid, startTicks: process.startTicks };
        phase = "observation"; report.attempts.observationCalls++;
        report.observation = await createStartupStackObservation({ ...pinned, ...report.process }, report.origin!, {
          execute: deps.runner.execute, now, wait: deps.wait, choosePort: deps.choosePort,
        }).run(signal);
        report.status = report.observation.status;
      } catch (failure) { fail(phase, failure); }
      finally {
        clearTimeout(timer); controller.abort(Error("Startup probe finished")); parent.removeEventListener("abort", cancel);
        report.commandsSettled = await deps.runner.finish(Math.max(0, 3000 - (report.observation?.cleanup.cleanupMs ?? 0)));
        if (!report.commandsSettled) fail("command-cleanup", Error("Owned child command exit unconfirmed"));
        report.commands = deps.runner.snapshot();
        if (parent.aborted && !report.errors.length) fail("cancelled", parent.reason);
        if (handle) {
          try {
            report.reportSaved = true;
            await handle.writeFile(JSON.stringify(report, null, 2)); await handle.sync();
          } catch (failure) { report.reportSaved = false; fail("report-write", failure); }
          finally { await handle.close(); }
        }
      }
      return report;
    },
  };
}

export function validateStartupProbeArgs(args: string[]) {
  if (args.length !== 8 || args[6] !== "--run" || args[7] !== "--allow-launch-and-pause")
    throw Error("Usage: bun scripts/diagnostics/startup/startup-stack-probe.ts SERIAL PACKAGE COMPONENT /trusted/app.apk APK_SHA256 /absolute/evidence-root --run --allow-launch-and-pause");
  const input: Input = { serial: args[0], packageName: args[1], component: args[2], apkPath: args[3], apkSha256: args[4], outputRoot: args[5] };
  const authorization: Authorization = { serial: input.serial, packageName: input.packageName, component: input.component,
    apkSha256: input.apkSha256, scope: "one-launch-and-main-stack", acknowledged: true };
  createStartupStackProbe(input, authorization, { runner: createCommandRunner("adb") });
  return { input, authorization };
}

if (import.meta.main) {
  const { input, authorization } = validateStartupProbeArgs(process.argv.slice(2));
  const entry = createStartupStackProbe(input, authorization, { runner: createCommandRunner("adb") });
  const controller = new AbortController(), cancel = () => controller.abort(Error("Startup probe cancelled"));
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  try {
    const report = await entry.run(controller.signal);
    console.log(JSON.stringify({ status: report.status, attempts: report.attempts, output: report.output,
      reportSaved: report.reportSaved, frames: report.observation?.frames.length ?? 0, errors: report.errors }));
    if (report.status === "observation-failed" || !report.reportSaved) process.exitCode = 1;
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
