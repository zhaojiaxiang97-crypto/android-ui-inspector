import { z } from "zod";
import { debugSelector } from "./debug-selector";
import { debugConditionState, debugConditionVisibility, refineDebugCondition } from "./debug-ui-condition";
import type { UiSnapshot } from "./types";

const key = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);
const text = z.string().min(1).max(16000);
const date = z.string().datetime({ offset: true });
export const debugTaskStatus = z.enum(["passed", "failed", "insufficient_evidence"]);
export const debugTaskCondition = z.object({
  id: key, selector: debugSelector, state: debugConditionState, visibility: debugConditionVisibility,
}).strict().superRefine(refineDebugCondition);
export const debugTaskDefinition = z.object({
  goal: z.string().trim().min(1).max(1024),
  checkpoints: z.array(z.object({ id: key, title: z.string().trim().min(1).max(256),
    conditions: z.array(debugTaskCondition).min(1).max(10) }).strict()).max(5).default([]),
  finalConditions: z.array(debugTaskCondition).min(1).max(10),
}).strict().superRefine((definition, context) => {
  const checkpoints = definition.checkpoints.map(item => item.id);
  const conditions = [...definition.checkpoints.flatMap(item => item.conditions), ...definition.finalConditions].map(item => item.id);
  if (new Set(checkpoints).size !== checkpoints.length || new Set(conditions).size !== conditions.length)
    context.addIssue({ code: "custom", message: "阶段编号和条件编号必须分别唯一。" });
  if (conditions.length > 20) context.addIssue({ code: "custom", message: "整个任务最多20个验收条件。" });
  if (new TextEncoder().encode(JSON.stringify(definition)).length > 12000)
    context.addIssue({ code: "custom", message: "任务定义超过12KB，请缩小目标与条件。" });
});
export const debugTaskObservation = z.object({
  snapshotId: z.string().uuid(), capturedAt: date,
  component: z.string().min(1).max(512), windowId: z.string().min(1).max(2048),
  activityRecordId: z.string().min(1).max(512).nullable(),
}).strict();
export const debugTaskConditionResult = z.object({
  conditionId: key, status: debugTaskStatus, reason: text,
  firstMatchCount: z.number().int().nonnegative().max(20000), secondMatchCount: z.number().int().nonnegative().max(20000),
  firstNodeId: z.string().min(1).max(2048).nullable(), secondNodeId: z.string().min(1).max(2048).nullable(),
}).strict();
export const debugTaskCheckResult = z.object({
  taskId: z.string().uuid(), checkpointId: key.nullable(), stepId: z.number().int().positive(), checkedAt: date,
  status: debugTaskStatus, reason: text,
  observations: z.object({ first: debugTaskObservation.nullable(), second: debugTaskObservation.nullable() }).strict(),
  conditions: z.array(debugTaskConditionResult).max(10),
}).strict();
export const debugTaskRecord = z.object({
  id: z.string().uuid(), definedAt: date, definedStepId: z.number().int().positive(),
  definition: debugTaskDefinition,
  checks: z.array(debugTaskCheckResult).max(6),
}).strict();
export type DebugTaskDefinition = z.infer<typeof debugTaskDefinition>;
export type DebugTaskCondition = z.infer<typeof debugTaskCondition>;
export type DebugTaskConditionResult = z.infer<typeof debugTaskConditionResult>;
export type DebugTaskObservation = z.infer<typeof debugTaskObservation>;
export type DebugTaskCheckResult = z.infer<typeof debugTaskCheckResult>;
export type DebugTaskRecord = z.infer<typeof debugTaskRecord>;
export type DebugTaskStatus = z.infer<typeof debugTaskStatus>;
export type DebugTaskEvidence = { observation: DebugTaskObservation; snapshot: UiSnapshot };
export type DebugTaskAssessment = Pick<DebugTaskCheckResult, "status" | "reason" | "conditions">;
