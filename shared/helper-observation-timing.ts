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
