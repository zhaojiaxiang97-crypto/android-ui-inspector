import { helperTargetProbeReply, helperTargetProbeRequest, type HelperTargetProbeRequest } from "../../shared/helper-target-probe";
import type { HelperFetch } from "./helper-observation";

/** One read-only POST; never retries, falls back to input, or accepts an input receipt. */
export async function readHelperTargetProbe(port: number, token: string, input: HelperTargetProbeRequest,
  signal: AbortSignal, fetcher: HelperFetch = fetch) {
  const request = helperTargetProbeRequest.parse(input);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{16,256}$/.test(token))
    throw new Error("Helper 只读预检连接无效。");
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > 4096) throw new Error("Helper 只读预检请求过大。");
  signal.throwIfAborted();
  const response = await fetcher(`http://127.0.0.1:${port}/inspector/target-probe`, {
    method: "POST", redirect: "error", headers: { "X-Artemis-Token": token, "Content-Type": "application/json" }, body, signal,
  });
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error("Helper 不支持只读预检或请求失败。"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Helper 只读预检回执为空。");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  const aborted = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 4096) throw new Error("Helper 只读预检回执过大。");
      chunks.push(next.value);
    }
  } finally { signal.removeEventListener("abort", aborted); await reader.cancel().catch(() => undefined); }
  let reply;
  try { reply = helperTargetProbeReply.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { throw new Error("Helper 只读预检回执格式无效。"); }
  for (const key of ["sessionId", "requestId", "serviceInstanceId", "captureId", "packageName", "windowId"] as const)
    if (reply[key] !== request[key]) throw new Error("Helper 只读预检身份不符。");
  if (reply.display.width !== request.display.width || reply.display.height !== request.display.height || reply.display.rotation !== request.display.rotation)
    throw new Error("Helper 只读预检显示器不符。");
  return reply;
}
