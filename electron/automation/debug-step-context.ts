import type { DebugCommand } from "../../shared/debug-protocol";
import type { DebugStep, DebugStepError } from "../../shared/types";
import type { DebugTaskCondition, DebugTaskEvidence } from "../../shared/debug-task";
import type { DebugLogCapture } from "../../shared/debug-report";
import type { DebugObserver } from "./device-actions";
import type { DebugTarget } from "../device/target";
import { DebugInputError } from "../device/debug-input";
import { HelperCaptureError } from "../capture/accessibility-helper";
import { DebugObservationError } from "./debug-observation-error";
import { ObservationRecoveryTimeoutError } from "./debug-observation-recovery";
import type { McpSnapshot } from "./mcp-snapshot";
import { debugLogConfigurationSecrets, sanitizeDebugLogText, type DebugLogWindow } from "./debug-logs";

export type Observation = Awaited<ReturnType<DebugObserver>>;
export type Current = { entry: McpSnapshot; target: DebugTarget };
export type StepCommand = Exclude<DebugCommand, { name: "get_debug_session" | "stop_debug_session" | "get_ui_step"
  | "start_debug_plan" | "get_debug_plan" | "cancel_debug_plan" }>;

/** Mutable facts for one owned step, shared by execution and its final evidence record. */
export type StepContext = {
  step: DebugStep;
  started: number; phase: DebugStepError["phase"]; before: McpSnapshot | null;
  beforeFreshness: "current" | "previous"; after: McpSnapshot | null; previousAfter: McpSnapshot | null;
  invalidatedAfter: boolean;
  strictConditions?: boolean;
  scrollObservations?: McpSnapshot[];
  assertionObservations?: McpSnapshot[];
  logs?: DebugLogCapture[];
  logWindow?: DebugLogWindow;
  finishedAt?: string;
  task?: { taskId: string; checkpointId: string | null; conditions: DebugTaskCondition[];
    first: DebugTaskEvidence | null; second: DebugTaskEvidence | null };
  verification?: { completedObservations: number; lastVisibleMatchCount: number | null;
    matchedObservations: number; consecutiveMatches: number; unrecoveredObservationFailures: number };
};

export const debugStepMessage = (error: unknown) => error instanceof Error
  ? sanitizeDebugLogText(error.message, debugLogConfigurationSecrets()).slice(0, 16000) : "操作失败。";

export function debugStepFailure(error: unknown, context: StepContext, timedOut: boolean, cancelled: boolean): DebugStepError {
  const helperDiagnostics = (error instanceof HelperCaptureError ? error.diagnostics : undefined)
    ?? context.step.observationFailures?.slice().reverse().find(item => item.error.helperDiagnostics)?.error.helperDiagnostics;
  const diagnostics = helperDiagnostics ? { helperDiagnostics } : {};
  if (timedOut) {
    const verification = context.verification;
    if (verification && verification.completedObservations >= 2 && verification.matchedObservations === 0
      && verification.consecutiveMatches === 0 && verification.lastVisibleMatchCount !== null && verification.unrecoveredObservationFailures === 0)
      return { category: "timeout", code: "expectation_not_met_timeout", phase: "verify",
        message: `验证达到时限：已完成 ${verification.completedObservations} 次完整观察，预期均未满足；最后可见匹配数 ${verification.lastVisibleMatchCount}。此结果不代表输入未生效。`, ...diagnostics };
    return { category: "timeout", code: "timeout", phase: context.phase, message: "操作超过本次时限，未验证成功。", ...diagnostics };
  }
  if (cancelled) return { category: "cancelled", code: "cancelled", phase: context.phase, message: debugStepMessage(error), ...diagnostics };
  if (error instanceof ObservationRecoveryTimeoutError) return { category: "timeout", code: "observation_recovery_timeout", phase: context.phase, message: error.message, ...diagnostics };
  if (error instanceof DebugInputError) return { category: "input", code: error.evidence.classification, phase: "input", message: debugStepMessage(error) };
  if (error instanceof HelperCaptureError) return { category: context.phase, code: /^helper-[a-z-]{1,64}$/.test(error.code) ? error.code : "helper-capture-failed",
    phase: context.phase, message: debugStepMessage(error), ...diagnostics };
  if (error instanceof DebugObservationError) return { category: context.phase, code: error.code, phase: context.phase, message: debugStepMessage(error) };
  return { category: context.phase, code: `${context.phase}_failed`, phase: context.phase, message: debugStepMessage(error) };
}
