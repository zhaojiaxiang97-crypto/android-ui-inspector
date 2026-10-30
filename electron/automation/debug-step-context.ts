import type { DebugCommand } from "../../shared/debug-protocol";
import type { DebugStep, DebugStepError } from "../../shared/types";
import type { DebugTaskCondition, DebugTaskEvidence } from "../../shared/debug-task";
import type { DebugLogCapture } from "../../shared/debug-report";
import type { DebugObserver } from "./device-actions";
import type { DebugTarget } from "../device/target";
import { DebugInputError } from "../device/debug-input";
import type { McpSnapshot } from "./mcp-snapshot";
import { debugLogConfigurationSecrets, sanitizeDebugLogText, type DebugLogWindow } from "./debug-logs";

export type Observation = Awaited<ReturnType<DebugObserver>>;
export type Current = { entry: McpSnapshot; target: DebugTarget };
export type StepCommand = Exclude<DebugCommand, { name: "get_debug_session" | "stop_debug_session" }>;

/** Mutable facts for one owned step, shared by execution and its final evidence record. */
export type StepContext = {
  step: DebugStep;
  started: number; phase: DebugStepError["phase"]; before: McpSnapshot | null;
  beforeFreshness: "current" | "previous"; after: McpSnapshot | null; previousAfter: McpSnapshot | null;
  invalidatedAfter: boolean;
  logs?: DebugLogCapture[];
  logWindow?: DebugLogWindow;
  finishedAt?: string;
  task?: { taskId: string; checkpointId: string | null; conditions: DebugTaskCondition[];
    first: DebugTaskEvidence | null; second: DebugTaskEvidence | null };
};

export const debugStepMessage = (error: unknown) => error instanceof Error
  ? sanitizeDebugLogText(error.message, debugLogConfigurationSecrets()).slice(0, 16000) : "操作失败。";

export function debugStepFailure(error: unknown, context: StepContext, timedOut: boolean, cancelled: boolean): DebugStepError {
  if (timedOut) return { category: "timeout", code: "timeout", phase: context.phase, message: "操作超过本次时限，未验证成功。" };
  if (cancelled) return { category: "cancelled", code: "cancelled", phase: context.phase, message: debugStepMessage(error) };
  if (error instanceof DebugInputError) return { category: "input", code: error.evidence.classification, phase: "input", message: debugStepMessage(error) };
  return { category: context.phase, code: `${context.phase}_failed`, phase: context.phase, message: debugStepMessage(error) };
}
