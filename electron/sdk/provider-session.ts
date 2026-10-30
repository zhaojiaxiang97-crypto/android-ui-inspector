import { parseProviderSessionTiming, type ProviderSessionTiming } from "./provider-session-timing";
import { receiveProviderSessionLine, requestProviderSession, type ProviderWaiter, type ProviderTreeReadyEvent } from "./provider-session-request";
import net from "node:net";
import { sdkTreePhase } from "./sdk-tree-read";
import { inspectionContext, runDeviceAdb, type CommandResult, runCommand } from "../device/runtime";


/** Experimental persistent session per device+package: one adb forward and one socket replace a `content` CLI process per call. */
type ProviderSession = {
  adbPath: string;
  serial: string;
  packageName: string;
  socket: net.Socket;
  port: number;
  buffer: string;
  lastUsedAt: number;
  pending: ProviderWaiter[];
  dispose: () => Promise<void>;
  openMs: number;
  bootstrapped: boolean;
  openTimings: Record<string, number>;
  sessionTiming: ProviderSessionTiming;
};
const providerSessions = new Map<string, Promise<ProviderSession | null>>();
const sessionSupport = new Map<string, boolean>();

/** 会话通道空闲回收：超过该毫秒数没有任何请求的会话自动关闭；≤0 禁用（INSPECTOR_SESSION_IDLE_MS 覆盖，便于用短阈值验证）。 */
const sessionIdleMs = (() => {
  const raw = process.env.INSPECTOR_SESSION_IDLE_MS;
  if (raw === undefined || raw.trim() === "") return 300_000;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 300_000;
})();
/** 空闲回收判定（纯函数便于单测）：有在飞请求、未到阈值或禁用时不回收。 */
export function shouldReclaimSession(args: { idleMs: number; now: number; lastUsedAt: number; pendingCount: number }): boolean {
  return args.idleMs > 0 && args.pendingCount === 0 && args.now - args.lastUsedAt >= args.idleMs;
}
if (sessionIdleMs > 0) {
  const sweep = setInterval(() => {
    for (const pending of [...providerSessions.values()]) {
      void pending.then((session) => {
        if (!session) return;
        if (shouldReclaimSession({ idleMs: sessionIdleMs, now: Date.now(), lastUsedAt: session.lastUsedAt, pendingCount: session.pending.length })) void closeProviderSession(session);
      }).catch(() => undefined);
    }
  }, Math.max(1_000, Math.min(30_000, Math.floor(sessionIdleMs / 3))));
  sweep.unref();
}

const sessionKey = (serial: string, packageName: string) => `${serial}|${packageName}`;

export function openProviderSession(adbPath: string, serial: string, packageName: string, requestSessionTiming = false): Promise<ProviderSession | null> {
  const key = sessionKey(serial, packageName);
  const existing = providerSessions.get(key);
  if (existing) return existing;
  const openingStarted = performance.now();
  // The open is session infrastructure: keep it outside the capture signal so a cancelled
  // capture still leaves the session usable for the next one.
  const opening = (async () => {
    let bootstrapped = false;
    let sessionTiming: ProviderSessionTiming = { status: requestSessionTiming ? "not-started" : "not-requested" };
    const openTimings: Record<string, number> = {
      "SDK 当前连接首次探测": 0, "SDK 当前连接兼容启动": 0, "SDK 当前连接启动后核验": 0,
    };
    const connect = async (): Promise<ProviderSession> => {
      const forward = await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `localabstract:${packageName}.inspector.session`], 15_000));
      const portText = forward.stdout.toString("utf8").trim();
      if (forward.code !== 0 || !/^\d+$/.test(portText)) throw new Error("无法转发会话端口");
      const port = Number(portText);
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.setNoDelay(true);
      let disposal: Promise<void> | undefined;
      const dispose = () => {
        socket.destroy();
        return disposal ??= inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "--remove", `tcp:${port}`], 10_000))
          .then(() => undefined, () => undefined);
      };
      const session: ProviderSession = { adbPath, serial, packageName, socket, port, buffer: "", lastUsedAt: Date.now(), pending: [], dispose, openMs: 0, bootstrapped, openTimings, sessionTiming };
      let ready = false;
      const drop = () => {
        if (ready && providerSessions.get(key) === opening) providerSessions.delete(key);
        for (const waiter of session.pending.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("会话通道已断开"));
        }
        if (ready) void dispose();
      };
      socket.on("data", (chunk: Buffer) => {
        session.buffer += chunk.toString("utf8");
        let index: number;
        while ((index = session.buffer.indexOf("\n")) >= 0) {
          const line = session.buffer.slice(0, index);
          session.buffer = session.buffer.slice(index + 1);
          receiveProviderSessionLine(session, line);
          session.lastUsedAt = Date.now();
        }
      });
      socket.on("error", drop);
      socket.on("close", drop);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => finish(new Error("会话连接超时")), 500);
          const finish = (error?: Error) => {
            clearTimeout(timer);
            socket.off("connect", connected); socket.off("error", failed); socket.off("close", closed);
            if (error) reject(error); else resolve();
          };
          const connected = () => finish();
          const failed = () => finish(new Error("无法连接会话通道"));
          const closed = () => finish(new Error("会话连接提前关闭"));
          socket.once("connect", connected); socket.once("error", failed); socket.once("close", closed);
        });
        // Older SDKs also reject this unknown method without dispatching UI work.
        // A TCP connect alone only proves that the adb forwarding port exists.
        const reply = await requestProviderSession(session, { method: "session-probe", arg: null, extras: {} }, 500);
        if (reply.trim() !== "Result: Bundle[{error=Unknown session method}]" || socket.destroyed)
          throw new Error("会话探测响应无效");
        ready = true;
        session.openMs = Math.round(performance.now() - openingStarted);
        return session;
      } catch (error) { await dispose(); throw error; }
    };
    // Only infrastructure is retried. Never replay a tree/image request after failure.
    const probeStarted = performance.now();
    try { return await connect(); } catch { /* Service absent: keep the original lazy start. */ }
    finally { openTimings["SDK 当前连接首次探测"] = Math.round(performance.now() - probeStarted); }
    bootstrapped = true;
    const bootstrapStarted = performance.now();
    const bootstrapArgs = ["shell", "content", "call", "--uri", `content://${packageName}.inspector`, "--method", "open-session"];
    if (requestSessionTiming) bootstrapArgs.push("--extra", "sessionTiming:b:true");
    const reply = await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, bootstrapArgs, 15_000));
    openTimings["SDK 当前连接兼容启动"] = Math.round(performance.now() - bootstrapStarted);
    const output = reply.stdout.toString("utf8");
    if (reply.code !== 0 || !/\bresult=ok\b/.test(output)) throw new Error("open-session rejected");
    if (requestSessionTiming) sessionTiming = parseProviderSessionTiming(output);
    const reconnectStarted = performance.now();
    try { return await connect(); }
    finally { openTimings["SDK 当前连接启动后核验"] = Math.round(performance.now() - reconnectStarted); }
  })().catch(() => {
    sessionSupport.set(key, false);
    return null;
  });
  providerSessions.set(key, opening);
  return opening;
}

async function closeProviderSession(session: ProviderSession) {
  const key = sessionKey(session.serial, session.packageName);
  providerSessions.delete(key);
  for (const waiter of session.pending.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error("会话通道已关闭"));
  }
  await session.dispose();
}

/** Routes one provider request over the persistent session; no session means the `content` CLI fallback. */
export async function providerCall(adbPath: string, serial: string, packageName: string, method: string, arg: string | null, extras: Record<string, string | boolean> | null, timeoutMs: number, shellQuote = false, signal?: AbortSignal, onTreeReady?: (event: ProviderTreeReadyEvent) => void, diagnostic?: { startedAt: number; timings: Record<string, number>; requestSessionTiming?: boolean; sessionTiming?: ProviderSessionTiming }): Promise<CommandResult> {
  if (signal) return inspectionContext.run({ ...inspectionContext.getStore(), signal },
    () => providerCall(adbPath, serial, packageName, method, arg, extras, timeoutMs, shellQuote, undefined, onTreeReady, diagnostic));
  if (sessionSupport.get(sessionKey(serial, packageName)) !== false) {
    const open = () => openProviderSession(adbPath, serial, packageName, diagnostic?.requestSessionTiming === true).catch(() => null);
    const session = await (method === "capture" ? sdkTreePhase("session-ready", open) : open());
    if (session) {
      const signal = inspectionContext.getStore()?.signal;
      try {
        signal?.throwIfAborted();
        if (diagnostic) {
          diagnostic.timings["SDK 会话就绪（调用内）"] = Math.round(performance.now() - diagnostic.startedAt);
          // Historical setup of this connection, not another per-request elapsed phase.
          diagnostic.timings["SDK 当前连接建立耗时"] = session.openMs;
          diagnostic.timings["SDK 当前连接启动服务"] = session.bootstrapped ? 1 : 0;
          Object.assign(diagnostic.timings, session.openTimings);
          diagnostic.sessionTiming = session.sessionTiming;
        }
        const line = await requestProviderSession(session, { method, arg, extras: extras ?? {} }, timeoutMs, signal, onTreeReady);
        return { code: 0, stdout: Buffer.from(line, "utf8"), stderr: "" };
      } catch (error) {
        // A timeout or abort leaves the line protocol desynced (the device still answers later),
        // so the session is done; the caller's existing failure handling applies.
        await closeProviderSession(session);
        throw error;
      }
    }
  }
  const args = ["-s", serial, "shell", "content", "call", "--uri", `content://${packageName}.inspector`, "--method", method];
  if (arg !== null) args.push("--arg", shellQuote ? `'${arg}'` : arg);
  for (const [name, value] of Object.entries(extras ?? {})) args.push("--extra", `${name}:${typeof value === "boolean" ? "b" : "s"}:${value}`);
  return runCommand(adbPath, args, timeoutMs);
}

export function closeProviderSessions() {
  const closing = [...providerSessions].map(([key, pending]) => {
    providerSessions.delete(key);
    return pending.then(async session => { if (session) await closeProviderSession(session); }).catch(() => undefined);
  });
  return Promise.all(closing).then(() => undefined);
}
