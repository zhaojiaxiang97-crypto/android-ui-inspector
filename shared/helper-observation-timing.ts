import { z } from "zod";

const timestamp = z.number().int().nonnegative().safe();

/** Device elapsedRealtime milliseconds; never place these offsets on the host's timeline. */
export const helperPostProcessingTimingSchema = z.object({
  windowValidationStartedAtMs: timestamp,
  windowValidationCompletedAtMs: timestamp,
  pngEncodingStartedAtMs: timestamp,
  pngEncodingCompletedAtMs: timestamp,
  base64EncodingStartedAtMs: timestamp,
  base64EncodingCompletedAtMs: timestamp,
}).strict();

/** Optional v1 extension: an older Helper omits postProcessing, rather than reporting zero work. */
export const helperObservationTimingSchema = z.object({
  startedAtMs: timestamp,
  hierarchyStartedAtMs: timestamp,
  hierarchyCompletedAtMs: timestamp,
  screenshotStartedAtMs: timestamp,
  screenshotCompletedAtMs: timestamp,
  completedAtMs: timestamp,
  postProcessing: helperPostProcessingTimingSchema.optional(),
}).strict().superRefine((timing, context) => {
  const post = timing.postProcessing;
  const sequence = [timing.startedAtMs, timing.hierarchyStartedAtMs, timing.hierarchyCompletedAtMs,
    timing.screenshotStartedAtMs, timing.screenshotCompletedAtMs,
    ...(post ? [post.windowValidationStartedAtMs, post.windowValidationCompletedAtMs,
      post.pngEncodingStartedAtMs, post.pngEncodingCompletedAtMs,
      post.base64EncodingStartedAtMs, post.base64EncodingCompletedAtMs] : []), timing.completedAtMs];
  if (sequence.some((value, index) => index > 0 && value < sequence[index - 1])
    || timing.completedAtMs - timing.startedAtMs > 30_000)
    context.addIssue({ code: "custom", message: "Helper 计时顺序、范围或总时长无效。" });
});

export type HelperObservationTiming = z.infer<typeof helperObservationTimingSchema>;

export const HELPER_SNAPSHOT_TIMING_HEADER = "X-Inspector-Snapshot-Timing";
const serverDuration = z.number().finite().min(0).max(60_000)
  .refine(value => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7, "服务计时最多保留三位小数。");

/** Diagnostic durations only; absent stages are unknown, and never authorize a capture. */
export const helperServerTimingSchema = z.object({
  version: z.literal(1), queueMs: serverDuration, preObservationMs: serverDuration,
  observationMs: serverDuration, jsonSerializationMs: serverDuration, utf8EncodingMs: serverDuration,
  cacheClearMs: serverDuration.optional(), initialWindowReadMs: serverDuration.optional(),
  getChildMs: serverDuration.optional(), nodeLocalMs: serverDuration.optional(),
}).strict().superRefine((timing, context) => {
  const tree = (timing.cacheClearMs ?? 0) + (timing.initialWindowReadMs ?? 0) + (timing.getChildMs ?? 0) + (timing.nodeLocalMs ?? 0);
  // These four measured slices are disjoint; allow their independent 3-decimal rounding.
  if (tree > timing.observationMs + 0.01)
    context.addIssue({ code: "custom", message: "树子阶段超过服务观察时长。" });
});
export type HelperServerTiming = z.infer<typeof helperServerTimingSchema>;

/** Ignore malformed optional diagnostics without changing the response's capture validity. */
export function parseHelperServerTimingHeader(value: string | null | undefined): HelperServerTiming | undefined {
  if (!value || value.length > 512 || !/^[\x20-\x7e]+$/.test(value)) return undefined;
  const allowed = ["queueMs", "preObservationMs", "observationMs", "jsonSerializationMs", "utf8EncodingMs",
    "cacheClearMs", "initialWindowReadMs", "getChildMs", "nodeLocalMs"];
  const fields: Record<string, number> = {};
  for (const part of value.split(";")) {
    const pair = part.split("=");
    if (pair.length !== 2) return undefined;
    const [key, raw] = pair;
    if (key === "v") {
      if (raw !== "1" || Object.prototype.hasOwnProperty.call(fields, "version")) return undefined;
      fields.version = 1;
    } else {
      if (!allowed.includes(key) || Object.prototype.hasOwnProperty.call(fields, key) || !/^(?:0|[1-9]\d{0,4})\.\d{3}$/.test(raw)) return undefined;
      fields[key] = Number(raw);
    }
  }
  const parsed = helperServerTimingSchema.safeParse(fields);
  return parsed.success ? parsed.data : undefined;
}
