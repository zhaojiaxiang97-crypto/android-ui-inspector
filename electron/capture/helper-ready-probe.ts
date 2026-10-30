import { helperReadyProbeHint, helperReadyProbeRequest, type HelperReadyProbeRequest } from "../../shared/helper-ready-probe";
import { HelperCaptureError } from "./accessibility-helper";
import type { HelperFetch } from "./helper-observation";
import { measureDebugPhase } from "../device/debug-timing";

function reject(message: string): never { throw new HelperCaptureError("helper-ready-probe", message); }

/** A scheduling hint only. Callers must still acquire complete, fresh observation evidence. */
export async function readHelperReadyProbe(port: number, token: string, input: HelperReadyProbeRequest,
  signal: AbortSignal, fetcher: HelperFetch = fetch) {
  const request = helperReadyProbeRequest.parse(input), body = JSON.stringify(request);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{16,256}$/.test(token))
    reject("Helper 探针连接配置无效。");
  signal.throwIfAborted();
  return measureDebugPhase("helper_ready_probe", async () => {
    const response = await fetcher(`http://127.0.0.1:${port}/inspector/ready`, {
      method: "POST", redirect: "error", headers: { "X-Artemis-Token": token, "Content-Type": "application/json" }, body, signal,
    });
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); signal.throwIfAborted(); return null; }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); reject(`Helper 探针返回 HTTP ${response.status}。`); }
    const reader = response.body?.getReader();
    if (!reader) reject("Helper 探针响应为空。");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const aborted = () => { void reader.cancel(signal.reason).catch(() => undefined); };
    signal.addEventListener("abort", aborted, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > 16 * 1024) reject("Helper 探针响应超过 16 KiB。");
        chunks.push(next.value);
      }
    } finally { signal.removeEventListener("abort", aborted); await reader.cancel().catch(() => undefined); }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { reject("Helper 探针响应不是有效 JSON。"); }
    const parsed = helperReadyProbeHint.safeParse(value);
    if (!parsed.success) reject("Helper 探针响应格式或状态无效。");
    const hint = parsed.data;
    if (hint.sessionId !== request.sessionId || hint.requestId !== request.requestId
      || hint.serviceInstanceId !== request.serviceInstanceId || hint.packageName !== request.packageName
      || hint.display.width !== request.display.width || hint.display.height !== request.display.height
      || hint.display.rotation !== request.display.rotation
      || hint.finishedAtMs - hint.startedAtMs > request.timeoutMs + 1000)
      reject("Helper 探针会话、服务或屏幕提示无效。");
    if (hint.status === "ready" && hint.matchCount !== 0) reject("Helper 探针就绪提示含异常匹配。");
    signal.throwIfAborted();
    return hint;
  });
}
