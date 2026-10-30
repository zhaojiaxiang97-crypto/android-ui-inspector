// Explicit local diagnostic library. No default adb executor, launch, SDK fallback or CLI.
import { createRequire } from "node:module";
import { createStartupWindowAdmission, parseStartupActivity, parseStartupWindows,
  type StartupAdmissionTarget, type StartupLaunchOrigin, type StartupReadExecute } from "./startup-window-admission";
import { verifyInstalledQueueApk, verifyQueueProcess } from "../sdk/sdk-queue-identity";
import { openOwnedDebugForward, reserveOwnedForwardPort, type OwnedDebugForward } from "../../../electron/platform/owned-debug-forward";
import { prepareMainStack, type Frame, type StackEvidence } from "../../jdwp-main-stack";

export type JdwpTransportEvidence = {
  clock: "host-monotonic-relative-ms"; startedAt: string; eventLimit: 64; lastSequence: number;
  droppedEvents: number; socketClosed: boolean;
  milestones: { connectedAtMs?: number; handshakeQueuedAtMs?: number; handshakeFlushedAtMs?: number;
    handshakeReceivedAtMs?: number; socketClosedAtMs?: number };
  firstRequest?: { id: number; set: number; command: number; budgetMs: number; createdAtMs: number;
    queuedAtMs?: number; queuedBytes?: number; backpressure?: boolean; flushedAtMs?: number; flushedBytes?: number;
    writeErrorAtMs?: number; outcome?: "reply-received" | "request-timeout" | "request-cancelled" | "request-failed" | "request-rejected";
    outcomeAtMs?: number; outcomeReason?: string; replyBytes?: number; errorCode?: number;
    lateReplyAtMs?: number; lateReplyBytes?: number; lateReplyErrorCode?: number };
  events: { seq: number; atMs: number; event: string; id?: number; set?: number; command?: number;
    bytes?: number; budgetMs?: number; reason?: string; errorCode?: number; flags?: number;
    backpressure?: boolean; hadError?: boolean }[];
};
type Client = { ready: Promise<void>; closed: Promise<void>; close: () => void;
  diagnostics: () => JdwpTransportEvidence | undefined;
  request: (set: number, command: number, data: Buffer | undefined,
    options: { timeoutMs: number; signal?: AbortSignal; onSend?: () => void }) => Promise<Buffer> };
const { createJdwpClient } = createRequire(import.meta.url)("../../lib/startup-stack-observer.cjs") as {
  createJdwpClient: (port: number, options: { timeoutMs: number; handshakeMs: number; diagnostics?: boolean }) => Client;
};
type Dependencies = { execute: StartupReadExecute; now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>; choosePort?: () => Promise<number> };
type SymbolFrame = Frame & { className: string; method: { name: string; signature: string } | null };
export type StartupStackReport = {
  runId: string; status: "stack-collected" | "no-stack" | "observation-failed";
  reason?: string; steps: string[]; errors: { phase: string; message: string }[];
  frames: Frame[]; rawFramesReplyHex?: string; symbols?: SymbolFrame[]; symbolError?: string;
  finalIdentityVerified: boolean; finalMainWindow?: boolean;
  transport?: JdwpTransportEvidence & { runId: string; connectionStartedAfterLaunchMs: number };
  cleanup: StackEvidence & { socketClosed?: boolean; forwardRemoved?: boolean; forwardCommandsSettled?: boolean;
    recoveryMs?: number; cleanupMs?: number };
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
class NoStack extends Error {}

/** Bound waits and abort the command's own signal; late replies cannot advance this run.
 * Executors must honor that signal, kill/join their subprocess, and reject nonzero exits.
 * Never race the whole suspended transaction: it must finish its separate recovery first.
 */
async function bounded<T>(timeout: number, work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  parent?.throwIfAborted();
  if (!Number.isFinite(timeout) || timeout <= 0) throw Error("Startup phase deadline exceeded");
  const controller = new AbortController(), cancel = () => controller.abort(parent!.reason);
  parent?.addEventListener("abort", cancel, { once: true });
  let rejectStop: (reason: unknown) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  const abort = () => rejectStop(controller.signal.reason);
  controller.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(Error("Startup phase deadline exceeded")), timeout);
  try { return await Promise.race([work(controller.signal), stopped]); }
  finally {
    clearTimeout(timer); parent?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", abort);
  }
}

/** One explicit run against a caller-authorized SAME launch's monotonic origin. This does not
 * prove authorization or perform the launch; the eventual driver must bind both to human intent.
 * 18s operation from launch; window gate remains 15s. Recovery 1s and cleanup 3s are separate.
 */
export function createStartupStackObservation(target: StartupAdmissionTarget, launch: StartupLaunchOrigin, dependencies: Dependencies) {
  const pinned = Object.freeze({ ...target }), origin = Object.freeze({ ...launch }), deps = { ...dependencies };
  const clock = deps.now ?? (() => performance.now());
  // Validate without I/O; use the real gate, never a fabricated SDK queue notice/instance.
  createStartupWindowAdmission(pinned, origin, { execute: deps.execute, now: clock });
  let used = false, last = origin.startedAt;
  const now = () => {
    const value = clock();
    if (!Number.isFinite(value) || value < last) throw Error("Startup monotonic clock changed");
    last = value; return value;
  };
  return {
    async run(parent: AbortSignal): Promise<StartupStackReport> {
      if (used) throw Error("Startup stack observation already consumed");
      used = true;
      const report: StartupStackReport = { runId: origin.runId, status: "observation-failed", steps: [], errors: [],
        frames: [], finalIdentityVerified: false, cleanup: {} };
      const controller = new AbortController(), signal = controller.signal;
      const cancel = () => controller.abort(parent.reason);
      parent.addEventListener("abort", cancel, { once: true }); if (parent.aborted) cancel();
      let timer: ReturnType<typeof setTimeout> | undefined, forward: OwnedDebugForward | undefined, client: Client | undefined;
      let candidate: Awaited<ReturnType<ReturnType<typeof createStartupWindowAdmission>["run"]>> | undefined;
      let prepared: Awaited<ReturnType<typeof prepareMainStack>> | undefined;
      let recoveryStarted: number | undefined, cleanupStarted: number | undefined;
      let resourceInFlight = 0;
      let connectionStartedAfterLaunchMs: number | undefined;
      let phase = "admission", noStack: string | undefined;
      const beginCleanup = () => { cleanupStarted ??= performance.now(); };
      const error = (at: string, failure: unknown) => report.errors.push({ phase: at, message: message(failure) });
      const remaining = () => {
        signal.throwIfAborted();
        const ms = origin.startedAt + 18000 - now();
        if (ms <= 0) throw Error("Startup operation deadline exceeded");
        return ms;
      };
      const execute: StartupReadExecute = async (args, timeout) => {
        const value = await bounded(Math.min(timeout, remaining()), check => deps.execute(args, Math.min(timeout, remaining()), check), signal);
        remaining();
        if (!Buffer.isBuffer(value) || value.length > 2 * 1024 * 1024) throw Error("Invalid startup command reply");
        return value;
      };
      const read = async (args: string[]) => (await execute(["-s", pinned.serial, "shell", ...args], 750, signal)).toString();
      const finalVerify = async () => {
        const installed = await verifyInstalledQueueApk(pinned, pinned.apkSha256, signal, execute);
        if (installed.installedPath !== candidate!.installedPath) throw Error("Final startup APK path changed");
        await verifyQueueProcess(pinned, signal, execute);
        const owner = parseStartupActivity(await read(["dumpsys", "activity", "activities"]), pinned);
        if (owner.activityRecord !== candidate!.owner.activityRecord) throw Error("Final startup Activity changed");
        const windows = await read(["dumpsys", "window", "windows"]), displays = await read(["dumpsys", "window", "displays"]);
        const state = parseStartupWindows(windows, displays, pinned, owner);
        const after = parseStartupActivity(await read(["dumpsys", "activity", "activities"]), pinned);
        if (after.activityRecord !== owner.activityRecord) throw Error("Final startup Activity changed");
        await verifyQueueProcess(pinned, signal, execute);
        if ((await read(["pm", "path", pinned.packageName])).trim() !== `package:${installed.installedPath}`)
          throw Error("Final startup APK path changed");
        report.finalMainWindow = state.mainWindow; report.finalIdentityVerified = true; report.steps.push("final-identity");
      };
      try {
        timer = setTimeout(() => controller.abort(Error("Startup operation deadline exceeded")), remaining());
        const admission = createStartupWindowAdmission(pinned, origin, { execute, now, wait: deps.wait });
        candidate = await admission.run(signal); report.steps.push("startup-admitted");
        if (candidate.status === "window-ready") throw new NoStack("Main window already registered");
        phase = "forward";
        forward = await openOwnedDebugForward(pinned.serial, `jdwp:${pinned.pid}`, signal, async (args, timeout) => {
          // A timed-out command that has not joined can still mutate a mapping later. An empty
          // list before that completion is not proof of cleanup; refuse follow-up mutations.
          if (resourceInFlight) throw Error("Previous forward command completion unconfirmed");
          const budget = Math.min(timeout, cleanupStarted === undefined ? remaining() : cleanupStarted + 3000 - performance.now());
          const reply = await bounded(budget, check => {
            resourceInFlight++;
            return Promise.resolve().then(() => deps.execute(args, budget, check)).finally(() => { resourceInFlight--; });
          });
          if (!Buffer.isBuffer(reply) || reply.length > 8192) throw Error("Invalid startup forward reply");
          return reply.toString();
        }, () => bounded(Math.min(500, remaining()), () => (deps.choosePort ?? reserveOwnedForwardPort)()), {
          onCleanupStart: beginCleanup,
          onCleanupEnd: failure => {
            report.cleanup.forwardRemoved = failure === undefined;
            if (failure !== undefined) error("forward-cleanup", failure);
          },
        });
        report.steps.push("owned-forward"); remaining(); phase = "connection";
        connectionStartedAfterLaunchMs = now() - origin.startedAt;
        client = createJdwpClient(forward.port, { timeoutMs: 200, handshakeMs: Math.min(750, remaining()), diagnostics: true });
        try { await bounded(Math.min(750, remaining()), () => client!.ready, signal); }
        catch (failure) { signal.throwIfAborted(); throw new NoStack(`JDWP unavailable: ${message(failure)}`); }
        let preparationDeadline: number | undefined, firstPreparationRequest = true;
        const request: Parameters<typeof prepareMainStack>[0] = async (set, command, data) => {
          const preparing = phase === "prepare-main";
          // Only the first unsuspended startup IDSizes read gets 500ms. Never inherit this
          // allowance for later reads, Suspend/Resume, symbols or the shared SDK adapter.
          const firstIdsizes = preparing && firstPreparationRequest && set === 1 && command === 7;
          if (preparing) firstPreparationRequest = false;
          const suspending = set === 11 && command === 2;
          if (suspending) report.cleanup.suspendSent = false;
          if (set === 11 && command === 3) recoveryStarted ??= performance.now();
          const restoring = recoveryStarted !== undefined;
          const budget = Math.min(firstIdsizes ? 500 : 200,
            restoring ? recoveryStarted! + 1000 - performance.now() : remaining(),
            preparing ? preparationDeadline! - now() : Infinity);
          if (budget <= 0) throw Error(preparing ? "JDWP preparation deadline exceeded"
            : restoring ? "Startup recovery deadline exceeded" : "Startup operation deadline exceeded");
          const reply = await client!.request(set, command, data, { timeoutMs: budget, signal: restoring ? undefined : signal,
            onSend: suspending ? () => { report.cleanup.suspendSent = true; } : undefined });
          if (set === 11 && command === 6 && reply.length <= 4 + 32 * 33)
            report.rawFramesReplyHex = reply.toString("hex"); // Preserve even if cancellation/recovery rejects later.
          if (restoring) {
            if (performance.now() >= recoveryStarted! + 1000) throw Error("Startup recovery deadline exceeded");
          } else remaining();
          if (preparing && now() >= preparationDeadline!) throw Error("JDWP preparation deadline exceeded");
          return reply;
        };
        phase = "prepare-main"; preparationDeadline = now() + 3000;
        prepared = await prepareMainStack(request, signal, now); report.steps.push("prepared-main");
        phase = "sample";
        await prepared.sample(async () => {
          const fresh = await admission.recheckBeforeSample(signal); remaining();
          if (fresh.status === "window-ready") throw new NoStack("Main window registered before suspend");
          report.steps.push("fresh-before-suspend");
        }, report.cleanup);
        report.steps.push("resume-verified");
        // Recovery mode ends before normal read-only symbol work; cancellation remains in force.
        if (recoveryStarted !== undefined) report.cleanup.recoveryMs = performance.now() - recoveryStarted;
        recoveryStarted = undefined;
      } catch (failure) {
        if (failure instanceof NoStack) noStack = failure.message;
        else error(phase, failure);
      } finally {
        report.frames = prepared?.rawFrames() ?? [];
        if (recoveryStarted !== undefined) report.cleanup.recoveryMs = performance.now() - recoveryStarted;
        // Independently record final identity failure, never overwrite the original frame/recovery failure.
        if (candidate) {
          try { await finalVerify(); } catch (failure) { error("final-identity", failure); }
        }
        if (prepared && report.cleanup.resumeVerified === true && report.finalIdentityVerified && !report.errors.length) {
          try { report.symbols = await prepared.resolveFrames(); }
          catch (failure) { report.symbolError = message(failure); }
          try { remaining(); } catch (failure) { error("symbols", failure); }
        }
        beginCleanup(); controller.abort(Error("Startup observation finished"));
        clearTimeout(timer); parent.removeEventListener("abort", cancel);
        if (client) {
          try {
            client.close(); await bounded(cleanupStarted! + 3000 - performance.now(), () => client!.closed);
            report.cleanup.socketClosed = true;
          } catch (failure) { report.cleanup.socketClosed = false; error("socket-cleanup", failure); }
        }
        if (forward) {
          try { await forward.close(); report.cleanup.forwardRemoved = true; }
          catch { report.cleanup.forwardRemoved = false; } // The ownership adapter already recorded its exact failure.
        }
        report.cleanup.forwardCommandsSettled = resourceInFlight === 0;
        report.cleanup.cleanupMs = performance.now() - cleanupStarted!;
        const transport = client?.diagnostics();
        if (transport) report.transport = { ...transport, runId: origin.runId,
          connectionStartedAfterLaunchMs: connectionStartedAfterLaunchMs! };
      }
      if (report.errors.length) report.status = "observation-failed";
      else if (report.cleanup.resumeVerified && report.frames.length && report.finalIdentityVerified
        && report.cleanup.socketClosed && report.cleanup.forwardRemoved) report.status = "stack-collected";
      else { report.status = "no-stack"; report.reason = noStack ?? "No verified sample"; }
      return report;
    },
  };
}
