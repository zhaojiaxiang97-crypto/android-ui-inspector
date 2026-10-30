import { z } from "zod";

/** Closed, non-textual protocol: never retain an exception, page field, token, or arbitrary key. */
export const helperObservationDiagnosticCodes = [
  "windows_unavailable", "duplicate_window_id", "non_default_display", "window_root_unavailable",
  "window_root_mismatch", "window_bounds_invalid", "window_id_invalid", "window_type_unknown", "window_read_failed",
  "node_window_mismatch", "child_unavailable", "node_read_failed", "tree_truncated", "display_changed",
  "window_inventory_changed", "focus_invalid", "screenshot_size_mismatch", "cache_clear_failed", "capture_exception",
] as const;

export const helperObservationDiagnosticsSchema = z.object({
  version: z.literal(1),
  reasons: z.array(z.object({ code: z.enum(helperObservationDiagnosticCodes), count: z.number().int().min(1).max(10000) }).strict())
    .max(helperObservationDiagnosticCodes.length),
}).strict().refine(value => new Set(value.reasons.map(reason => reason.code)).size === value.reasons.length,
  "Duplicate Helper diagnostic code");

export type HelperObservationDiagnostics = z.infer<typeof helperObservationDiagnosticsSchema>;

export function parseHelperObservationDiagnostics(value: unknown): HelperObservationDiagnostics | undefined {
  const parsed = helperObservationDiagnosticsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Only a known null child or changed inventory can justify another read, never another input. */
export function hasTransientHelperDiagnostics(value: unknown): value is HelperObservationDiagnostics {
  const parsed = parseHelperObservationDiagnostics(value);
  return !!parsed?.reasons.length && parsed.reasons.every(reason =>
    reason.code === "child_unavailable" || reason.code === "window_inventory_changed");
}
