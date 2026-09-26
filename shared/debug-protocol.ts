import { z } from "zod";
import type { UiNode } from "./types";

const sessionId = z.string().uuid();
const snapshotInput = { sessionId, snapshotId: z.string().uuid() };
const nodeId = z.string().min(1).max(2048);
const selectorText = z.string().min(1).max(512);
export const debugSelector = z.object({
  resourceId: selectorText.optional(), text: selectorText.optional(), contentDesc: selectorText.optional(), className: selectorText.optional(),
}).strict().refine(value => Object.values(value).some(item => item !== undefined), "至少指定一个精确匹配条件");

export function matchesDebugSelector(node: UiNode, selector: z.infer<typeof debugSelector>) {
  return Object.entries(selector).every(([key, value]) => value === undefined || node[key as keyof UiNode] === value);
}

export const debugToolSchemas = {
  get_debug_session: z.object({}).strict(),
  capture_ui: z.object({ sessionId, mode: z.enum(["fast", "deep"]).default("fast") }).strict(),
  tap_node: z.object({ ...snapshotInput, nodeId }).strict(),
  scroll_node: z.object({ ...snapshotInput, nodeId,
    direction: z.enum(["up", "down", "left", "right"]).describe("内容查看方向：down 看下方内容，手指向上滑；right 看右侧内容，手指向左滑"),
    distance: z.number().min(0.1).max(0.8).default(0.6).describe("滑动距离占控件可见区域的比例，0.1–0.8"),
    durationMs: z.number().int().min(150).max(1000).default(350),
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
  z.object({ name: z.literal("capture_ui"), input: debugToolSchemas.capture_ui }).strict(),
  z.object({ name: z.literal("tap_node"), input: debugToolSchemas.tap_node }).strict(),
  z.object({ name: z.literal("scroll_node"), input: debugToolSchemas.scroll_node }).strict(),
  z.object({ name: z.literal("press_back"), input: debugToolSchemas.press_back }).strict(),
  z.object({ name: z.literal("wait_for_ui"), input: debugToolSchemas.wait_for_ui }).strict(),
  z.object({ name: z.literal("stop_debug_session"), input: debugToolSchemas.stop_debug_session }).strict(),
]);
export type DebugCommand = z.infer<typeof debugCommand>;
