import { z } from "zod";
import { debugSelector } from "./debug-selector";
import { debugTaskDefinition } from "./debug-task";
import { debugPlanDefinition } from "./debug-plan";
import { debugConditionState, debugConditionVisibility, refineDebugCondition } from "./debug-ui-condition";
import { debugObservationBackend as observationBackend, getUiStepInput, performUiStepInput, resumeUiStepInput, scrollUntilInput } from "./debug-step-input";
export { debugSelector, matchesDebugSelector } from "./debug-selector";
export { debugUiStepTarget, debugUiStepExpectation, getUiStepInput, performUiStepInput, resumeUiStepInput, scrollUntilInput } from "./debug-step-input";
export type { PerformUiStepInput, GetUiStepInput, ResumeUiStepInput, ScrollUntilInput } from "./debug-step-input";

const sessionId = z.string().uuid();
const snapshotInput = { sessionId, snapshotId: z.string().uuid() };
const nodeId = z.string().min(1).max(2048);
const visualConfirmation = z.object({ description: z.string().trim().min(1).max(512) }).strict()
  .describe("仅当 Agent 已查看本次 snapshotId 的整屏截图并确认目标可见时提供，description 描述实际看到的目标；不是 force，也不要求用户额外许可。执行前仍核对目标区域像素、身份、窗口及授权范围。");

export const debugToolSchemas = {
  get_debug_session: z.object({}).strict(),
  start_debug_plan: z.object({ sessionId, runId: z.string().uuid(), definition: debugPlanDefinition }).strict(),
  get_debug_plan: z.object({ sessionId, runId: z.string().uuid() }).strict(),
  cancel_debug_plan: z.object({ sessionId, runId: z.string().uuid() }).strict(),
  define_debug_task: z.object({ sessionId, definition: debugTaskDefinition }).strict(),
  check_debug_task: z.object({ sessionId, taskId: z.string().uuid(), checkpointId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional() }).strict(),
  capture_ui: z.object({ sessionId, mode: z.enum(["fast", "deep"]).default("fast"),
    backend: observationBackend }).strict()
    .refine(value => value.mode === "fast" || value.backend === "uiautomator", "Helper只支持fast采集。"),
  perform_ui_step: performUiStepInput,
  get_ui_step: getUiStepInput,
  resume_ui_step: resumeUiStepInput,
  scroll_until: scrollUntilInput,
  tap_node: z.object({ ...snapshotInput, nodeId, target: z.enum(["self", "clickable-parent"]).optional(), visualConfirmation: visualConfirmation.optional() }).strict(),
  scroll_node: z.object({ ...snapshotInput, nodeId,
    direction: z.enum(["up", "down", "left", "right"]).describe("内容查看方向：down 看下方内容，手指向上滑；right 看右侧内容，手指向左滑"),
    distance: z.number().min(0.1).max(0.8).default(0.6).describe("请求滑动距离占有效区域的比例，0.1–0.8；避让导航栏后保留两端至少20%的边距，实际距离最多60%"),
    durationMs: z.number().int().min(150).max(1000).default(350),
    visualConfirmation: visualConfirmation.optional(),
  }).strict(),
  press_back: z.object(snapshotInput).strict(),
  wait_for_ui: z.object({ sessionId, selector: debugSelector,
    backend: observationBackend.removeDefault().optional(),
    state: debugConditionState.default("visible"), visibility: debugConditionVisibility,
    timeoutMs: z.number().int().min(1000).max(30_000).default(30_000),
  }).strict().superRefine(refineDebugCondition),
  stop_debug_session: z.object({ sessionId }).strict(),
};

export const debugCommand = z.discriminatedUnion("name", [
  z.object({ name: z.literal("get_debug_session"), input: debugToolSchemas.get_debug_session }).strict(),
  z.object({ name: z.literal("start_debug_plan"), input: debugToolSchemas.start_debug_plan }).strict(),
  z.object({ name: z.literal("get_debug_plan"), input: debugToolSchemas.get_debug_plan }).strict(),
  z.object({ name: z.literal("cancel_debug_plan"), input: debugToolSchemas.cancel_debug_plan }).strict(),
  z.object({ name: z.literal("define_debug_task"), input: debugToolSchemas.define_debug_task }).strict(),
  z.object({ name: z.literal("check_debug_task"), input: debugToolSchemas.check_debug_task }).strict(),
  z.object({ name: z.literal("capture_ui"), input: debugToolSchemas.capture_ui }).strict(),
  z.object({ name: z.literal("perform_ui_step"), input: debugToolSchemas.perform_ui_step }).strict(),
  z.object({ name: z.literal("get_ui_step"), input: debugToolSchemas.get_ui_step }).strict(),
  z.object({ name: z.literal("resume_ui_step"), input: debugToolSchemas.resume_ui_step }).strict(),
  z.object({ name: z.literal("scroll_until"), input: debugToolSchemas.scroll_until }).strict(),
  z.object({ name: z.literal("tap_node"), input: debugToolSchemas.tap_node }).strict(),
  z.object({ name: z.literal("scroll_node"), input: debugToolSchemas.scroll_node }).strict(),
  z.object({ name: z.literal("press_back"), input: debugToolSchemas.press_back }).strict(),
  z.object({ name: z.literal("wait_for_ui"), input: debugToolSchemas.wait_for_ui }).strict(),
  z.object({ name: z.literal("stop_debug_session"), input: debugToolSchemas.stop_debug_session }).strict(),
]);
export type DebugCommand = z.infer<typeof debugCommand>;
