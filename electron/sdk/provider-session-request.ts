export type ProviderTreeReadyEvent = { event: "tree-ready"; nonce: string; processInstance: string; pid: number };
export type ProviderWaiter = { resolve: (line: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; event?: (line: string) => void };
type RequestSession = {
  socket: { write: (line: string) => unknown };
  pending: ProviderWaiter[];
  lastUsedAt: number;
};

// The caller closes the session after rejection: a late line must never enter a new request.
export function requestProviderSession(session: RequestSession, payload: { method: string; arg: string | null; extras: Record<string, string | boolean> }, timeoutMs: number, signal?: AbortSignal, onTreeReady?: (event: ProviderTreeReadyEvent) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let settled = false;
    let eventLines = 0, notified = false;
    const finish = (line?: string, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(waiter.timer);
      signal?.removeEventListener("abort", abort);
      const at = session.pending.indexOf(waiter);
      if (at >= 0) session.pending.splice(at, 1);
      if (error) reject(error); else resolve(line!);
    };
    const abort = () => finish(undefined, signal?.reason instanceof Error ? signal.reason : new Error("已取消"));
    const waiter: ProviderWaiter = {
      resolve: line => finish(line), reject: error => finish(undefined, error),
      timer: setTimeout(() => finish(undefined, new Error(`会话调用超时：${payload.method}`)), timeoutMs),
      event: line => {
        if (settled || notified || ++eventLines > 8 || line.length > 1024 || !onTreeReady
            || payload.method !== "capture-visible" || payload.extras.withTree !== true || payload.extras.treeReadyEvents !== true) return;
        let event: ProviderTreeReadyEvent;
        try { event = JSON.parse(line.slice("Event: ".length)); } catch { return; }
        if (!event || event.event !== "tree-ready" || event.nonce !== payload.arg || !/^[a-f0-9]{16}$/.test(event.nonce)
            || !Number.isSafeInteger(event.pid) || event.pid <= 0 || typeof event.processInstance !== "string"
            || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(event.processInstance)) return;
        notified = true;
        try { onTreeReady(event); } catch (error) { finish(undefined, error instanceof Error ? error : new Error(String(error))); }
      },
    };
    session.pending.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    session.lastUsedAt = Date.now();
    try { session.socket.write(`${JSON.stringify(payload)}\n`); }
    catch (error) { finish(undefined, error instanceof Error ? error : new Error(String(error))); }
  });
}

/** Event lines never consume the pending final reply, including unknown/late events. */
export function receiveProviderSessionLine(session: RequestSession, line: string) {
  if (line.startsWith("Event: ")) { session.pending[0]?.event?.(line); return; }
  session.pending[0]?.resolve(line);
}
