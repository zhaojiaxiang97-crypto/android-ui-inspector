// Diagnostic adapters only. Importing this module never contacts a device or takes a stack.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createQueueStackGate, type QueueIdentity, type QueueNotice } from "./sdk-queue-stack-policy";

export type QueueEvent = {
  event: "tree-queue"; protocol: "tree-queue-v1"; phase: "queued" | "entered" | "settled" | "state";
  requestId: string; kind: "classic" | "merged"; pid: number; processInstance: string;
  postedMs: number; enteredMs: number; endedMs: number; settledMs: number; observedMs: number;
};
const fields = ["event", "protocol", "phase", "requestId", "kind", "pid", "processInstance",
  "postedMs", "enteredMs", "endedMs", "settledMs", "observedMs"];
const time = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

export function parseQueueEvent(json: string): QueueEvent {
  if (typeof json !== "string" || Buffer.byteLength(json) > 2048) throw Error("Invalid queue event size");
  const e = JSON.parse(json) as QueueEvent;
  if (!e || Array.isArray(e) || Object.keys(e).length !== fields.length || !fields.every(k => Object.prototype.hasOwnProperty.call(e, k))
    || e.event !== "tree-queue" || e.protocol !== "tree-queue-v1"
    || !["queued", "entered", "settled", "state"].includes(e.phase)
    || !["classic", "merged"].includes(e.kind) || !Number.isSafeInteger(e.pid) || e.pid <= 0
    || typeof e.processInstance !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(e.processInstance)
    || typeof e.requestId !== "string" || !(e.kind === "classic"
      ? /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(e.requestId) : /^[a-f0-9]{16}$/.test(e.requestId))
    || !time(e.postedMs) || !time(e.observedMs) || e.observedMs < e.postedMs
    || ![e.enteredMs, e.endedMs, e.settledMs].every(n => n === -1 || time(n) && n >= e.postedMs && n <= e.observedMs)
    || e.endedMs !== -1 && (e.enteredMs === -1 || e.endedMs < e.enteredMs)
    || e.settledMs !== -1 && (e.enteredMs > e.settledMs || e.endedMs > e.settledMs)
    || e.phase === "queued" && [e.enteredMs, e.endedMs, e.settledMs].some(n => n !== -1)
    || e.phase === "entered" && (e.enteredMs === -1 || e.endedMs !== -1 || e.settledMs !== -1)
    || e.phase === "settled" && e.settledMs === -1) throw Error("Invalid queue event fields");
  return e;
}

/** Consume raw JSON from `adb logcat -v raw -s InspectorTreeQueue:D`; no heuristic prefix stripping. */
export function bindQueueNotice(event: QueueEvent, expected: QueueIdentity, receivedHostMs: number): QueueNotice {
  if (event.requestId !== expected.requestId || event.pid !== expected.pid || event.processInstance !== expected.processInstance
    || !time(receivedHostMs)) throw Error("Queue event identity mismatch");
  // APK, SDK build and startTicks are verified externally, never asserted by a log message.
  return { identity: { ...expected }, postedMs: event.postedMs, observedMs: event.observedMs,
    enteredMs: event.enteredMs, settledMs: event.settledMs, receivedHostMs };
}

export function parseQueueStateReply(stdout: string): QueueEvent {
  if (Buffer.byteLength(stdout) > 4096) throw Error("Invalid queue state reply size");
  const reply = /^Result: Bundle\[\{(?:result=ok, diagnostic=(\{[^\r\n]*\})|diagnostic=(\{[^\r\n]*\}), result=ok)\}\]$/.exec(stdout.trim());
  if (!reply) throw Error("Queue state refused or unsupported");
  const state = parseQueueEvent(reply[1] ?? reply[2]);
  if (state.phase !== "state") throw Error("Expected fresh queue state");
  return state;
}

type Execute = (args: string[], timeoutMs: number, signal: AbortSignal) => Promise<string>;
const executeAdb: Execute = async (args, timeout, signal) =>
  (await promisify(execFile)("adb", args, { timeout, signal, encoding: "utf8", maxBuffer: 4096 })).stdout;

/** A misbehaving injected reader still cannot keep preparation alive or publish late results. */
async function bounded<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(Error("Queue preparation exceeded 1000ms")), 1000);
  try { return await Promise.race([work(controller.signal), stopped]); }
  finally {
    clearTimeout(timer); signal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", abort);
  }
}

/** Separate content CLI, never the pending SDK capture socket. One bounded call, no retry. */
export async function readQueueState(target: { serial: string; packageName: string; identity: QueueIdentity },
  signal: AbortSignal, execute: Execute = executeAdb): Promise<QueueEvent> {
  target = { ...target, identity: { ...target.identity } };
  createQueueStackGate(target.identity); // Validate complete, pre-verified host identity before issuing anything.
  if (!/^[\w.-]+$/.test(target.serial) || !/^[\w]+(?:\.[\w]+)+$/.test(target.packageName)
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(target.identity.processInstance))
    throw Error("Invalid diagnostic target");
  signal.throwIfAborted();
  const output = await execute(["-s", target.serial, "shell", "content", "call", "--uri",
    `content://${target.packageName}.inspector`, "--method", "read-tree-task", "--arg", target.identity.requestId,
    "--extra", `processInstance:s:${target.identity.processInstance}`], 750, signal);
  signal.throwIfAborted();
  const state = parseQueueStateReply(output);
  bindQueueNotice(state, target.identity, 0);
  return state;
}

/** Local one-shot preparation. This does not attach, suspend or read frames. */
export function createQueueObserver(target: { serial: string; packageName: string; identity: QueueIdentity },
  dependencies: { read: typeof readQueueState; verify: (signal: AbortSignal) => Promise<QueueIdentity>; now: () => number }) {
  const identity = { ...target.identity }, pinned = { ...target, identity };
  createQueueStackGate(identity);
  let attempted = false;
  return {
    async prepare(json: string, signal: AbortSignal, requestActive: () => boolean, receivedHostMs?: number) {
      signal.throwIfAborted();
      if (attempted) return { status: "already-attempted" as const };
      // Subscription cleanup must not refresh an already received notice's age.
      const event = parseQueueEvent(json), received = receivedHostMs ?? dependencies.now();
      const notice = bindQueueNotice(event, identity, received);
      if (event.phase !== "queued") return { status: "not-queued" as const };
      const initial = createQueueStackGate(identity).reserve(notice, dependencies.now(), requestActive());
      if (initial !== "sample-reserved") return { status: initial };
      attempted = true; // Includes a failed identity check/query; never restart preparation.
      return bounded(signal, async signal => {
        const verified = await dependencies.verify(signal);
        signal.throwIfAborted();
        createQueueStackGate(verified);
        if ((["apkSha256", "sdkVersion", "pid", "startTicks", "processInstance", "requestId"] as const)
          .some(key => verified[key] !== identity[key])) throw Error("Process or build identity changed");
        if (!requestActive()) return { status: "request-ended" as const };
        if (dependencies.now() - received > 250) return { status: "stale-notice" as const };
        const queryStarted = dependencies.now();
        const state = parseQueueEvent(JSON.stringify(await dependencies.read(pinned, signal)));
        signal.throwIfAborted();
        if (state.phase !== "state") throw Error("Expected fresh queue state");
        const fresh = bindQueueNotice(state, verified, queryStarted);
        if (state.kind !== event.kind || state.postedMs !== event.postedMs || state.observedMs < event.observedMs)
          throw Error("Queue task changed");
        const status = createQueueStackGate(identity).reserve(fresh, dependencies.now(), requestActive());
        return { status, ...(status === "sample-reserved" ? { notice: fresh, state } : {}) };
      });
    },
  };
}
