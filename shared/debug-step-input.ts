import { z } from "zod";
import { debugSelector } from "./debug-selector";

const sessionId = z.string().uuid();
export const debugObservationBackend = z.enum(["uiautomator", "accessibility-helper"]).default("uiautomator")
  .describe("默认 UIAutomator。Helper 需预先手动配置且提供完整观察证据；整个步骤固定来源，失败不自动换源。");

export const debugUiStepTarget = z.object({
  selector: debugSelector, within: debugSelector.optional(), clickable: z.boolean().optional(), scrollable: z.boolean().optional(),
  target: z.enum(["self", "clickable-parent"]).default("self"),
}).strict().describe("selector 和 within 各字段精确匹配，必须唯一命中。clickable/scrollable 仅筛选节点，不授予输入权限；仍检查可见性、启用状态、窗口及遮挡。");
export const debugUiStepExpectation = z.object({ selector: debugSelector,
  state: z.enum(["visible", "absent", "enabled", "disabled"]).default("visible"),
}).strict();

// The base supports omission for plan-owned fields; both public inputs apply the same cross-field checks.
export const performUiStepInputBase = z.object({
  sessionId, requestId: z.string().uuid(), target: debugUiStepTarget.optional(),
  backend: debugObservationBackend,
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("tap") }).strict(),
    z.object({ kind: z.literal("back") }).strict(),
    z.object({ kind: z.literal("scroll"), direction: z.enum(["up", "down", "left", "right"]),
      distance: z.number().min(0.1).max(0.8).default(0.6), durationMs: z.number().int().min(150).max(1000).default(350),
    }).strict(),
  ]),
  expect: debugUiStepExpectation.optional(), timeoutMs: z.number().int().min(1000).max(60_000).default(45_000),
  visualConfirmation: z.object({ snapshotId: z.string().uuid(), description: z.string().trim().min(1).max(512) }).strict()
    .describe("已查看该 snapshotId 的整屏截图后，描述实际可见目标；确认绑定该快照，执行前仍复核新旧证据。").optional(),
}).strict();

export function refineDebugUiStepInput(value: Pick<z.infer<typeof performUiStepInputBase>, "action" | "target" | "visualConfirmation">, context: z.RefinementCtx) {
  if (value.action.kind !== "back" && !value.target)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "点击和滚动必须提供唯一目标。" });
  if (value.action.kind === "back") {
    if (value.target) context.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "返回操作不能指定目标。" });
    if (value.visualConfirmation) context.addIssue({ code: z.ZodIssueCode.custom, path: ["visualConfirmation"], message: "返回操作不接受视觉确认。" });
  }
  if (value.action.kind === "scroll" && value.target?.target === "clickable-parent")
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target", "target"], message: "滚动不能使用 clickable-parent。" });
}

export const performUiStepInput = performUiStepInputBase.superRefine(refineDebugUiStepInput);
export const getUiStepInput = z.object({ sessionId, requestId: z.string().uuid() }).strict();
export const resumeUiStepInput = getUiStepInput.extend({ timeoutMs: z.number().int().min(1000).max(60_000).default(30_000) });
export type PerformUiStepInput = z.infer<typeof performUiStepInput>;
export type GetUiStepInput = z.infer<typeof getUiStepInput>;
export type ResumeUiStepInput = z.infer<typeof resumeUiStepInput>;

export const scrollUntilInput = z.object({
  sessionId, requestId: z.string().uuid(),
  backend: debugObservationBackend,
  target: z.object({ selector: debugSelector, within: debugSelector.optional() }).strict(),
  direction: z.enum(["up", "down", "left", "right"]),
  until: z.object({ selector: debugSelector, kind: z.enum(["target", "end_marker"]).default("target") }).strict(),
  loading: debugSelector.optional(), empty: debugSelector.optional(),
  maxScrolls: z.number().int().min(1).max(12).default(6),
  timeoutMs: z.number().int().min(1000).max(120_000).default(120_000),
  distance: z.number().min(0.1).max(0.8).default(0.6),
  durationMs: z.number().int().min(150).max(1000).default(350),
  visualConfirmation: z.object({ snapshotId: z.string().uuid(), description: z.string().trim().min(1).max(512) }).strict().optional(),
}).strict().describe("在唯一滚动容器内寻找目标或明确终点。最多 12 次滚动、120 秒；每次重新校验，连续两次观察确认条件，无进展不等于到底。视觉确认只用于首个手势。");
export type ScrollUntilInput = z.infer<typeof scrollUntilInput>;
