// Explicit adapters only. No adb, sockets, capture, install or launch on import/construction.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createConnection, type Socket } from "node:net";
import { openOwnedDebugForward, reserveOwnedForwardPort, type ForwardExecute, type OwnedDebugForward } from "../../../electron/platform/owned-debug-forward";
import { receiveProviderSessionLine, requestProviderSession, type ProviderWaiter } from "../../../electron/sdk/provider-session-request";
import type { ObservationTarget, createQueueObservation } from "./sdk-queue-observation";
import { createQueueStackGate } from "./sdk-queue-stack-policy";
import { parseRuntimeSdkBuild, type readRuntimeSdkBuild } from "./sdk-queue-build";
import { bindQueueNotice, parseQueueStateReply, type readQueueState } from "./sdk-queue-observer";

type Adapters = Required<Pick<Parameters<typeof createQueueObservation>[1], "forward" | "captureOnce" | "prepareCapture" | "closeCapture">>
  & { readRuntime: typeof readRuntimeSdkBuild; readState: typeof readQueueState };
export type QueueDeviceExecute = ForwardExecute;
const executeAdb: QueueDeviceExecute = async (args, timeout, signal) =>
  (await promisify(execFile)("adb", args, { timeout, signal, encoding: "utf8", maxBuffer: 8192 })).stdout;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

function bundle(reply: string) {
  if (typeof reply !== "string" || Buffer.byteLength(reply) > 8192) throw Error("SDK reply limit exceeded");
  const match = /^Result: Bundle\[\{([^\r\n]*)\}\]$/.exec(reply.trim());
  if (!match) throw Error("Invalid SDK reply");
  if (/(?:^|, )error=/.test(match[1])) throw Error(`SDK request failed: ${match[1].slice(0, 300)}`);
  const entries = match[1].split(", ").map(value => {
    const at = value.indexOf("="); if (at <= 0) throw Error("Invalid SDK reply field");
    return [value.slice(0, at), value.slice(at + 1)];
  });
  const value = Object.fromEntries(entries);
  if (Object.keys(value).length !== entries.length || value.result !== "ok") throw Error("SDK request not accepted");
  return value;
}

/** Reuses the existing SDK line request dispatcher, but owns its socket/forward and never falls back. */
async function openCaptureSession(port: number, signal: AbortSignal, connect: (port: number) => Socket) {
  signal.throwIfAborted();
  const socket = connect(port);
  socket.setNoDelay(true);
  const session = { socket, pending: [] as ProviderWaiter[], lastUsedAt: 0 };
  let buffer = Buffer.alloc(0), bytes = 0, lines = 0, closed = false;
  const fail = (error: Error) => {
    for (const waiter of session.pending.splice(0)) waiter.reject(error);
    socket.destroy();
  };
  socket.on("error", fail);
  socket.on("close", () => { closed = true; fail(Error("Diagnostic SDK socket closed")); });
  socket.on("data", data => {
    bytes += data.length;
    if (bytes > 64 * 1024) { fail(Error("Diagnostic SDK byte limit exceeded")); return; }
    buffer = Buffer.concat([buffer, data]);
    let at: number;
    while ((at = buffer.indexOf(10)) !== -1) {
      if (++lines > 16 || at > 8192) { fail(Error("Diagnostic SDK line limit exceeded")); return; }
      const line = buffer.subarray(0, at).toString("utf8").replace(/\r$/, ""); buffer = buffer.subarray(at + 1);
      if (!session.pending.length || line.startsWith("Event: ")) { fail(Error("Unexpected diagnostic SDK line")); return; }
      receiveProviderSessionLine(session, line);
    }
    if (buffer.length > 8192) fail(Error("Diagnostic SDK partial line limit exceeded"));
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>((resolve, reject) => {
    if (closed) { resolve(); return; }
    const finished = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { socket.off("close", finished); reject(Error("Diagnostic SDK socket cleanup not confirmed")); }, 250);
    socket.once("close", finished); fail(Error("Diagnostic SDK connection finished")); buffer = Buffer.alloc(0);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer); signal.removeEventListener("abort", aborted);
        socket.off("connect", connected); socket.off("error", failed); socket.off("close", closed);
        if (error) reject(error); else resolve();
      };
      const connected = () => finish(), failed = (error: Error) => finish(error);
      const closed = () => finish(Error("Diagnostic SDK connection closed before ready"));
      const aborted = () => finish(signal.reason ?? Error("Diagnostic SDK connection cancelled"));
      const timer = setTimeout(() => finish(Error("Diagnostic SDK connection deadline exceeded")), 500);
      socket.once("connect", connected); socket.once("error", failed); socket.once("close", closed);
      signal.addEventListener("abort", aborted, { once: true }); if (signal.aborted) aborted();
    });
    const probe = await requestProviderSession(session, { method: "session-probe", arg: null, extras: {} }, 500, signal);
    if (probe !== "Result: Bundle[{error=Unknown session method}]" || socket.destroyed) throw Error("Diagnostic SDK probe rejected");
    return { session, close };
  } catch (error) { await close(); throw error; }
}

export function createQueueDeviceAdapters(target: ObservationTarget, options: {
  execute?: QueueDeviceExecute; choosePort?: () => Promise<number>; connect?: (port: number) => Socket;
  captureTimeoutMs?: number;
} = {}): Adapters {
  const pinned = Object.freeze({ ...target }), execute = options.execute ?? executeAdb;
  const choosePort = options.choosePort ?? reserveOwnedForwardPort;
  const connect = options.connect ?? (port => createConnection({ host: "127.0.0.1", port }));
  const captureTimeoutMs = options.captureTimeoutMs ?? 5000;
  if (!/^[\w.-]+$/.test(pinned.serial) || !/^[\w]+(?:\.[\w]+)+$/.test(pinned.packageName)
    || !Number.isSafeInteger(pinned.pid) || pinned.pid <= 0 || !/^\d+$/.test(pinned.startTicks)
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(pinned.processInstance)
    || !(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(pinned.requestId) || /^[a-f0-9]{16}$/.test(pinned.requestId))
    || !Number.isSafeInteger(captureTimeoutMs) || captureTimeoutMs < 1 || captureTimeoutMs > 10000)
    throw Error("Invalid diagnostic device target/budget");
  const check = (actual: ObservationTarget) => {
    if ((Object.keys(pinned) as (keyof ObservationTarget)[]).some(key => actual[key] !== pinned[key]))
      throw Error("Diagnostic device target changed");
  };
  let jdwp: OwnedDebugForward | undefined, sdk: OwnedDebugForward | undefined;
  let connection: Awaited<ReturnType<typeof openCaptureSession>> | undefined;
  let forwardAttempted = false, prepareAttempted = false, captureAttempted = false;
  let readPending = false, readerUsed = false;
  const closeCapture = async () => {
    let failed = false, failure: unknown;
    try { await connection?.close(); } catch (error) { failed = true; failure = error; }
    if (sdk) await sdk.close();
    if (failed) throw failure;
  };
  // Use a separate, already-prepared adapter. The protocol has FIFO replies, not request IDs.
  // A failed read retires this socket/forward, so a late reply cannot validate another read.
  const diagnosticRead = async <T>(method: string, arg: string | null, signal: AbortSignal, parse: (reply: string) => T) => {
    if (captureAttempted) throw Error("Diagnostic read requires an independent SDK connection");
    if (readPending) throw Error("Diagnostic read already pending");
    if (!connection || !sdk || connection.session.socket.destroyed) throw Error("Diagnostic SDK not prepared");
    readPending = true; readerUsed = true;
    try {
      signal.throwIfAborted();
      const reply = await requestProviderSession(connection.session,
        { method, arg, extras: { processInstance: pinned.processInstance } }, 750, signal);
      signal.throwIfAborted();
      if (connection.session.socket.destroyed) throw Error("Diagnostic SDK reply integrity lost");
      return parse(reply);
    } catch (error) {
      try { await closeCapture(); } catch (cleanup) { throw Error(`${errorText(error)}; ${errorText(cleanup)}`); }
      throw error;
    } finally { readPending = false; }
  };
  return {
    readRuntime: async (actual, signal) => {
      if (actual.serial !== pinned.serial || actual.packageName !== pinned.packageName || actual.pid !== pinned.pid
        || actual.processInstance !== pinned.processInstance || !/^[a-f0-9]{64}$/.test(actual.sourceSha256))
        throw Error("Diagnostic runtime target changed");
      const expected = { ...actual };
      return diagnosticRead("read-sdk-build", null, signal, reply => parseRuntimeSdkBuild(reply, expected));
    },
    readState: async (actual, signal) => {
      const identity = { ...actual.identity };
      createQueueStackGate(identity);
      if (actual.serial !== pinned.serial || actual.packageName !== pinned.packageName || identity.pid !== pinned.pid
        || identity.startTicks !== pinned.startTicks || identity.processInstance !== pinned.processInstance
        || identity.requestId !== pinned.requestId || !/^sdk-source-v1:[a-f0-9]{64}$/.test(identity.sdkVersion))
        throw Error("Diagnostic state target changed");
      return diagnosticRead("read-tree-task", pinned.requestId, signal, reply => {
        const state = parseQueueStateReply(reply);
        bindQueueNotice(state, identity, 0);
        if (state.kind !== (pinned.requestId.length === 16 ? "merged" : "classic")) throw Error("Queue task kind changed");
        return state;
      });
    },
    forward: {
      open: async (actual, signal) => {
        check(actual); if (forwardAttempted) throw Error("Diagnostic forward already attempted"); forwardAttempted = true;
        jdwp = await openOwnedDebugForward(pinned.serial, `jdwp:${pinned.pid}`, signal, execute, choosePort);
        return jdwp.port;
      },
      remove: async port => {
        if (!jdwp || port !== jdwp.port) throw Error("Refusing unowned diagnostic forward removal");
        await jdwp.close();
      },
    },
    prepareCapture: async (actual, signal) => {
      check(actual); if (prepareAttempted) throw Error("Diagnostic SDK preparation already attempted"); prepareAttempted = true;
      signal.throwIfAborted();
      try {
        // One infrastructure call, not an App launch/restart or a data-request retry.
        const reply = await execute(["-s", pinned.serial, "shell", "content", "call", "--uri",
          `content://${pinned.packageName}.inspector`, "--method", "open-session"], 1500, signal);
        const value = bundle(reply);
        if (Object.keys(value).length !== 2 || value.socket !== `${pinned.packageName}.inspector.session`)
          throw Error("Diagnostic SDK bootstrap rejected");
        signal.throwIfAborted();
        sdk = await openOwnedDebugForward(pinned.serial, `localabstract:${pinned.packageName}.inspector.session`, signal, execute, choosePort);
        connection = await openCaptureSession(sdk.port, signal, connect); signal.throwIfAborted();
      } catch (error) {
        try { await closeCapture(); } catch (cleanup) { throw Error(`${errorText(error)}; ${errorText(cleanup)}`); }
        throw error;
      }
    },
    closeCapture,
    captureOnce: async (actual, options, signal) => {
      if (readerUsed) throw Error("Diagnostic capture requires an independent SDK connection");
      check(actual); if (captureAttempted) throw Error("Diagnostic capture already attempted"); captureAttempted = true;
      if (!connection || !sdk || connection.session.socket.destroyed) throw Error("Diagnostic SDK not prepared");
      if (options.treeQueueDiagnostics !== true || options.identity.pid !== pinned.pid
        || options.identity.startTicks !== pinned.startTicks || options.identity.requestId !== pinned.requestId
        || options.identity.processInstance !== pinned.processInstance) throw Error("Diagnostic request binding changed");
      createQueueStackGate(options.identity);
      if (!/^sdk-source-v1:[a-f0-9]{64}$/.test(options.identity.sdkVersion)) throw Error("Verified SDK source identity required");
      const merged = /^[a-f0-9]{16}$/.test(pinned.requestId);
      const reply = await requestProviderSession(connection.session, { method: merged ? "capture-visible" : "capture",
        arg: pinned.requestId, extras: { treeQueueDiagnostics: true, processInstance: pinned.processInstance,
          ...(merged ? { withTree: true } : {}) } }, captureTimeoutMs, signal);
      signal.throwIfAborted();
      if (connection.session.socket.destroyed) throw Error("Diagnostic SDK reply integrity lost");
      const value = bundle(reply);
      if (merged ? value.nonce !== pinned.requestId || value.processInstance !== pinned.processInstance
        || value.tree !== "ok" || "treeFailure" in value : Object.keys(value).length !== 1)
        throw Error("Diagnostic capture reply binding invalid");
    },
  };
}
