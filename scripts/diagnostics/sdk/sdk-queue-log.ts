// Explicit diagnostic subscription only; importing this file never starts adb.
import { spawn } from "node:child_process";
import { bindQueueNotice, parseQueueEvent } from "./sdk-queue-observer";
import { createQueueStackGate, type QueueIdentity } from "./sdk-queue-stack-policy";

type LogProcess = Pick<ReturnType<typeof spawn>, "stdout" | "stderr" | "on" | "removeListener" | "kill">;
type Start = (args: string[]) => LogProcess;
const startAdb: Start = args => spawn("adb", args, { stdio: ["ignore", "pipe", "pipe"] });
export class QueueLogCleanupError extends Error {
  constructor() { super("Queue log cleanup not confirmed"); }
}

/** Read one matching queued event. No historical log clearing, retries, or unbounded buffers.
 * Resolves only after child close (not merely exit): pipe handles must be closed too.
 * A cleanup failure is an error, never permission to sample a stack.
 */
export function waitForQueueLog(target: { serial: string; identity: QueueIdentity }, signal: AbortSignal,
  options: { timeoutMs?: number; start?: Start; now?: () => number } = {}): Promise<{ json: string; receivedHostMs: number }> {
  const identity = { ...target.identity }, serial = target.serial;
  createQueueStackGate(identity);
  if (!/^[\w.-]+$/.test(serial)) throw Error("Invalid log target");
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw Error("Invalid log deadline");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = (options.start ?? startAdb)(["-s", serial, "logcat", "-v", "raw",
      `--pid=${identity.pid}`, "-s", "InspectorTreeQueue:D"]);
    let pending = Buffer.alloc(0), bytes = 0, lines = 0, stopping = false, finished = false;
    let selected: { json: string; receivedHostMs: number } | undefined, failure: unknown;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => stop(Error("Queue log deadline exceeded")), timeoutMs);
    const detach = () => {
      clearTimeout(deadline); clearTimeout(cleanupTimer); clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      child.stdout?.removeListener("data", data); child.stderr?.removeListener("data", stderr);
      child.removeListener("close", closed); child.removeListener("error", error);
      pending = Buffer.alloc(0);
    };
    const finish = (err?: unknown) => {
      if (finished) return;
      finished = true; detach();
      if (err) reject(err);
      else if (selected) resolve(selected);
      else reject(Error("Queue log closed before matching event"));
    };
    function stop(err?: unknown) {
      if (finished) return;
      if (err && !failure) failure = err;
      if (stopping) return;
      stopping = true; clearTimeout(deadline);
      // Keep the error listener until close: cancellation and process errors may race.
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); }
        catch { finish(new QueueLogCleanupError()); }
      }, 100);
      cleanupTimer = setTimeout(() => finish(new QueueLogCleanupError()), 500);
      try { child.kill("SIGTERM"); }
      catch (err) { if (!failure) failure = err; }
    }
    const abort = () => stop(signal.reason ?? Error("Queue log cancelled"));
    const error = (err: Error) => stop(err);
    const stderr = () => stop(Error("Queue log reported stderr"));
    const closed = () => finish(failure);
    const data = (chunk: Buffer | string) => {
      if (stopping || finished) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 64 * 1024) { stop(Error("Queue log byte limit exceeded")); return; }
      pending = Buffer.concat([pending, buffer]);
      let end: number;
      while ((end = pending.indexOf(10)) !== -1) {
        const lineBuffer = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        if (++lines > 128 || lineBuffer.length > 2048) { stop(Error("Queue log line limit exceeded")); return; }
        const line = lineBuffer.toString("utf8").replace(/\r$/, "");
        if (!line || /^--------- beginning of (main|system|crash)$/.test(line)) continue;
        try {
          const event = parseQueueEvent(line);
          // Foreign / old request events cannot authorize work and consume bounded budget only.
          if (event.pid !== identity.pid || event.processInstance !== identity.processInstance
            || event.requestId !== identity.requestId || event.phase !== "queued") continue;
          const receivedHostMs = (options.now ?? (() => Math.floor(performance.now())))();
          bindQueueNotice(event, identity, receivedHostMs);
          selected = { json: line, receivedHostMs }; stop(); return;
        } catch { stop(Error("Malformed queue log event")); return; }
      }
      if (pending.length > 2048) stop(Error("Queue log partial line limit exceeded"));
    };
    child.on("close", closed); child.on("error", error);
    child.stdout?.on("data", data); child.stderr?.on("data", stderr);
    signal.addEventListener("abort", abort, { once: true });
    if (!child.stdout || !child.stderr) stop(Error("Queue log pipes unavailable"));
    if (signal.aborted) abort();
  });
}
