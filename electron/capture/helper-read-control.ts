import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HelperCaptureError } from "./accessibility-helper";
import { readHelperObservation, type HelperFetch } from "./helper-observation";
import type { DisplayFrame } from "../../shared/types";

const identity = z.object({ sessionId: z.uuid(), serviceInstanceId: z.uuid(), packageName: z.string().min(1).max(256) }).strict();
const capabilities = z.object({ success: z.literal(true), protocolVersion: z.literal(1), serviceInstanceId: z.uuid(), maxTimeoutMs: z.literal(30000) }).strict();

async function smallResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Helper control response missing");
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const item = await reader.read(); signal.throwIfAborted();
      if (item.done) break;
      size += item.value.length; if (size > 4096) throw new Error("Helper control response too large");
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => undefined); }
}

/** Explicit candidate only: caller supplies its remaining budget; old Helpers retain their original GET path. */
export async function readControlledHelperObservation(port: number, token: string, binding: z.infer<typeof identity>, frame: DisplayFrame,
  signal: AbortSignal, remainingMs: number, fetcher: HelperFetch = fetch, afterResponse?: () => Promise<void>) {
  identity.parse(binding);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{16,256}$/.test(token)
    || !Number.isFinite(remainingMs) || remainingMs < 1 || remainingMs > 30000) throw new Error("Helper control configuration invalid");
  const expires = performance.now() + remainingMs;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(remainingMs)))]);
  const url = `http://127.0.0.1:${port}/inspector/`;
  const headers = { "X-Artemis-Token": token, "Content-Type": "application/json" };
  bounded.throwIfAborted();
  const response = await fetcher(url + "read-capabilities", { method: "GET", redirect: "error", headers, signal: bounded });
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined); bounded.throwIfAborted();
    return readHelperObservation(port, token, binding.packageName, frame, bounded, fetcher, afterResponse);
  }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new HelperCaptureError("helper-control", "Helper 受控读取能力检查失败。"); }
  const capability = capabilities.parse(await smallResponse(response, bounded));
  if (capability.serviceInstanceId !== binding.serviceInstanceId) throw new HelperCaptureError("helper-control", "Helper 受控读取服务已变化。");
  bounded.throwIfAborted();
  const timeoutMs = Math.floor(expires - performance.now());
  if (timeoutMs < 1) throw new HelperCaptureError("helper-control", "Helper 受控读取预算已用完。");
  const requestId = randomUUID(), body = JSON.stringify({ version: 1, ...binding, requestId, timeoutMs });
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= (async () => {
      // Cleanup has its own short bound and finishes before the session removes its owned forward.
      const cleanup = AbortSignal.timeout(250);
      const reply = await fetcher(url + "cancel-read", { method: "POST", redirect: "error", headers, body, signal: cleanup });
      await reply.body?.cancel().catch(() => undefined);
    })().catch(() => undefined);
  };
  bounded.addEventListener("abort", cancel, { once: true });
  try {
    bounded.throwIfAborted();
    return await readHelperObservation(port, token, binding.packageName, frame, bounded, fetcher, afterResponse, { requestId, body });
  } catch (error) {
    cancel(); throw error;
  } finally {
    if (bounded.aborted) cancel();
    bounded.removeEventListener("abort", cancel);
    await cancellation;
  }
}
