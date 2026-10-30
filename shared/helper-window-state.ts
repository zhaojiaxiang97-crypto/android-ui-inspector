import { z } from "zod";
import { createHash } from "node:crypto";

const integer = z.number().int().nonnegative().safe();
const display = z.object({ width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384),
  rotation: z.number().int().min(0).max(3) }).strict();
const identity = { version: z.literal(1), sessionId: z.uuid(), requestId: z.uuid(), serviceInstanceId: z.uuid(),
  packageName: z.string().max(256).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/), display };
const window = z.object({ id: integer, displayId: z.literal(0), type: z.enum(["application", "system", "input_method", "accessibility_overlay", "split_screen_divider"]),
  layer: z.number().int().safe(), focused: z.boolean(), active: z.boolean(), hasParent: z.boolean(), transitionTimeMs: integer,
  bounds: z.object({ left: z.number().int().safe(), top: z.number().int().safe(), right: z.number().int().safe(), bottom: z.number().int().safe() }).strict()
    .refine(b => b.right > b.left && b.bottom > b.top) }).strict();
const inventory = z.array(window).max(16).refine(w => new Set(w.map(v => v.id)).size === w.length
  && w.every((v, i) => i === 0 || w[i - 1].id < v.id), "Window inventory must be unique and sorted");
export const helperWindowStateRequest = z.object({ ...identity, timeoutMs: z.number().int().min(50).max(500) }).strict();
/** Scheduling metadata only: no tree, screenshot, complete flag, capture ticket or input receipt. */
export const helperWindowStateReply = z.object({ ...identity, readOnly: z.literal(true), dispatchState: z.literal("not_sent"),
  startedAtMs: integer, finishedAtMs: integer, windowsBefore: inventory, windowsAfter: inventory,
  foregroundPackage: z.string().max(256).nullable(), rootWindowId: integer.nullable(),
  cacheCleared: z.literal(true), rootReads: z.number().int().min(0).max(1), childReads: z.literal(0), screenshots: z.literal(0),
}).strict().refine(r => r.finishedAtMs >= r.startedAtMs && r.finishedAtMs - r.startedAtMs <= 500)
  .refine(r => r.rootReads === 1 || r.foregroundPackage === null && r.rootWindowId === null);
export type HelperWindowStateRequest = z.infer<typeof helperWindowStateRequest>;
export type HelperWindowStateReply = z.infer<typeof helperWindowStateReply>;

export function helperWindowReadiness(reply: HelperWindowStateReply): { ready: boolean; reason: "ready" | "focus" | "foreground"; signature?: string } {
  const before = reply.windowsBefore, after = reply.windowsAfter;
  if (JSON.stringify(before) !== JSON.stringify(after)) return { ready: false, reason: "focus" };
  const focused = after.filter(w => w.focused), active = after.filter(w => w.active);
  if (focused.length !== 1 || active.length !== 1 || focused[0].id !== active[0].id
    || focused[0].type !== "application" || focused[0].hasParent) return { ready: false, reason: "focus" };
  if (reply.foregroundPackage !== reply.packageName || reply.rootWindowId !== focused[0].id || reply.rootReads !== 1)
    return { ready: false, reason: "foreground" };
  return { ready: true, reason: "ready", signature: createHash("sha256").update(JSON.stringify({ service: reply.serviceInstanceId,
    display: reply.display, windows: after, foregroundPackage: reply.foregroundPackage })).digest("hex") };
}
