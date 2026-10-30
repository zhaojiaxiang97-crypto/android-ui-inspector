// Explicit one-request library entry. No CLI, install, launch, capture, or device I/O on import.
import { createRequire } from "node:module";
import { verifyLocalQueueBuild, readRuntimeSdkBuild } from "./sdk-queue-build";
import { verifyInstalledQueueApk, verifyQueueProcess } from "./sdk-queue-identity";
import { createQueueObserver, readQueueState, type QueueEvent } from "./sdk-queue-observer";
import { waitForQueueLog, QueueLogCleanupError } from "./sdk-queue-log";
import { prepareQueueMain, type StackEvidence, type Frame } from "./sdk-queue-jdwp";
import { validateQueueEvidence } from "./sdk-queue-evidence";
import { createQueueStackGate, type QueueIdentity, type QueueNotice } from "./sdk-queue-stack-policy";

type Client = { ready: Promise<void>; request: Parameters<typeof prepareQueueMain>[0]; close: () => void };
const { createJdwpClient, withOwnedForward } = createRequire(import.meta.url)("../../lib/startup-stack-observer.cjs") as {
  createJdwpClient: (port: number, options: { timeoutMs: number; handshakeMs: number }) => Client;
  withOwnedForward: <T>(work: { open: () => Promise<number>; connect: (port: number) => Client;
    observe: (client: Client) => Promise<T>; remove: (port: number) => Promise<void> }, evidence: object) => Promise<T>;
};
export type ObservationTarget = { serial: string; packageName: string; pid: number; startTicks: string;
  processInstance: string; requestId: string; apkPath: string; aarPath: string };
type CaptureReply = { status: "completed" | "failed"; error?: string };
type SymbolFrame = Frame & { className: string; method: { name: string; signature: string } | null };
export type ObservationReport = {
  status: "observation-failed" | "no-stack" | "queue-covered" | "queue-uncovered";
  steps: string[]; error?: string; identity?: QueueIdentity; frames: Frame[]; symbols?: SymbolFrame[]; symbolError?: string;
  capture?: CaptureReply; captureReplySettled: boolean; logClosed: boolean;
  cleanup: StackEvidence & { forwardRemoved?: boolean; forwardError?: string;
    captureConnectionClosed?: boolean; captureConnectionError?: string };
  deviceBounds?: { startedDeviceMs: number; resumedDeviceMs: number; roundingUpperMs: number };
};
type Dependencies = {
  // Forward adapter must be bounded, own only its returned port, and clean up failed opens itself.
  // Do NOT inject a signal-bound JDWP request: recovery must still run after user cancellation.
  forward: { open: (target: ObservationTarget, signal: AbortSignal) => Promise<number>;
    remove: (port: number) => Promise<void>; connect?: (port: number) => Client };
  // Adapter issues exactly the provided request, opts in to SDK diagnostics, and honors signal.
  // It must not install, restart, navigate, retry or silently substitute a different request.
  captureOnce: (target: ObservationTarget, options: { identity: QueueIdentity; treeQueueDiagnostics: true },
    signal: AbortSignal) => Promise<void>;
  // Optional resource setup runs before the log deadline; its paired close must be bounded/idempotent.
  prepareCapture?: (target: ObservationTarget, signal: AbortSignal) => Promise<void>;
  closeCapture?: () => Promise<void>;
  artifacts?: typeof verifyLocalQueueBuild; installed?: typeof verifyInstalledQueueApk;
  process?: typeof verifyQueueProcess; runtime?: typeof readRuntimeSdkBuild;
  state?: typeof readQueueState; subscribe?: typeof waitForQueueLog; now?: () => number; timeoutMs?: number;
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
class NotAdmitted extends Error {}

/** Abort only read/wait phases; never race the paused sample or its mandatory recovery. */
async function interruptible<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
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

/** Construct a single-use observation. Side effects require an explicit run() plus capture/forward adapters.
 * Read adapters default to actual bounded host/adb implementations, but this module never runs itself.
 */
export function createQueueObservation(target: ObservationTarget, dependencies: Dependencies) {
  const pinned = Object.freeze({ ...target }), deps = { ...dependencies, forward: { ...dependencies.forward } };
  const timeoutMs = deps.timeoutMs ?? 15000;
  if (!/^[\w.-]+$/.test(pinned.serial) || !/^[\w]+(?:\.[\w]+)+$/.test(pinned.packageName)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || Boolean(deps.prepareCapture) !== Boolean(deps.closeCapture)) throw Error("Invalid observation target/budget");
  createQueueStackGate({ ...pinned, apkSha256: "0".repeat(64), sdkVersion: "validation-only" });
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(pinned.processInstance)) throw Error("Invalid SDK instance");
  const now = deps.now ?? (() => Math.floor(performance.now()));
  let attempted = false;
  return {
    async run(parentSignal: AbortSignal): Promise<ObservationReport> {
      if (attempted) throw Error("Queue observation already attempted");
      attempted = true;
      const report: ObservationReport = { status: "observation-failed", steps: [], frames: [], cleanup: {},
        captureReplySettled: true, logClosed: true };
      const controller = new AbortController(), signal = controller.signal;
      const cancel = () => controller.abort(parentSignal.reason);
      parentSignal.addEventListener("abort", cancel, { once: true });
      if (parentSignal.aborted) cancel();
      const timer = setTimeout(() => controller.abort(Error("Queue observation deadline exceeded")), timeoutMs);
      const logController = new AbortController();
      const cancelLog = () => logController.abort(signal.reason);
      signal.addEventListener("abort", cancelLog, { once: true });
      let logDone: Promise<{ value?: { json: string; receivedHostMs: number }; error?: unknown }> | undefined;
      let captureDone: Promise<CaptureReply> | undefined;
      let active = false, noticeReceived = false;
      let finalized = false;
      try {
        const build = await interruptible(signal, () => (deps.artifacts ?? verifyLocalQueueBuild)(pinned.apkPath, pinned.aarPath, signal));
        if (!/^[a-f0-9]{64}$/.test(build.sourceSha256) || !/^[a-f0-9]{64}$/.test(build.aarSha256)
          || build.sdkVersion !== `sdk-source-v1:${build.sourceSha256}`) throw Error("Invalid SDK build admission");
        const identity: QueueIdentity = { apkSha256: build.apkSha256, sdkVersion: build.sdkVersion, pid: pinned.pid,
          startTicks: pinned.startTicks, processInstance: pinned.processInstance, requestId: pinned.requestId };
        createQueueStackGate(identity); report.identity = { ...identity }; report.steps.push("local-build");
        const verifyInstalled = async () => {
          const installed = await interruptible(signal, () => (deps.installed ?? verifyInstalledQueueApk)(pinned, identity.apkSha256, signal));
          if (installed.apkSha256 !== identity.apkSha256) throw Error("Installed APK identity changed");
        };
        const verify = async (checkSignal: AbortSignal) => {
          const process = await interruptible(checkSignal, () => (deps.process ?? verifyQueueProcess)(pinned, checkSignal));
          if (process.pid !== identity.pid || process.startTicks !== identity.startTicks)
            throw Error("Runtime process identity changed");
          const runtime = await interruptible(checkSignal, () => (deps.runtime ?? readRuntimeSdkBuild)(
            { ...pinned, sourceSha256: build.sourceSha256 }, checkSignal));
          if (runtime.pid !== identity.pid || runtime.processInstance !== identity.processInstance
            || runtime.sdkVersion !== identity.sdkVersion) throw Error("Runtime SDK identity changed");
          // Independently proven fields cannot be overwritten by the other reader's reply.
          return { ...identity };
        };
        await verifyInstalled(); await verify(signal); report.steps.push("installed-runtime");
        if (deps.prepareCapture) {
          // Do not race resource setup: it must finish its own bounded cleanup on cancellation.
          await deps.prepareCapture(pinned, signal); signal.throwIfAborted(); report.steps.push("prepared-capture");
        }
        const observer = createQueueObserver({ ...pinned, identity }, { verify, read: deps.state ?? readQueueState, now });
        const observed = await withOwnedForward({
          open: async () => { signal.throwIfAborted(); return deps.forward.open(pinned, signal); },
          connect: port => (deps.forward.connect ?? (port => createJdwpClient(port, { timeoutMs: 200, handshakeMs: 750 })))(port),
          remove: deps.forward.remove,
          observe: async client => {
            const prepared = await prepareQueueMain(client.request, signal, now); report.steps.push("prepared-main");
            signal.throwIfAborted();
            // Subscription is created before scheduling the one authorized capture callback.
            report.logClosed = false;
            logDone = (deps.subscribe ?? waitForQueueLog)({ ...pinned, identity }, logController.signal, { now })
              .then(value => { noticeReceived = true; return { value }; }, error => ({ error }));
            active = true; report.captureReplySettled = false;
            captureDone = Promise.resolve().then(() => {
              signal.throwIfAborted();
              return deps.captureOnce(pinned, { identity: Object.freeze({ ...identity }), treeQueueDiagnostics: true }, signal);
            }).then((): CaptureReply => ({ status: "completed" }), error => ({ status: "failed" as const, error: message(error) }))
              .then(reply => {
                active = false;
                if (!finalized) { report.capture = reply; report.captureReplySettled = true; }
                if (!noticeReceived) logController.abort(new NotAdmitted("Request ended before queued notice"));
                return reply;
              });
            report.steps.push("capture-once");
            const log = await interruptible(signal, () => logDone!);
            if (!log.value) throw log.error;
            report.logClosed = true; report.steps.push("queued-notice");
            let before: QueueEvent | undefined, notice: QueueNotice | undefined;
            report.frames = await prepared.sample(identity, async () => {
              const result = await observer.prepare(log.value!.json, signal, () => active, log.value!.receivedHostMs);
              if (result.status !== "sample-reserved" || !("notice" in result) || !result.notice || !result.state)
                throw new NotAdmitted(`Queue observation refused: ${result.status}`);
              before = result.state; notice = result.notice; report.steps.push("fresh-before");
              return notice;
            }, () => active, report.cleanup);
            report.steps.push("resumed");
            // Immediately bracket recovery. Do not decode symbols, wait for capture, or hash APK first.
            const after = await interruptible(signal, () => (deps.state ?? readQueueState)({ ...pinned, identity }, signal));
            report.steps.push("state-after-resume");
            report.capture = await interruptible(signal, () => captureDone!); report.steps.push("capture-reply");
            const final = await interruptible(signal, () => (deps.state ?? readQueueState)({ ...pinned, identity }, signal));
            await verifyInstalled(); const verifiedAfter = await verify(signal); report.steps.push("final-identity");
            try { report.symbols = await prepared.resolveFrames(); }
            catch (error) { report.symbolError = message(error); }
            signal.throwIfAborted();
            if (!before || !notice) throw Error("Missing pre-suspend state");
            return { before, notice, after, final, verifiedAfter };
          },
        }, report.cleanup);
        signal.throwIfAborted(); report.steps.push("connection-cleaned");
        const result = validateQueueEvidence(identity, observed.notice, observed.before, observed.after, observed.final,
          observed.verifiedAfter, { resumeVerified: report.cleanup.resumeVerified === true,
            forwardRemoved: report.cleanup.forwardRemoved === true, frames: report.frames.length });
        report.status = result.status;
        report.deviceBounds = { startedDeviceMs: result.startedDeviceMs,
          resumedDeviceMs: result.resumedDeviceMs, roundingUpperMs: result.roundingUpperMs };
      } catch (error) {
        report.error = message(error); report.status = error instanceof NotAdmitted ? "no-stack" : "observation-failed";
      } finally {
        // Never reached until paused sample has completed recovery (success or bounded failure).
        controller.abort(Error("Queue observation finished")); logController.abort(signal.reason);
        if (deps.closeCapture) {
          try { await deps.closeCapture(); report.cleanup.captureConnectionClosed = true; }
          catch (error) {
            report.cleanup.captureConnectionClosed = false; report.cleanup.captureConnectionError = message(error);
            report.error = "Capture connection cleanup not confirmed"; report.status = "observation-failed";
          }
        }
        if (logDone) {
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const log = await Promise.race([logDone, new Promise<undefined>(resolve => {
              cleanupTimer = setTimeout(() => resolve(undefined), 600);
            })]);
            report.logClosed = Boolean(log) && !(log?.error instanceof QueueLogCleanupError);
            if (!report.logClosed) { report.error = "Queue log cleanup not confirmed"; report.status = "observation-failed"; }
          } finally { clearTimeout(cleanupTimer); }
        }
        if (captureDone && !report.captureReplySettled) {
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const reply = await Promise.race([captureDone, new Promise<undefined>(resolve => {
              cleanupTimer = setTimeout(() => resolve(undefined), 500);
            })]);
            if (reply) { report.capture = reply; report.captureReplySettled = true; }
            else { report.error = "Capture reply cleanup not confirmed"; report.status = "observation-failed"; }
          } finally { clearTimeout(cleanupTimer); }
        }
        clearTimeout(timer); signal.removeEventListener("abort", cancelLog); parentSignal.removeEventListener("abort", cancel);
        finalized = true;
      }
      return report;
    },
  };
}
