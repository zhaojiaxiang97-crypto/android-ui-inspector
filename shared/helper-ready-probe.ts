import { z } from "zod";

const display = z.object({ width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384),
  rotation: z.number().int().min(0).max(3) }).strict();

/**
 * Read-only readiness hint before a complete observation. The device returns the
 * short observation-bounds probe result only; callers still verify fresh complete frames.
 */
export const helperReadyProbeRequest = z.object({
  version: z.literal(1), sessionId: z.uuid(), requestId: z.uuid(), serviceInstanceId: z.uuid(),
  packageName: z.string().min(1).max(256).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/),
  display, timeoutMs: z.number().int().min(50).max(1000),
}).strict().superRefine((input, context) => {
  if (new TextEncoder().encode(JSON.stringify(input)).length > 4096)
    context.addIssue({ code: "custom", message: "就绪探针请求超过4096字节。" });
});

export const helperReadyProbeHint = z.object({
  success: z.literal(true), protocolVersion: z.literal(1), sessionId: z.uuid(), requestId: z.uuid(),
  serviceInstanceId: z.uuid(), packageName: z.string().min(1).max(256),
  display, status: z.enum(["ready", "pending"]), matchCount: z.number().int().min(0).max(5000), attempts: z.number().int().min(1).max(8),
  probeElapsedMs: z.number().int().nonnegative(), startedAtMs: z.number().int().nonnegative(),
  finishedAtMs: z.number().int().nonnegative(),
}).strict().refine(value => value.finishedAtMs >= value.startedAtMs
  && value.probeElapsedMs <= value.finishedAtMs - value.startedAtMs, "设备探针时间顺序无效。");

export type HelperReadyProbeRequest = z.infer<typeof helperReadyProbeRequest>;
export type HelperReadyProbeHint = z.infer<typeof helperReadyProbeHint>;
