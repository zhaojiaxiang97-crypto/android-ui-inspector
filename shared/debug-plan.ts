import { z } from "zod";
import { debugObservationBackend, debugUiStepExpectation, performUiStepInputBase, refineDebugUiStepInput, scrollUntilInputBase, scrollInputMethodError } from "./debug-step-input";

const stepId = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);
const conditionalStep = { id: stepId, when: debugUiStepExpectation.optional() };
const ownedFields = { sessionId: true, requestId: true, backend: true, visualConfirmation: true } as const;
const stepInput = performUiStepInputBase.omit(ownedFields).extend({ expect: debugUiStepExpectation }).superRefine(refineDebugUiStepInput);

export const debugPlanStep = z.discriminatedUnion("kind", [
  z.object({ ...conditionalStep, kind: z.literal("step"), input: stepInput }).strict(),
  z.object({ ...conditionalStep, kind: z.literal("scroll-until"), input: scrollUntilInputBase.omit(ownedFields) }).strict(),
  z.object({ ...conditionalStep, kind: z.literal("wait"), condition: debugUiStepExpectation,
    timeoutMs: z.number().int().min(1000).max(30_000).default(30_000) }).strict(),
]);

export const debugPlanDefinition = z.object({
  version: z.literal(1), title: z.string().trim().min(1).max(256), backend: debugObservationBackend,
  timeoutMs: z.number().int().min(1000).max(600_000).default(300_000),
  startConditions: z.array(debugUiStepExpectation).min(1).max(5),
  finalConditions: z.array(debugUiStepExpectation).min(1).max(5),
  steps: z.array(debugPlanStep).min(1).max(32),
}).strict().superRefine((definition, context) => {
  const conditions = [...definition.startConditions, ...definition.finalConditions,
    ...definition.steps.flatMap(step => [...step.when ? [step.when] : [],
      ...step.kind === "wait" ? [step.condition] : step.kind === "step" ? [step.input.expect] : []])];
  if (definition.backend !== "accessibility-helper" && conditions.some(item => item.visibility === "partial"))
    context.addIssue({ code: "custom", path: ["backend"], message: "partial 需要 accessibility-helper 观察。" });
  definition.steps.forEach((step, index) => {
    if (step.kind !== "scroll-until") return;
    const message = scrollInputMethodError({ ...step.input, backend: definition.backend });
    if (message) context.addIssue({ code: "custom", path: ["steps", index, "input"], message });
  });
  if (new Set(definition.steps.map(step => step.id)).size !== definition.steps.length)
    context.addIssue({ code: "custom", path: ["steps"], message: "计划步骤编号必须唯一。" });
  if (new TextEncoder().encode(JSON.stringify(definition)).length > 12_000)
    context.addIssue({ code: "custom", message: "计划定义超过12000字节，请缩小步骤与条件。" });
});

export type DebugPlanDefinition = z.infer<typeof debugPlanDefinition>;
export type DebugPlanStep = z.infer<typeof debugPlanStep>;
export type DebugPlanStepResult = {
  id: string;
  kind: "step" | "scroll-until" | "wait";
  status: "pending" | "running" | "passed" | "skipped" | "failed";
  requestId: string | null;
  productStepIds: number[];
  durationMs: number | null;
  message: string;
  errorCode?: string;
};
export type DebugPlanRun = {
  runId: string;
  sessionId: string;
  title: string;
  planHash: string;
  status: "running" | "passed" | "failed" | "cancelled" | "interrupted";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  currentStepId: string | null;
  completedSteps: number;
  totalSteps: number;
  steps: DebugPlanStepResult[];
  checkpointStepIds: number[];
  reportPath: string | null;
  ledgerPath: string;
  message: string;
  stopCode: string | null;
};
