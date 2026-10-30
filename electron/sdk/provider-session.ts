import { parseProviderSessionTiming, type ProviderSessionTiming } from "./provider-session-timing";
import { receiveProviderSessionLine, requestProviderSession, type ProviderWaiter, type ProviderTreeReadyEvent, type ProviderRequestClock } from "./provider-session-request";
import net from "node:net";
import type { EventEmitter } from "node:events";
import { sdkTreePhase } from "./sdk-tree-read";
import { commandSignal, withCommandSignal, withoutCommandSignal } from "../device/command-context";
import { runDeviceAdb, type CommandResult, runCommand } from "../device/runtime";

export interface ProviderSessionInfo {
  openMs: number;
  bootstrapped: boolean;
  openTimings: Record<string, number>;
  sessionTiming: ProviderSessionTiming;
}
export interface ProviderDiagnostic {
  startedAt: number;
  timings: Record<string, number>;
  requestSessionTiming?: boolean;
  sessionTiming?: ProviderSessionTiming;
}
export interface ProviderClient {
  open(adbPath: string, serial: string, packageName: string, requestSessionTiming?: boolean): Promise<ProviderSessionInfo | null>;
  call(adbPath: string, serial: string, packageName: string, method: string, arg: string | null,
    extras: Record<string, string | boolean> | null, timeoutMs: number, shellQuote?: boolean,
    signal?: AbortSignal, onTreeReady?: (event: ProviderTreeReadyEvent) => void, diagnostic?: ProviderDiagnostic): Promise<CommandResult>;
}
export interface ProviderSessionPool extends ProviderClient {
  /** Release current work and connections. Later requests may open new connections. */
  releaseAll(): Promise<void>;
  /** Permanently stop the pool and its idle timer. Repeated disposal shares one Promise. */
  dispose(): Promise<void>;
}
export interface ProviderSocket extends EventEmitter {
  destroyed: boolean;
  setNoDelay(): unknown;
  write(line: string): unknown;
  destroy(): unknown;
}
export interface ProviderSessionDependencies extends ProviderRequestClock {
  runDeviceAdb: typeof runDeviceAdb;
  runCommand: typeof runCommand;
  connect(options: { port: number; host: string }): ProviderSocket;
  monotonicNow(): number;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  idleMs: number;
}

type ProviderSession = ProviderSessionInfo & {
  socket: ProviderSocket;
  buffer: string;
  lastUsedAt: number;
  pending: ProviderWaiter[];
  clock: ProviderRequestClock;
  dispose(): Promise<void>;
};
type Entry = { promise: Promise<ProviderSession | null>; controller: AbortController; session?: ProviderSession };
const sessionKey = (serial: string, packageName: string) => `${serial}|${packageName}`;

export function shouldReclaimSession(args: { idleMs: number; now: number; lastUsedAt: number; pendingCount: number }): boolean {
  return args.idleMs > 0 && args.pendingCount === 0 && args.now - args.lastUsedAt >= args.idleMs;
}
function idleTimeout() {
  const raw = process.env.INSPECTOR_SESSION_IDLE_MS;
  if (raw === undefined || raw.trim() === "") return 300_000;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 300_000;
}

/** One owner creates and disposes a pool. Importing this module opens no connections or timers. */
export function createProviderSessionPool(overrides: Partial<ProviderSessionDependencies> = {}): ProviderSessionPool {
  const dependencies: ProviderSessionDependencies = {
    runDeviceAdb, runCommand, connect: options => net.connect(options), now: Date.now, monotonicNow: () => performance.now(),
    setTimeout, clearTimeout, setInterval, clearInterval, idleMs: idleTimeout(), ...overrides,
  };
  const entries = new Map<string, Entry>();
  const support = new Map<string, boolean>();
  const closing = new Set<Promise<void>>();
  const calls = new Set<Promise<CommandResult>>();
  let generation = new AbortController();
  let disposed = false;
  let releasing: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  const assertOpen = () => { if (disposed) throw new Error("Provider 会话池已关闭。"); };

  function closeSession(key: string, entry: Entry, session: ProviderSession) {
    if (entries.get(key) === entry) entries.delete(key);
    for (const waiter of session.pending.splice(0)) waiter.reject(new Error("会话通道已关闭"));
    const done = session.dispose();
    closing.add(done);
    void done.then(() => closing.delete(done), () => closing.delete(done));
    return done;
  }

  async function establish(key: string, entry: Entry, adbPath: string, serial: string, packageName: string, requestSessionTiming: boolean) {
    const openingStarted = dependencies.monotonicNow();
    const signal = entry.controller.signal;
    let bootstrapped = false;
    let sessionTiming: ProviderSessionTiming = { status: requestSessionTiming ? "not-started" : "not-requested" };
    const openTimings: Record<string, number> = { "SDK 当前连接首次探测": 0, "SDK 当前连接兼容启动": 0, "SDK 当前连接启动后核验": 0 };
    const connect = async (): Promise<ProviderSession> => {
      signal.throwIfAborted();
      // Infrastructure does not inherit an individual capture's abort signal.
      const forward = await withoutCommandSignal(() => dependencies.runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `localabstract:${packageName}.inspector.session`], 15_000));
      const portText = forward.stdout.toString("utf8").trim();
      if (forward.code !== 0 || !/^\d+$/.test(portText)) throw new Error("无法转发会话端口");
      const port = Number(portText);
      let socket: ProviderSocket | undefined;
      let closed: Promise<void> | undefined;
      const dispose = () => {
        if (closed) return closed;
        closed = Promise.resolve().then(() => withoutCommandSignal(() => dependencies.runDeviceAdb(adbPath, serial, ["forward", "--remove", `tcp:${port}`], 10_000)))
          .then(() => undefined, () => undefined);
        socket?.destroy();
        return closed;
      };
      try {
        signal.throwIfAborted();
        socket = dependencies.connect({ port, host: "127.0.0.1" });
        socket.setNoDelay();
        const connectedSocket = socket;
        const session: ProviderSession = { socket, buffer: "", lastUsedAt: dependencies.now(), pending: [], dispose,
          clock: dependencies, openMs: 0, bootstrapped, openTimings, sessionTiming };
        let ready = false;
        const drop = () => {
          if (ready && entries.get(key) === entry) entries.delete(key);
          for (const waiter of session.pending.splice(0)) waiter.reject(new Error("会话通道已断开"));
          if (ready) void closeSession(key, entry, session);
        };
        const cancel = () => { void closeSession(key, entry, session); };
        signal.addEventListener("abort", cancel, { once: true });
        socket.on("data", (chunk: Buffer) => {
          session.buffer += chunk.toString("utf8");
          let index: number;
          while ((index = session.buffer.indexOf("\n")) >= 0) {
            const line = session.buffer.slice(0, index);
            session.buffer = session.buffer.slice(index + 1);
            receiveProviderSessionLine(session, line);
            session.lastUsedAt = dependencies.now();
          }
        });
        socket.on("error", drop);
        socket.on("close", () => { signal.removeEventListener("abort", cancel); drop(); });
        await new Promise<void>((resolve, reject) => {
          const timer = dependencies.setTimeout(() => finish(new Error("会话连接超时")), 500);
          const finish = (error?: Error) => {
            dependencies.clearTimeout(timer);
            connectedSocket.off("connect", connected); connectedSocket.off("error", failed); connectedSocket.off("close", closed);
            if (error) reject(error); else resolve();
          };
          const connected = () => finish();
          const failed = () => finish(new Error("无法连接会话通道"));
          const closed = () => finish(new Error("会话连接提前关闭"));
          connectedSocket.once("connect", connected); connectedSocket.once("error", failed); connectedSocket.once("close", closed);
          if (signal.aborted) cancel();
        });
        const reply = await requestProviderSession(session, { method: "session-probe", arg: null, extras: {} }, 500, signal);
        signal.throwIfAborted();
        if (reply.trim() !== "Result: Bundle[{error=Unknown session method}]" || socket.destroyed) throw new Error("会话探测响应无效");
        ready = true;
        entry.session = session;
        session.openMs = Math.round(dependencies.monotonicNow() - openingStarted);
        return session;
      } catch (error) { await dispose(); throw error; }
    };
    const probeStarted = dependencies.monotonicNow();
    try { return await connect(); } catch { signal.throwIfAborted(); }
    finally { openTimings["SDK 当前连接首次探测"] = Math.round(dependencies.monotonicNow() - probeStarted); }
    bootstrapped = true;
    const bootstrapStarted = dependencies.monotonicNow();
    const args = ["shell", "content", "call", "--uri", `content://${packageName}.inspector`, "--method", "open-session"];
    if (requestSessionTiming) args.push("--extra", "sessionTiming:b:true");
    const reply = await withoutCommandSignal(() => dependencies.runDeviceAdb(adbPath, serial, args, 15_000));
    signal.throwIfAborted();
    openTimings["SDK 当前连接兼容启动"] = Math.round(dependencies.monotonicNow() - bootstrapStarted);
    if (reply.code !== 0 || !/\bresult=ok\b/.test(reply.stdout.toString("utf8"))) throw new Error("open-session rejected");
    if (requestSessionTiming) sessionTiming = parseProviderSessionTiming(reply.stdout.toString("utf8"));
    const reconnectStarted = dependencies.monotonicNow();
    try { return await connect(); }
    finally { openTimings["SDK 当前连接启动后核验"] = Math.round(dependencies.monotonicNow() - reconnectStarted); }
  }

  function openSession(adbPath: string, serial: string, packageName: string, requestSessionTiming = false): Promise<ProviderSession | null> {
    if (disposed) return Promise.reject(new Error("Provider 会话池已关闭。"));
    if (releasing) return releasing.then(() => openSession(adbPath, serial, packageName, requestSessionTiming));
    const key = sessionKey(serial, packageName), existing = entries.get(key);
    if (existing) return existing.promise;
    const entry: Entry = { controller: new AbortController(), promise: Promise.resolve(null) };
    entry.promise = Promise.resolve().then(() => establish(key, entry, adbPath, serial, packageName, requestSessionTiming)).catch(() => {
      if (!entry.controller.signal.aborted && entries.get(key) === entry) support.set(key, false);
      return null;
    });
    entries.set(key, entry);
    return entry.promise;
  }

  async function execute(args: Parameters<ProviderClient["call"]>, signal: AbortSignal): Promise<CommandResult> {
    const [adbPath, serial, packageName, method, arg, extras, timeoutMs, shellQuote = false, , onTreeReady, diagnostic] = args;
    signal.throwIfAborted();
    const key = sessionKey(serial, packageName);
    if (support.get(key) !== false) {
      const open = () => openSession(adbPath, serial, packageName, diagnostic?.requestSessionTiming === true);
      const session = await (method === "capture" ? sdkTreePhase("session-ready", open) : open());
      if (session) {
        try {
          signal.throwIfAborted();
          if (diagnostic) {
            diagnostic.timings["SDK 会话就绪（调用内）"] = Math.round(dependencies.monotonicNow() - diagnostic.startedAt);
            diagnostic.timings["SDK 当前连接建立耗时"] = session.openMs;
            diagnostic.timings["SDK 当前连接启动服务"] = session.bootstrapped ? 1 : 0;
            Object.assign(diagnostic.timings, session.openTimings); diagnostic.sessionTiming = session.sessionTiming;
          }
          const line = await requestProviderSession(session, { method, arg, extras: extras ?? {} }, timeoutMs, signal, onTreeReady);
          return { code: 0, stdout: Buffer.from(line, "utf8"), stderr: "" };
        } catch (error) {
          const entry = entries.get(key);
          // A late failure from an older session must not evict its replacement.
          if (entry?.session === session) await closeSession(key, entry, session); else await session.dispose();
          throw error;
        }
      }
    }
    signal.throwIfAborted();
    const command = ["-s", serial, "shell", "content", "call", "--uri", `content://${packageName}.inspector`, "--method", method];
    if (arg !== null) command.push("--arg", shellQuote ? `'${arg}'` : arg);
    for (const [name, value] of Object.entries(extras ?? {})) command.push("--extra", `${name}:${typeof value === "boolean" ? "b" : "s"}:${value}`);
    const result = await dependencies.runCommand(adbPath, command, timeoutMs);
    signal.throwIfAborted();
    return result;
  }

  function call(...args: Parameters<ProviderClient["call"]>): Promise<CommandResult> {
    if (disposed) return Promise.reject(new Error("Provider 会话池已关闭。"));
    if (releasing) return releasing.then(() => call(...args));
    const suppliedSignal = args[8] ?? commandSignal();
    const signal = suppliedSignal ? AbortSignal.any([generation.signal, suppliedSignal]) : generation.signal;
    const done = withCommandSignal(signal, () => execute(args, signal));
    calls.add(done); void done.then(() => calls.delete(done), () => calls.delete(done));
    return done;
  }

  function releaseAll() {
    if (releasing) return releasing;
    support.clear();
    const old = [...entries]; entries.clear();
    const active = [...calls];
    const oldGeneration = generation; generation = new AbortController();
    const done = Promise.resolve().then(async () => {
      await Promise.allSettled([...old.map(async ([key, entry]) => {
        const session = await entry.promise;
        if (session) await closeSession(key, entry, session);
      }), ...active]);
      while (closing.size) await Promise.allSettled([...closing]);
    });
    releasing = done;
    void done.then(() => { if (releasing === done) releasing = undefined; });
    oldGeneration.abort(new Error("Provider 会话已释放。"));
    for (const [, entry] of old) entry.controller.abort(new Error("Provider 会话已释放。"));
    return done;
  }

  const sweep = dependencies.idleMs > 0 ? dependencies.setInterval(() => {
    for (const [key, entry] of entries) {
      const session = entry.session;
      if (session && shouldReclaimSession({ idleMs: dependencies.idleMs, now: dependencies.now(), lastUsedAt: session.lastUsedAt, pendingCount: session.pending.length }))
        void closeSession(key, entry, session);
    }
  }, Math.max(1_000, Math.min(30_000, Math.floor(dependencies.idleMs / 3)))) : undefined;
  sweep?.unref?.();

  return {
    open: async (...args) => {
      assertOpen(); const session = await openSession(...args);
      return session ? { openMs: session.openMs, bootstrapped: session.bootstrapped, openTimings: { ...session.openTimings }, sessionTiming: session.sessionTiming } : null;
    },
    call, releaseAll,
    dispose: () => {
      if (disposal) return disposal;
      disposed = true; if (sweep) dependencies.clearInterval(sweep);
      support.clear(); return disposal = releaseAll();
    },
  };
}
