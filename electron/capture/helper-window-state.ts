import { helperWindowStateReply, helperWindowStateRequest, type HelperWindowStateRequest } from "../../shared/helper-window-state";
import type { HelperFetch } from "./helper-observation";
import { HelperCaptureError } from "./accessibility-helper";
import { measureDebugPhase } from "../device/debug-timing";

function reject(): never { throw new HelperCaptureError("helper-window-state", "Helper 只读窗口状态不可用或来源校验失败。"); }

/** One authenticated request through the session's existing owned forward. Never falls back or dispatches input. */
export async function readHelperWindowState(port: number, token: string, input: HelperWindowStateRequest,
  signal: AbortSignal, fetcher: HelperFetch = fetch) {
  const request = helperWindowStateRequest.parse(input), body = JSON.stringify(request);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{16,256}$/.test(token) || Buffer.byteLength(body) > 4096) reject();
  signal.throwIfAborted();
  return measureDebugPhase("helper_request", async () => {
    const response = await fetcher(`http://127.0.0.1:${port}/inspector/window-state`, {
      method: "POST", redirect: "error", headers: { "X-Artemis-Token": token, "Content-Type": "application/json" }, body, signal,
    });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); reject(); }
    const reader = response.body?.getReader(); if (!reader) reject();
    const chunks: Uint8Array[] = []; let bytes = 0;
    const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted();
        if (next.done) break;
        bytes += next.value.length; if (bytes > 32 * 1024) reject(); chunks.push(next.value);
      }
    } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => undefined); }
    let raw: unknown;
    try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reject(); }
    if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as any).success === false
      && Object.keys(raw).sort().join(",") === "errorCode,success"
      && ["invalid_request", "busy", "unsupported", "authorization_changed", "service_changed", "display_changed", "timeout", "incomplete"].includes((raw as any).errorCode))
      throw new HelperCaptureError("helper-window-state-" + (raw as any).errorCode, "Helper 只读窗口状态未完成。");
    let reply;
    try { reply = helperWindowStateReply.parse(raw); }
    catch { reject(); }
    for (const key of ["sessionId", "requestId", "serviceInstanceId", "packageName"] as const) if (reply[key] !== request[key]) reject();
    if (reply.display.width !== request.display.width || reply.display.height !== request.display.height || reply.display.rotation !== request.display.rotation
      || reply.finishedAtMs - reply.startedAtMs > request.timeoutMs) reject();
    signal.throwIfAborted(); return reply;
  });
}
