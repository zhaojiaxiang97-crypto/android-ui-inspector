import { z } from "zod";
import type { DebugScrollProgress } from "./debug-scroll";

const id = z.string().uuid(), text = z.string().max(16000);
const duration = z.number().finite().nonnegative();
const rect = z.object({ left: z.number().int().nonnegative(), top: z.number().int().nonnegative(),
  right: z.number().int().positive(), bottom: z.number().int().positive() }).strict()
  .refine(value => value.left < value.right && value.top < value.bottom);
const receipt = z.object({
  classification: z.enum(["accepted", "permission-denied", "device-unavailable", "invalid-command", "command-failed", "unexpected-output", "cancelled", "timeout", "output-limit", "spawn-failed", "unconfirmed-exit"]),
  spawned: z.boolean(), closed: z.boolean(), exitCode: z.number().int().nullable(), signal: text.nullable(), errorCode: text.optional(),
  durationMs: duration, stdout: z.string().max(65536), stderr: z.string().max(65536), stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(),
}).strict();
const resolved = z.object({
  action: z.object({ kind: z.literal("swipe"), fromX: z.number().finite(), fromY: z.number().finite(),
    toX: z.number().finite(), toY: z.number().finite(), durationMs: z.number().int().min(150).max(1000) }).strict(),
  frame: z.object({ width: z.number().int().positive(), height: z.number().int().positive(),
    rotation: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) }).strict(),
  targetNodeId: text.min(1).optional(), anchorNodeId: text.min(1).optional(),
  scrollRegion: z.object({ viewport: rect, confirmationBounds: rect, excludedNavigationBounds: z.array(rect).max(100) }).strict().optional(),
  visualConfirmation: z.object({ referenceSnapshotId: id, currentSnapshotId: id,
    description: z.string().min(1).max(512).refine(value => value.trim().length > 0),
    region: z.object({ left: z.number().int().nonnegative(), top: z.number().int().nonnegative(),
      width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), overlapNodeIds: z.array(text.min(1)).max(100),
  }).strict().optional(),
}).strict().refine(value => {
  const { action, frame, scrollRegion: scroll, visualConfirmation: visual } = value;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < frame.width && y < frame.height;
  if (!inside(action.fromX, action.fromY) || !inside(action.toX, action.toY)) return false;
  if (scroll) {
    const { viewport, confirmationBounds: area, excludedNavigationBounds } = scroll;
    if (!value.targetNodeId || [viewport, area, ...excludedNavigationBounds].some(bounds => bounds.right > frame.width || bounds.bottom > frame.height)
      || area.left < viewport.left || area.top < viewport.top || area.right > viewport.right || area.bottom > viewport.bottom
      || [action.fromX, action.toX].some(x => x < area.left || x >= area.right)
      || [action.fromY, action.toY].some(y => y < area.top || y >= area.bottom)
      || excludedNavigationBounds.some(bounds => bounds.left < viewport.right && bounds.right > viewport.left
        && bounds.top < viewport.bottom && bounds.bottom > viewport.top)) return false;
    if (visual && (visual.region.left !== area.left || visual.region.top !== area.top
      || visual.region.width !== area.right - area.left || visual.region.height !== area.bottom - area.top)) return false;
  }
  return !visual || Boolean(value.targetNodeId && visual.region.left + visual.region.width <= frame.width
    && visual.region.top + visual.region.height <= frame.height && visual.region.width * visual.region.height <= 16 * 1024 * 1024
    && new Set(visual.overlapNodeIds).size === visual.overlapNodeIds.length
    && visual.overlapNodeIds.reduce((sum, value) => sum + new TextEncoder().encode(value).length, 0) <= 16 * 1024);
}, "滚动输入坐标、区域或视觉证据不一致");

export const debugScrollProgressSchema = z.object({
  stopReason: z.enum(["running", "target_found", "end_reached", "empty", "no_progress", "scroll_limit", "timeout", "cancelled", "container_missing", "interrupted"]),
  iterations: z.array(z.object({
    index: z.number().int().min(1).max(12), startedAt: z.string().datetime({ offset: true }), durationMs: duration,
    beforeId: id.optional(), afterId: id.optional(), dispatchState: z.enum(["not_sent", "unknown", "sent"]),
    resolvedInput: resolved.optional(), inputEvidence: receipt.optional(),
    progress: z.enum(["changed", "unchanged", "unknown"]), error: text.optional(),
  }).strict()).max(12),
  observationIds: z.array(id).max(256),
  scope: z.object({ windowId: text.min(1), component: text.min(1), activityRecordId: text.min(1).optional(),
    frame: z.object({ width: z.number().int().positive(), height: z.number().int().positive(),
      rotation: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) }).strict() }).strict().optional(),
  confirmation: z.object({ firstSnapshotId: id, secondSnapshotId: id, kind: z.enum(["target", "end_marker", "empty"]) }).strict().optional(),
}).strict().superRefine((value, context) => {
  const invalid = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  const observed = new Set(value.observationIds);
  if (observed.size !== value.observationIds.length) invalid("滚动观察编号重复");
  for (let index = 0; index < value.iterations.length; index++) {
    const iteration = value.iterations[index];
    if (iteration.index !== index + 1 || index > 0 && Date.parse(iteration.startedAt) < Date.parse(value.iterations[index - 1].startedAt)) invalid("滚动次数或时间顺序不一致");
    if ([iteration.beforeId, iteration.afterId].some(id => id !== undefined && !observed.has(id))) invalid("滚动引用未记录的观察");
    if (iteration.resolvedInput?.visualConfirmation && iteration.resolvedInput.visualConfirmation.currentSnapshotId !== iteration.beforeId) invalid("视觉确认不属于本次滚动观察");
    if (iteration.dispatchState !== "not_sent" && (!iteration.resolvedInput || !iteration.beforeId)) invalid("派发的滚动缺少解析输入或操作前观察");
    if (value.scope && iteration.resolvedInput && (iteration.resolvedInput.frame.width !== value.scope.frame.width
      || iteration.resolvedInput.frame.height !== value.scope.frame.height || iteration.resolvedInput.frame.rotation !== value.scope.frame.rotation)) invalid("滚动输入与固定显示范围不一致");
    if (iteration.dispatchState === "not_sent" && iteration.inputEvidence?.spawned) invalid("未派发的滚动不能记录已启动输入");
  }
  const confirmation = value.confirmation;
  if (confirmation && (confirmation.firstSnapshotId === confirmation.secondSnapshotId
    || !observed.has(confirmation.firstSnapshotId) || !observed.has(confirmation.secondSnapshotId)
    || value.observationIds.indexOf(confirmation.firstSnapshotId) >= value.observationIds.indexOf(confirmation.secondSnapshotId))) invalid("滚动确认需要两个不同且有序的新观察");
  const expected = { target_found: "target", end_reached: "end_marker", empty: "empty" }[value.stopReason as "target_found" | "end_reached" | "empty"];
  if (expected && confirmation?.kind !== expected || confirmation && expected !== confirmation.kind) invalid("滚动停止原因与确认类型不一致");
});

export function isDebugScrollProgress(value: unknown): value is DebugScrollProgress {
  return debugScrollProgressSchema.safeParse(value).success;
}
