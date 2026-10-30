// No device commands or listeners on import. The caller supplies the command executor.
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

export type ForwardExecute = (args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<string>;
export type OwnedDebugForward = { port: number; close: () => Promise<void> };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const portValid = (port: number) => Number.isSafeInteger(port) && port > 0 && port <= 65535;

/** Select a known port without leaving an open local listener. --no-rebind handles the release race. */
export async function reserveOwnedForwardPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(Error("Local port selection timed out")); }, 500);
    server.once("error", error => { clearTimeout(timer); reject(error); });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => {
        clearTimeout(timer);
        if (error || !address || typeof address === "string") reject(error ?? Error("Local port unavailable"));
        else resolve(address.port);
      });
    });
  });
}

/** Resource ownership only: this does not verify an App, process or permission to sample it.
 * Reserve with a unique marker so a lost reply remains attributable. Never delete all forwards.
 * Keep the existing marker prefix/command budgets for SDK compatibility; no SDK identity is needed.
 */
export async function openOwnedDebugForward(serial: string, remote: string, signal: AbortSignal,
  execute: ForwardExecute, choosePort: () => Promise<number> = reserveOwnedForwardPort,
  options: { onCleanupStart?: () => void; onCleanupEnd?: (failure?: unknown) => void } = {}): Promise<OwnedDebugForward> {
  const pid = typeof remote === "string" && /^jdwp:([1-9]\d*)$/.exec(remote);
  const tcp = typeof remote === "string" && /^tcp:([1-9]\d{0,4})$/.exec(remote);
  if (typeof serial !== "string" || !/^[\w.-]+$/.test(serial)
    || typeof remote !== "string" || !(pid && Number.isSafeInteger(Number(pid[1])) || tcp && portValid(Number(tcp[1])) || /^localabstract:[\w.-]+$/.test(remote)))
    throw Error("Invalid owned forward target");
  signal.throwIfAborted();
  const port = await choosePort();
  if (!portValid(port)) throw Error("Invalid owned forward port");
  signal.throwIfAborted();
  const local = `tcp:${port}`, marker = `localabstract:inspector.queue.${randomUUID()}`;
  // Resource commands deliberately have their own timeouts, not the user abort signal.
  const command = async (args: string[]) => {
    const reply = await execute(["-s", serial, ...args], 750);
    if (typeof reply !== "string" || Buffer.byteLength(reply) > 8192) throw Error("Invalid forward reply");
    return reply;
  };
  const current = async () => {
    const rows = (await command(["forward", "--list"])).trim().split(/\r?\n/).filter(Boolean);
    if (rows.length > 128) throw Error("Forward list limit exceeded");
    const entries = rows.map(row => row.trim().split(/\s+/));
    if (entries.some(row => row.length !== 3)) throw Error("Invalid forward list");
    const matches = entries.filter(row => row[0] === serial && row[1] === local);
    if (matches.length > 1) throw Error("Ambiguous forward ownership");
    return matches[0]?.[2];
  };
  if (await current() !== undefined) throw Error("Selected forward port already in use");
  let markerConfirmed = false, bindingStarted = false, closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    options.onCleanupStart?.();
    const mapping = await current();
    if (mapping === undefined) return;
    if (mapping !== marker && !(markerConfirmed && bindingStarted && mapping === remote))
      throw Error("Owned forward changed; refusing removal");
    let removalError: unknown;
    try { await command(["forward", "--remove", local]); } catch (error) { removalError = error; }
    if (await current() !== undefined) throw Error(`Owned forward cleanup not confirmed${removalError ? `: ${errorText(removalError)}` : ""}`);
  })().then(() => { options.onCleanupEnd?.(); }, error => { options.onCleanupEnd?.(error); throw error; });
  try {
    signal.throwIfAborted();
    await command(["forward", "--no-rebind", local, marker]);
    if (await current() !== marker) throw Error("Forward reservation identity changed");
    markerConfirmed = true; signal.throwIfAborted(); bindingStarted = true;
    await command(["forward", local, remote]);
    if (await current() !== remote) throw Error("Forward binding identity changed");
    signal.throwIfAborted(); return { port, close };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw Error(`${errorText(error)}; ${errorText(cleanup)}`); }
    throw error;
  }
}
