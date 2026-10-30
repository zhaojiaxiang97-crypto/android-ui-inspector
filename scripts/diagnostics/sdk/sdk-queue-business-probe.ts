// Explicit business diagnostic only. Import/construction performs no device or filesystem work.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createQueueIdentityBootstrap, type QueueBootstrapTarget } from "./sdk-queue-bootstrap";
import { verifyLocalQueueBuild } from "./sdk-queue-build";
import { verifyInstalledQueueApk } from "./sdk-queue-identity";
import { createQueueDeviceAdapters } from "./sdk-queue-device";
import { createQueueObservation, type ObservationReport, type ObservationTarget } from "./sdk-queue-observation";

type ObservationDependencies = Parameters<typeof createQueueObservation>[1];
type Device = ReturnType<typeof createQueueDeviceAdapters>;
type Dependencies = {
  bootstrap?: Parameters<typeof createQueueIdentityBootstrap>[1];
  device?: (target: ObservationTarget, role: "reader" | "capture") => Device;
  observation?: Pick<ObservationDependencies, "artifacts" | "installed" | "process" | "subscribe" | "now">;
  timeoutMs?: number;
};
export type BusinessQueueReport = {
  status: "identity-failed" | ObservationReport["status"];
  input: QueueBootstrapTarget; target?: ObservationTarget;
  bootstrap?: Awaited<ReturnType<ReturnType<typeof createQueueIdentityBootstrap>["run"]>>;
  attempts: { bootstrap: number; preparatoryTree: 0; captureCalls: number };
  steps: string[]; error?: string; observation?: ObservationReport;
  errorDetails?: { code?: number | string | null; killed?: boolean; signal?: string | null;
    stdout?: string; stderr?: string; outputTruncated?: true };
  cleanup: { readerConnectionClosed?: boolean; readerError?: string;
    captureConnectionClosed?: boolean; captureError?: string };
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

// Keep the failed command's evidence, not a guessed timeout or an arbitrary Error/object dump.
function commandFailure(error: unknown): BusinessQueueReport["errorDetails"] {
  if (!error || typeof error !== "object") return undefined;
  const value = error as Record<string, unknown>;
  const details: NonNullable<BusinessQueueReport["errorDetails"]> = {};
  const code = value.code;
  if (code === null || typeof code === "number" && Number.isSafeInteger(code)
    || typeof code === "string" && code.length <= 128) details.code = code;
  if (typeof value.killed === "boolean") details.killed = value.killed;
  if (value.signal === null || typeof value.signal === "string" && value.signal.length <= 32) details.signal = value.signal;
  if (value.outputTruncated === true) details.outputTruncated = true;
  for (const field of ["stdout", "stderr"] as const) {
    const output = value[field];
    const text = Buffer.isBuffer(output) ? output.toString("utf8") : typeof output === "string" ? output : undefined;
    if (text === undefined) continue;
    details[field] = text.slice(0, 4096);
    if (text.length > 4096) details.outputTruncated = true;
  }
  return Object.keys(details).length ? details : undefined;
}

// Bootstrap owns no sockets/forwards. Its late read cannot establish identity after abort.
async function readUntilAbort<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const value = await Promise.race([work(), stopped]);
    signal.throwIfAborted(); return value;
  } finally { signal.removeEventListener("abort", abort); }
}

/** Caller supplies an already observed main PID/startTicks and trusted business APK/AAR.
 * No discovery through UI/tree, launch, restart, hold, install, retry or image read is allowed here.
 * 15s covers identity + setup + observation, not the mandatory independently bounded cleanup.
 */
export function createQueueBusinessProbe(target: QueueBootstrapTarget, dependencies: Dependencies = {}) {
  const pinned = Object.freeze({ ...target });
  const bootstrap = createQueueIdentityBootstrap(pinned, dependencies.bootstrap);
  const createDevice = dependencies.device ?? ((actual: ObservationTarget) => createQueueDeviceAdapters(actual));
  const observation = { ...dependencies.observation };
  const timeoutMs = dependencies.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000)
    throw Error("Invalid business diagnostic budget");
  let consumed = false;
  return {
    async run(parentSignal: AbortSignal): Promise<BusinessQueueReport> {
      if (consumed) throw Error("Business queue diagnostic already consumed");
      consumed = true;
      const report: BusinessQueueReport = { status: "identity-failed", input: pinned,
        attempts: { bootstrap: 0, preparatoryTree: 0, captureCalls: 0 }, steps: [], cleanup: {} };
      const controller = new AbortController(), signal = controller.signal;
      const cancel = () => controller.abort(parentSignal.reason);
      parentSignal.addEventListener("abort", cancel, { once: true });
      if (parentSignal.aborted) cancel();
      const timer = setTimeout(() => controller.abort(Error("Business queue diagnostic deadline exceeded")), timeoutMs);
      let reader: Device | undefined, capture: Device | undefined;
      try {
        signal.throwIfAborted(); report.attempts.bootstrap++;
        const verified = await readUntilAbort(signal, () => bootstrap.run(signal));
        report.bootstrap = verified; report.steps.push("identity-bootstrap");
        report.status = "observation-failed";
        const actual: ObservationTarget = Object.freeze({ serial: pinned.serial, packageName: pinned.packageName,
          pid: pinned.pid, startTicks: pinned.startTicks, apkPath: pinned.apkPath, aarPath: pinned.aarPath,
          processInstance: verified.processInstance, requestId: randomUUID() });
        report.target = actual;
        // First client is scalar-only; the observation owns the second client and JDWP/log resources.
        reader = createDevice(actual, "reader");
        await reader.prepareCapture(actual, signal); signal.throwIfAborted(); report.steps.push("prepared-reader");
        capture = createDevice(actual, "capture");
        if (reader === capture) throw Error("Independent diagnostic reader/capture adapters required");
        const boundReader = reader, boundCapture = capture;
        const entry = createQueueObservation(actual, { ...boundCapture, ...observation,
          artifacts: async (apk, aar, checkSignal) => {
            const build = await (observation.artifacts ?? verifyLocalQueueBuild)(apk, aar, checkSignal);
            if (build.apkSha256 !== verified.apkSha256 || build.aarSha256 !== verified.aarSha256
              || build.sourceSha256 !== verified.sourceSha256 || build.sdkVersion !== verified.sdkVersion)
              throw Error("Business diagnostic artifacts changed after bootstrap");
            return build;
          },
          installed: async (selected, sha, checkSignal) => {
            const installed = await (observation.installed ?? verifyInstalledQueueApk)(selected, sha, checkSignal);
            if (installed.apkSha256 !== verified.apkSha256 || installed.installedPath !== verified.installedPath)
              throw Error("Business diagnostic installed APK changed after bootstrap");
            return installed;
          },
          runtime: (selected, checkSignal) => boundReader.readRuntime(selected, checkSignal),
          state: (selected, checkSignal) => boundReader.readState(selected, checkSignal),
          captureOnce: async (selected, options, checkSignal) => {
            checkSignal.throwIfAborted();
            if (report.attempts.captureCalls !== 0) throw Error("Business diagnostic capture already issued");
            report.attempts.captureCalls++;
            await boundCapture.captureOnce(selected, options, checkSignal);
          },
        });
        report.steps.push("observation-once");
        report.observation = await entry.run(signal);
        signal.throwIfAborted();
        report.status = report.observation.status; report.error = report.observation.error;
      } catch (error) { report.error = message(error); report.errorDetails = commandFailure(error); }
      finally {
        // Observation.run has already recovered any owned suspension before it returns.
        // Idempotent close also covers setup/constructor failure; never close a shared SDK server.
        clearTimeout(timer);
        controller.abort(Error("Business queue diagnostic finished"));
        for (const [role, adapter] of [["capture", capture], ["reader", reader]] as const) {
          if (!adapter) continue;
          try { await adapter.closeCapture(); report.cleanup[`${role}ConnectionClosed`] = true; }
          catch (error) {
            report.cleanup[`${role}ConnectionClosed`] = false; report.cleanup[`${role}Error`] = message(error);
            report.status = "observation-failed"; report.error ??= `${role} connection cleanup not confirmed`;
          }
        }
        if (parentSignal.aborted) {
          if (report.status !== "identity-failed") report.status = "observation-failed";
          report.error ??= message(parentSignal.reason);
        }
        parentSignal.removeEventListener("abort", cancel);
      }
      return report;
    },
  };
}

export function validateQueueBusinessArgs(args: string[]): QueueBootstrapTarget {
  if (args.length !== 7 || args[6] !== "--run" || !/^[1-9]\d*$/.test(args[2]) || !/^[1-9]\d*$/.test(args[3]))
    throw Error("Usage: bun scripts/diagnostics/sdk/sdk-queue-business-probe.ts SERIAL PACKAGE PID START_TICKS /trusted/app.apk /trusted/sdk.aar --run");
  const target = { serial: args[0], packageName: args[1], pid: Number(args[2]), startTicks: args[3],
    apkPath: args[4], aarPath: args[5] };
  createQueueBusinessProbe(target); // Validation only; does not run or touch files/devices.
  return target;
}

if (import.meta.main) {
  const target = validateQueueBusinessArgs(process.argv.slice(2));
  const entry = createQueueBusinessProbe(target);
  // Refuse an unwritable evidence directory before contacting a device.
  const directory = resolve(".benchmarks"); mkdirSync(directory, { recursive: true });
  const output = mkdtempSync(join(directory, "queue-business-"));
  const controller = new AbortController();
  const cancel = () => controller.abort(Error("Business queue diagnostic cancelled"));
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  try {
    const report = await entry.run(controller.signal);
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, attempts: report.attempts, frames: report.observation?.frames.length ?? 0,
      error: report.error, output }));
    if (report.status !== "queue-covered") process.exitCode = 1;
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
