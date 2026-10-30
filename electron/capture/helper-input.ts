import { helperInputReply, helperInputRequest, type HelperInputReply, type HelperInputRequest } from "../../shared/helper-input";
import type { HelperFetch } from "./helper-observation";
import { measureDebugPhase } from "../device/debug-timing";

/** An HTTP dispatch attempt is uncertain unless the complete receipt and session checks succeed. */
export class HelperInputError extends Error {
  constructor(message: string, readonly dispatchState: "not_sent" | "unknown" | "sent", readonly requestId?: string, readonly reply?: HelperInputReply) {
    super(message);
  }
}
class HelperInputProtocolError extends Error {}

/** Exactly one POST. Missing or old endpoints never select another input transport. */
export async function readHelperInput(port: number, token: string, input: HelperInputRequest, signal: AbortSignal, fetcher: HelperFetch = fetch): Promise<HelperInputReply> {
  let dispatched = false, validReply: HelperInputReply | undefined;
  try {
    const request = helperInputRequest.parse(input), body = JSON.stringify(request);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{16,256}$/.test(token))
      throw new HelperInputProtocolError("Helper 输入连接配置无效。");
    signal.throwIfAborted();
    return await measureDebugPhase("helper_request", async () => {
      dispatched = true;
      const response = await fetcher(`http://127.0.0.1:${port}/inspector/input`, {
        method: "POST", redirect: "error", headers: { "X-Artemis-Token": token, "Content-Type": "application/json" }, body, signal,
      });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new HelperInputProtocolError(`Helper 输入返回 HTTP ${response.status}。`); }
      const reader = response.body?.getReader();
      if (!reader) throw new HelperInputProtocolError("Helper 输入回执为空。");
      const chunks: Uint8Array[] = []; let bytes = 0;
      const aborted = () => { void reader.cancel(signal.reason).catch(() => undefined); };
      signal.addEventListener("abort", aborted, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) break;
          bytes += next.value.length;
          if (bytes > 16 * 1024) throw new HelperInputProtocolError("Helper 输入回执超过16 KiB。");
          chunks.push(next.value);
        }
      } finally { signal.removeEventListener("abort", aborted); await reader.cancel().catch(() => undefined); }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new HelperInputProtocolError("Helper 输入回执不是有效 JSON。"); }
      const parsed = helperInputReply.safeParse(value);
      if (!parsed.success) throw new HelperInputProtocolError("Helper 输入回执格式或状态无效。");
      const reply = parsed.data;
      if (reply.sessionId !== request.sessionId || reply.requestId !== request.requestId || reply.serviceInstanceId !== request.serviceInstanceId
        || reply.captureId !== request.captureId || reply.packageName !== request.packageName || reply.windowId !== request.windowId
        || reply.display.width !== request.display.width || reply.display.height !== request.display.height || reply.display.rotation !== request.display.rotation)
        throw new HelperInputProtocolError("Helper 输入回执身份或显示器无效。");
      const method = request.action.kind === "scroll" ? "accessibility-scroll"
        : request.target ? "accessibility-click" : request.action.kind === "back" ? "global-back" : "gesture";
      if (reply.method !== method) throw new HelperInputProtocolError("Helper 输入回执的执行方式与请求不符。");
      validReply = reply;
      signal.throwIfAborted();
      return reply;
    });
  } catch (error) {
    // Never retain untrusted body text, validation details or transport exception messages.
    const message = error instanceof HelperInputProtocolError ? error.message
      : signal.aborted ? "Helper 输入已取消；已请求的操作可能已发出。" : "Helper 输入未获得可信回执。";
    throw new HelperInputError(message, dispatched ? "unknown" : "not_sent", dispatched ? input.requestId : undefined, validReply);
  }
}
