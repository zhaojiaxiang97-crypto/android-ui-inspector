import { z } from "zod";
import { debugSelector } from "./debug-selector";

const display = z.object({ width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384),
  rotation: z.number().int().min(0).max(3) }).strict();

/** Short read-only scheduling hint. It is never a snapshot, assertion proof or input permission. */
export const helperConditionWaitRequest = z.object({
  version: z.literal(1), sessionId: z.uuid(), requestId: z.uuid(), serviceInstanceId: z.uuid(),
  packageName: z.string().min(1).max(256).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/),
  selector: debugSelector, state: z.enum(["visible", "absent", "enabled", "disabled"]),
  display, timeoutMs: z.number().int().min(50).max(1000),
}).strict().superRefine((input, context) => {
  if (new TextEncoder().encode(JSON.stringify(input)).length > 4096)
    context.addIssue({ code: "custom", message: "设备等待请求超过4096字节。" });
});

export const helperConditionWaitHint = z.object({
  success: z.literal(true), protocolVersion: z.literal(1), sessionId: z.uuid(), requestId: z.uuid(),
  serviceInstanceId: z.uuid(), packageName: z.string().min(1).max(256),
  windowId: z.string().min(1).max(128), display,
  status: z.enum(["ready", "pending"]), matchCount: z.number().int().min(0).max(5000),
  attempts: z.number().int().min(1).max(8),
  startedAtMs: z.number().int().nonnegative(), finishedAtMs: z.number().int().nonnegative(),
}).strict().refine(value => value.finishedAtMs >= value.startedAtMs, "设备等待时间顺序无效。");

export type HelperConditionWaitRequest = z.infer<typeof helperConditionWaitRequest>;
export type HelperConditionWaitHint = z.infer<typeof helperConditionWaitHint>;
