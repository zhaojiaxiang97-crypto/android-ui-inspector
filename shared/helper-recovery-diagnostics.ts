import { z } from "zod";

// Fixed diagnostic values only. Never carry package names, window IDs, page fields or parser errors.
export const helperRecoveryCandidateReasons = ["accepted", "metadata_invalid", "display_mismatch", "motion_context_invalid",
  "motion_focus_missing", "motion_not_horizontal", "motion_inventory_invalid", "motion_other_fields_changed",
  "inventory_before_invalid", "inventory_after_invalid", "system_gap_invalid", "empty_identity_transition_invalid",
  "diagnostics_not_transient", "identity_mismatch", "focus_before_invalid", "focus_after_invalid",
  "transition_focus_after_invalid", "focused_id_mismatch", "inventory_claim_mismatch", "diagnostics_mismatch"] as const;
export const helperRecoverySourceReasons = ["accepted", "package_anchor_missing", "previous_invalid", "next_invalid", "package_changed",
  "display_changed", "service_changed", "capture_reused", "capture_time_regressed"] as const;
const count = z.number().int().min(0).max(32);
const bounds = z.object({ x: z.number().int().safe(), y: z.number().int().safe(), width: z.number().int().nonnegative().safe(),
  height: z.number().int().nonnegative().safe() }).strict();
const fields = ["type", "layer", "active", "focused", "package", "root", "x", "y", "width", "height"] as const;
const role = z.enum(["authorized_application", "other_application", "system", "input_method", "other"]);
export const helperRecoverySections = ["envelope", "tree", "image", "identity", "timing", "display", "windows", "diagnostics", "metadata", "unknown_fields"] as const;
export type HelperRecoverySection = typeof helperRecoverySections[number];
const change = z.object({ kind: z.enum(["added", "removed", "changed"]), beforeRole: role.optional(), afterRole: role.optional(),
  fields: z.array(z.enum(fields)).max(fields.length).refine(values => new Set(values).size === values.length),
  beforeBounds: bounds.optional(), afterBounds: bounds.optional() }).strict();
export const helperRecoveryDiagnosticsSchema = z.object({
  version: z.literal(1),
  transport: z.enum(["accepted", "failure_not_recoverable", "envelope_invalid", "display_mismatch", "window_count_mismatch"]).optional(),
  candidate: z.enum(helperRecoveryCandidateReasons).optional(),
  source: z.enum(helperRecoverySourceReasons).optional(),
  session: z.enum(["accepted", "sent_receipt_required", "service_changed", "source_rejected", "before_wait_receipt",
    "before_input_receipt", "binding_check_failed", "cleanup_failed"]).optional(),
  cleanupFailed: z.literal(true).optional(),
  executor: z.enum(["retry", "candidate_unavailable", "source_unavailable", "backend_mismatch", "scroll_scope_changed",
    "input_not_sent", "navigation_only", "source_rejected", "budget_exhausted"]).optional(),
  invalidSections: z.array(z.enum(helperRecoverySections)).min(1).max(helperRecoverySections.length)
    .refine(values => new Set(values).size === values.length).optional(),
  windows: z.object({ beforeCount: count, afterCount: count, beforeFocusCount: count, afterFocusCount: count,
    beforeActiveCount: count, afterActiveCount: count, changes: z.array(change).max(32) }).strict().optional(),
}).strict().refine(value => [value.transport, value.candidate, value.source, value.session, value.executor].some(Boolean));
export type HelperRecoveryDiagnostics = z.infer<typeof helperRecoveryDiagnosticsSchema>;
export type HelperRecoveryCandidateReason = typeof helperRecoveryCandidateReasons[number];
export type HelperRecoverySourceReason = typeof helperRecoverySourceReasons[number];

export function parseHelperRecoveryDiagnostics(value: unknown): HelperRecoveryDiagnostics | undefined {
  const parsed = helperRecoveryDiagnosticsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
