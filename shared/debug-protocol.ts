import { z } from "zod";
import { debugSelector } from "./debug-selector";
import { debugTaskDefinition } from "./debug-task";
export { debugSelector, matchesDebugSelector } from "./debug-selector";

const sessionId = z.string().uuid();
const snapshotInput = { sessionId, snapshotId: z.string().uuid() };
const nodeId = z.string().min(1).max(2048);
const visualConfirmation = z.object({ description: z.string().trim().min(1).max(512) }).strict()
  .describe("仅当 Agent 已查看本次 snapshotId 的整屏截图并确认目标可见时提供，description 描述实际看到的目标；不是 force，也不要求用户额外许可。执行前仍核对目标区域像素、身份、窗口及授权范围。");

export const debugUiStepTarget = z.object({
  selector: debugSelector, within: debugSelector.optional(), clickable: z.boolean().optional(), scrollable: z.boolean().optional(),
  target: z.enum(["self", "clickable-parent"]).default("self"),
}).strict().describe("selector 和 within 各字段精确匹配，必须唯一命中。clickable/scrollable 仅筛选节点，不授予输入权限；仍检查可见性、启用状态、窗口及遮挡。");
export const debugUiStepExpectation = z.object({ selector: debugSelector,
  state: z.enum(["visible", "absent", "enabled", "disabled"]).default("visible"),
}).strict();
export const performUiStepInput = z.object({
  sessionId, requestId: z.string().uuid(), target: debugUiStepTarget.optional(),
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
}).strict().superRefine((value, context) => {
  if (value.action.kind !== "back" && !value.target)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "点击和滚动必须提供唯一目标。" });
  if (value.action.kind === "back") {
    if (value.target) context.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "返回操作不能指定目标。" });
    if (value.visualConfirmation) context.addIssue({ code: z.ZodIssueCode.custom, path: ["visualConfirmation"], message: "返回操作不接受视觉确认。" });
  }
  if (value.action.kind === "scroll" && value.target?.target === "clickable-parent")
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target", "target"], message: "滚动不能使用 clickable-parent。" });
});
export const getUiStepInput = z.object({ sessionId, requestId: z.string().uuid() }).strict();
export const resumeUiStepInput = getUiStepInput.extend({ timeoutMs: z.number().int().min(1000).max(60_000).default(30_000) });
export type PerformUiStepInput = z.infer<typeof performUiStepInput>;
export type GetUiStepInput = z.infer<typeof getUiStepInput>;
export type ResumeUiStepInput = z.infer<typeof resumeUiStepInput>;

export const debugToolSchemas = {
  get_debug_session: z.object({}).strict(),
  define_debug_task: z.object({ sessionId, definition: debugTaskDefinition }).strict(),
  check_debug_task: z.object({ sessionId, taskId: z.string().uuid(), checkpointId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional() }).strict(),
  capture_ui: z.object({ sessionId, mode: z.enum(["fast", "deep"]).default("fast"),
    backend: z.enum(["uiautomator", "accessibility-helper"]).default("uiautomator") }).strict()
    .refine(value => value.mode === "fast" || value.backend === "uiautomator", "Helper只支持fast只读采集。"),
  perform_ui_step: performUiStepInput,
  get_ui_step: getUiStepInput,
  resume_ui_step: resumeUiStepInput,
  tap_node: z.object({ ...snapshotInput, nodeId, target: z.enum(["self", "clickable-parent"]).optional(), visualConfirmation: visualConfirmation.optional() }).strict(),
  scroll_node: z.object({ ...snapshotInput, nodeId,
    direction: z.enum(["up", "down", "left", "right"]).describe("内容查看方向：down 看下方内容，手指向上滑；right 看右侧内容，手指向左滑"),
    distance: z.number().min(0.1).max(0.8).default(0.6).describe("请求滑动距离占有效区域的比例，0.1–0.8；避让导航栏后保留两端至少20%的边距，实际距离最多60%"),
    durationMs: z.number().int().min(150).max(1000).default(350),
    visualConfirmation: visualConfirmation.optional(),
  }).strict(),
  press_back: z.object(snapshotInput).strict(),
  wait_for_ui: z.object({ sessionId, selector: debugSelector,
    state: z.enum(["visible", "absent", "enabled", "disabled"]).default("visible"),
    timeoutMs: z.number().int().min(1000).max(30_000).default(30_000),
  }).strict(),
  stop_debug_session: z.object({ sessionId }).strict(),
};

export const debugCommand = z.discriminatedUnion("name", [
  z.object({ name: z.literal("get_debug_session"), input: debugToolSchemas.get_debug_session }).strict(),
  z.object({ name: z.literal("define_debug_task"), input: debugToolSchemas.define_debug_task }).strict(),
  z.object({ name: z.literal("check_debug_task"), input: debugToolSchemas.check_debug_task }).strict(),
  z.object({ name: z.literal("capture_ui"), input: debugToolSchemas.capture_ui }).strict(),
  z.object({ name: z.literal("perform_ui_step"), input: debugToolSchemas.perform_ui_step }).strict(),
  z.object({ name: z.literal("get_ui_step"), input: debugToolSchemas.get_ui_step }).strict(),
  z.object({ name: z.literal("resume_ui_step"), input: debugToolSchemas.resume_ui_step }).strict(),
  z.object({ name: z.literal("tap_node"), input: debugToolSchemas.tap_node }).strict(),
  z.object({ name: z.literal("scroll_node"), input: debugToolSchemas.scroll_node }).strict(),
  z.object({ name: z.literal("press_back"), input: debugToolSchemas.press_back }).strict(),
  z.object({ name: z.literal("wait_for_ui"), input: debugToolSchemas.wait_for_ui }).strict(),
  z.object({ name: z.literal("stop_debug_session"), input: debugToolSchemas.stop_debug_session }).strict(),
]);
export type DebugCommand = z.infer<typeof debugCommand>;
