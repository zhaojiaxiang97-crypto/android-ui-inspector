import { z } from "zod";

const display = z.object({ width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384),
  rotation: z.number().int().min(0).max(3) }).strict();
const coordinate = z.number().int().nonnegative().max(100000);
const target = z.object({ resourceId: z.string().min(1).max(512).optional(), className: z.string().min(1).max(512),
  text: z.string().max(512).optional(), contentDesc: z.string().max(512).optional(),
  bounds: z.object({ left: coordinate, top: coordinate, right: coordinate, bottom: coordinate }).strict(),
}).strict();
const action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tap"), x: coordinate, y: coordinate }).strict(),
  z.object({ kind: z.literal("swipe"), fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate,
    durationMs: z.number().int().min(150).max(1000) }).strict(),
  z.object({ kind: z.literal("back") }).strict(),
  z.object({ kind: z.literal("scroll"), direction: z.enum(["up", "down"]) }).strict(),
]);
const identity = { version: z.literal(1), sessionId: z.uuid(), requestId: z.uuid(), serviceInstanceId: z.uuid(), captureId: z.uuid(),
  packageName: z.string().min(1).max(256).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/)
    .refine(value => value.trim() === value),
  windowId: z.string().regex(/^\d{1,10}$/).refine(value => String(Number(value)) === value), display };
export const helperInputRequest = z.object({ ...identity, action, target: target.optional() }).strict().superRefine((input, context) => {
  const a = input.action, inside = (x: number, y: number) => x < input.display.width && y < input.display.height;
  if (a.kind === "tap" && !inside(a.x, a.y) || a.kind === "swipe"
    && (!inside(a.fromX, a.fromY) || !inside(a.toX, a.toY) || a.fromX === a.toX && a.fromY === a.toY))
    context.addIssue({ code: "custom", message: "Helper 输入坐标或滑动范围无效。" });
  if (input.target) {
    const b = input.target.bounds;
    if (input.target.resourceId === undefined && !input.target.contentDesc?.trim())
      context.addIssue({ code: "custom", message: "无资源 ID 的 Helper 点击目标必须具有非空精确描述。" });
    if ((a.kind !== "tap" && a.kind !== "scroll") || b.left >= b.right || b.top >= b.bottom || b.right > input.display.width || b.bottom > input.display.height
      || a.kind === "tap" && (a.x < b.left || a.x >= b.right || a.y < b.top || a.y >= b.bottom))
      context.addIssue({ code: "custom", message: "Helper 控件操作目标或范围无效。" });
  }
  if (a.kind === "scroll" && !input.target?.resourceId)
    context.addIssue({ code: "custom", message: "Helper 控件滚动必须提供精确目标。" });
  if (new TextEncoder().encode(JSON.stringify(input)).length > 4096)
    context.addIssue({ code: "custom", message: "Helper 输入请求超过4096字节。" });
});
export const helperInputErrorCode = z.enum(["busy", "capacity", "service_changed", "authorization_changed", "capture_expired", "capture_changed",
  "window_changed", "display_changed", "incomplete", "coordinates_invalid", "unsupported", "dispatch_rejected", "cancelled", "timeout", "dispatch_error"]);
export const helperInputReply = z.object({ ...identity, status: z.enum(["completed", "rejected", "cancelled", "timeout"]),
  dispatchState: z.enum(["sent", "not_sent", "unknown"]), startedAtMs: z.number().int().nonnegative().safe(),
  finishedAtMs: z.number().int().nonnegative().safe(), errorCode: helperInputErrorCode.optional(),
  method: z.enum(["accessibility-click", "accessibility-scroll", "gesture", "global-back"]).optional(),
}).strict().refine(value => value.status === "completed" ? value.errorCode === undefined
  : value.status === "cancelled" ? value.errorCode === "cancelled" || value.errorCode === "dispatch_error"
    : value.status === "timeout" ? value.errorCode === "timeout"
    : value.errorCode !== undefined)
  .refine(value => value.finishedAtMs >= value.startedAtMs && value.finishedAtMs - value.startedAtMs <= 7000,
  "Helper 输入回执时间无效。").refine(value => value.status === "completed" ? value.dispatchState === "sent"
  : value.status === "rejected" ? value.dispatchState === "not_sent"
    : value.status === "cancelled" ? value.dispatchState === "unknown" : value.dispatchState !== "sent", "Helper 输入回执状态无效。");
export type HelperInputRequest = z.infer<typeof helperInputRequest>;
export type HelperInputReply = z.infer<typeof helperInputReply>;
