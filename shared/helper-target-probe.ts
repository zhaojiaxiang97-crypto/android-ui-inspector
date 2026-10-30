import { z } from "zod";
import { helperInputRequest, helperInputReply } from "./helper-input";

const { action: _action, target, ...identity } = helperInputRequest.shape;
/** No input action or gesture coordinates; exact target bounds use the input path's validation. */
export const helperTargetProbeRequest = z.object({ ...identity, target: target.unwrap() }).strict().refine(input =>
  helperInputRequest.safeParse({ ...input, action: { kind: "tap", x: input.target.bounds.left, y: input.target.bounds.top } }).success,
"Helper 只读预检目标无效。");
const { startedAtMs, finishedAtMs, mainStartedAtMs, preflightStage, preflightStageStartedAtMs, scanDiagnostics, errorCode } = helperInputReply.shape;
export const helperTargetProbeReply = z.object({ ...identity, readOnly: z.literal(true), dispatchState: z.literal("not_sent"),
  status: z.enum(["completed", "timeout", "rejected"]), startedAtMs, finishedAtMs, mainStartedAtMs,
  preflightStage, preflightStageStartedAtMs, scanDiagnostics, errorCode }).strict().superRefine((reply, context) => {
  const fail = () => context.addIssue({ code: "custom", message: "Helper 只读预检时序或状态无效。" });
  if (reply.finishedAtMs < reply.startedAtMs || reply.finishedAtMs - reply.startedAtMs > 7000) fail();
  if (reply.status === "completed" ? reply.errorCode !== undefined || !reply.scanDiagnostics || reply.preflightStage !== "final_checks"
    : reply.errorCode === undefined || (reply.status === "timeout" ? reply.errorCode !== "timeout" : reply.errorCode === "timeout")) fail();
  if (reply.mainStartedAtMs !== undefined && (reply.mainStartedAtMs < reply.startedAtMs || reply.mainStartedAtMs > reply.finishedAtMs)) fail();
  if ((reply.preflightStage === undefined) !== (reply.preflightStageStartedAtMs === undefined)) fail();
  if (reply.preflightStageStartedAtMs !== undefined && (reply.mainStartedAtMs === undefined
    || reply.preflightStageStartedAtMs < reply.mainStartedAtMs || reply.preflightStageStartedAtMs > reply.finishedAtMs)) fail();
  const scan = reply.scanDiagnostics;
  if (scan && (!["target_scan", "target_refresh", "window_recheck", "final_checks"].includes(reply.preflightStage ?? "")
    || reply.preflightStage === "target_scan" && scan.scanStartedAtMs < reply.preflightStageStartedAtMs!
    || reply.mainStartedAtMs === undefined || scan.scanStartedAtMs < reply.mainStartedAtMs
    || scan.operationStartedAtMs < scan.scanStartedAtMs || scan.operationStartedAtMs > reply.finishedAtMs
    || scan.childReadTotalMs > reply.finishedAtMs - scan.scanStartedAtMs)) fail();
  if (reply.status === "completed" && scan && (scan.operation !== "node" || scan.childReadsStarted !== scan.childReadsCompleted)) fail();
});
export type HelperTargetProbeRequest = z.infer<typeof helperTargetProbeRequest>;
export type HelperTargetProbeReply = z.infer<typeof helperTargetProbeReply>;
