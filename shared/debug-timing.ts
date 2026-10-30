import { z } from "zod";
import { helperObservationTimingSchema, helperServerTimingSchema } from "./helper-observation-timing";

export const DEBUG_TIMING_SPAN_LIMIT = 2048;
export const debugTimingPhases = ["queue", "observation", "target_before", "hierarchy", "screenshot", "geometry", "target_after", "parse", "cleanup",
  "relocation", "validation", "verification", "input", "recovery", "save", "serialization", "attachments", "deep_capture", "device_command",
  "helper_request", "helper_request_headers", "helper_response_read", "helper_json_parse", "helper_tree", "helper_png_validation",
  "helper_ready_probe"] as const;
export const debugCommandCategories = ["target", "display", "hierarchy_dump", "hierarchy_read", "screenshot", "cleanup", "input", "forward", "device_query", "other"] as const;
export const debugObservationReasons = ["explicit", "before_action", "after_action", "recovery", "verification", "unspecified"] as const;
export type DebugTimingPhase = typeof debugTimingPhases[number];
export type DebugCommandCategory = typeof debugCommandCategories[number];
export type DebugObservationReason = typeof debugObservationReasons[number];
export type DebugTimingOutcome = "success" | "failed" | "cancelled";
const duration = z.number().finite().nonnegative();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const debugTimingSpanSchema = z.object({
  id: z.number().int().positive(), parentId: z.number().int().positive().nullable(), phase: z.enum(debugTimingPhases),
  startOffsetMs: duration, durationMs: duration, status: z.enum(["running", "success", "failed", "cancelled"]),
  commandCategory: z.enum(debugCommandCategories).optional(),
  backend: z.enum(["uiautomator", "accessibility-helper", "deep"]).optional(),
  reason: z.enum(debugObservationReasons).optional(),
  helperEndpoint: z.enum(["capabilities", "snapshot"]).optional(),
  helperDeviceTiming: helperObservationTimingSchema.optional(),
  helperReportedComplete: z.boolean().optional(),
  helperServerTiming: helperServerTimingSchema.optional(),
}).strict().superRefine((span, ctx) => {
  const device = span.helperDeviceTiming !== undefined, complete = span.helperReportedComplete !== undefined;
  if (span.helperEndpoint !== undefined && !["helper_request", "helper_request_headers", "helper_response_read", "helper_json_parse"].includes(span.phase)
    || (device || complete) && (span.phase !== "helper_tree" || device !== complete)
    || span.helperServerTiming !== undefined && (span.phase !== "helper_request_headers" || span.helperEndpoint !== "snapshot"))
    ctx.addIssue({ code: "custom", message: "Helper 计时元数据的相位或完整性标记不一致" });
});
export type DebugTimingSpan = z.infer<typeof debugTimingSpanSchema>;
export const debugTimingsSchema = z.object({
  version: z.literal(1), correlationId: z.string().uuid(), startedAt: z.string().datetime({ offset: true }),
  durationMs: duration, status: z.enum(["running", "success", "failed", "cancelled"]),
  spans: z.array(debugTimingSpanSchema).max(DEBUG_TIMING_SPAN_LIMIT), droppedSpans: count,
  commandCount: count, commandCounts: z.partialRecord(z.enum(debugCommandCategories), count),
  observationCount: count, observationCounts: z.partialRecord(z.enum(debugObservationReasons), count),
}).strict().superRefine((value, ctx) => {
  const spans = new Map<number, DebugTimingSpan>();
  for (const span of value.spans) {
    const parent = span.parentId === null ? null : spans.get(span.parentId);
    if (spans.has(span.id) || span.parentId !== null && !parent
      || span.startOffsetMs + span.durationMs > value.durationMs + 0.01
      || parent && (span.startOffsetMs < parent.startOffsetMs - 0.01
        || span.startOffsetMs + span.durationMs > parent.startOffsetMs + parent.durationMs + 0.01)
      || (span.phase === "device_command") !== Boolean(span.commandCategory)
      || value.status !== "running" && span.status === "running"
      || span.phase !== "observation" && (span.backend || span.reason)) {
      ctx.addIssue({ code: "custom", message: "计时区间、父区间或类别不一致" });
      return;
    }
    spans.set(span.id, span);
  }
  for (const [total, counts, phase, key] of [
    [value.commandCount, value.commandCounts, "device_command", "commandCategory"],
    [value.observationCount, value.observationCounts, "observation", "reason"],
  ] as const) {
    const recorded = value.spans.filter(span => span.phase === phase);
    const categories = new Map<string | undefined, number>();
    for (const span of recorded) categories.set(span[key], (categories.get(span[key]) ?? 0) + 1);
    if (Object.values(counts).reduce((sum, number) => sum + number, 0) !== total
      || recorded.length > total || value.droppedSpans === 0 && recorded.length !== total
      || [...categories].some(([category, number]) => number > (counts[category as keyof typeof counts] ?? 0))) {
      ctx.addIssue({ code: "custom", message: "计时次数与区间不一致" });
    }
  }
});
export type DebugTimings = z.infer<typeof debugTimingsSchema>;
export function isDebugTimings(value: unknown): value is DebugTimings { return debugTimingsSchema.safeParse(value).success; }

/** Union of measured intervals: parallel and nested work is counted only once. */
export function debugTimingCoveredMs(timings: DebugTimings) {
  const ranges = timings.spans.map(span => [span.startOffsetMs, span.startOffsetMs + span.durationMs] as const).sort((a, b) => a[0] - b[0]);
  let duration = 0, end = 0;
  for (const [start, finish] of ranges) { duration += Math.max(0, finish - Math.max(start, end)); end = Math.max(end, finish); }
  return Math.min(timings.durationMs, duration);
}

export const debugTimingPhaseLabels: Record<DebugTimingPhase, string> = {
  queue: "排队", observation: "观察", target_before: "采集前目标检查", hierarchy: "读取控件树", screenshot: "截图", geometry: "几何检查",
  target_after: "采集后目标检查", parse: "解析控件树", cleanup: "清理临时文件", relocation: "重新定位", validation: "操作校验", verification: "结果验证", input: "发送输入",
  recovery: "恢复观察", save: "保存证据", serialization: "序列化", attachments: "处理附件", deep_capture: "深度采集", device_command: "设备命令",
  helper_request: "Helper 请求", helper_ready_probe: "Helper 就绪探针", helper_request_headers: "Helper 等待响应头", helper_response_read: "Helper 读取响应正文",
  helper_json_parse: "Helper 解析 JSON", helper_tree: "Helper 处理控件树", helper_png_validation: "Helper 校验 PNG",
};
export const debugCommandCategoryLabels: Record<DebugCommandCategory, string> = {
  target: "目标检查", display: "屏幕查询", hierarchy_dump: "生成控件树", hierarchy_read: "读取控件树", screenshot: "截图", cleanup: "清理",
  input: "输入", forward: "连接转发", device_query: "设备查询", other: "其他",
};
export const debugObservationReasonLabels: Record<DebugObservationReason, string> = {
  explicit: "显式采集", before_action: "操作前", after_action: "操作后", recovery: "恢复", verification: "验证", unspecified: "未标注",
};
