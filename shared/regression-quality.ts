import { z } from "zod";

// Versioned, privacy-minimal adapter for scripts/automation-ui-regression.ts summary.json.
const run = z.object({
  version: z.literal(1), runId: z.string().min(1), planSha256: z.string().regex(/^[0-9a-f]{64}$/),
  backend: z.enum(["uiautomator", "accessibility-helper"]),
  requestedRounds: z.number().int().positive().max(10),
  completedRounds: z.number().int().nonnegative().max(10),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  wallMs: z.number().nonnegative().finite(),
  actionAttempts: z.number().int().nonnegative(),
  firstAttemptSuccessRate: z.number().min(0).max(1).nullable(),
  confirmedInputs: z.number().int().nonnegative(), uncertainInputs: z.number().int().nonnegative(),
  notSentInputs: z.number().int().nonnegative(),
  inputCountKnown: z.boolean(),
  responseRecoveries: z.number().int().nonnegative(),
  helperAutoRecoveryReads: z.number().int().nonnegative(),
  otherAutoRecoveryReads: z.number().int().nonnegative(),
  independentResumeAttempts: z.number().int().nonnegative(),
  functionalPassed: z.boolean(), completeSuccess: z.boolean(), stopCode: z.string().nullable(),
  evidence: z.object({ complete: z.boolean().nullable() }).passthrough(),
}).passthrough().superRefine((value, ctx) => {
  if (value.completedRounds > value.requestedRounds
    || Date.parse(value.finishedAt) < Date.parse(value.startedAt)
    || value.actionAttempts === 0 && value.firstAttemptSuccessRate !== null
    || value.actionAttempts > 0 && value.firstAttemptSuccessRate === null
    || value.completeSuccess && (!value.functionalPassed || value.evidence.complete !== true
      || value.uncertainInputs !== 0 || !value.inputCountKnown
      || value.completedRounds !== value.requestedRounds || value.stopCode !== null)) {
    ctx.addIssue({ code: "custom", message: "回归汇总内部状态不一致。" });
  }
});
const envelope = z.object({
  version: z.literal(1), candidateId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/),
  pendingRuns: z.number().int().min(0).max(100),
  runs: z.array(run).max(100),
}).strict();
export type QualityInput = z.infer<typeof envelope>;

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

export function summarizeRegressionQuality(input: unknown) {
  const { candidateId, pendingRuns, runs } = envelope.parse(input);
  const ids = new Set(runs.map(item => item.runId)), plans = new Set(runs.map(item => item.planSha256)),
    backends = new Set(runs.map(item => item.backend));
  if (ids.size !== runs.length || plans.size > 1 || backends.size > 1)
    throw new Error("不能合并重复运行、不同任务计划或不同采集后端的可靠性样本。");
  const successes = runs.filter(item => item.completeSuccess);
  const firstSuccess = [...successes].sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt))[0];
  const timeoutRuns = runs.filter(item => /timeout|deadline|duration_limit/i.test(item.stopCode ?? "")).length;
  const unknownDispatchRuns = runs.filter(item => item.uncertainInputs > 0 || item.stopCode === "dispatch_unknown").length;
  const unknownMissingCount = runs.some(item => item.stopCode === "dispatch_unknown" && item.uncertainInputs === 0);
  const sum = (field: "actionAttempts" | "confirmedInputs" | "uncertainInputs" | "notSentInputs" | "responseRecoveries"
    | "helperAutoRecoveryReads" | "otherAutoRecoveryReads" | "independentResumeAttempts") =>
    runs.reduce((count, item) => count + item[field], 0);
  const knownInputCounts = runs.every(item => item.inputCountKnown);
  const countedInput = sum("confirmedInputs") + sum("uncertainInputs");
  const firstActionAttempts = sum("actionAttempts");
  return {
    version: 1 as const, candidateId, planSha256: runs[0]?.planSha256 ?? null, backend: runs[0]?.backend ?? null,
    plannedRuns: runs.length + pendingRuns, attemptedRuns: runs.length, pendingRuns,
    completeSuccessRuns: successes.length, functionalSuccessRuns: runs.filter(item => item.functionalPassed).length,
    taskSuccessRate: runs.length ? successes.length / runs.length : null,
    firstSuccessfulRunWallMs: firstSuccess?.wallMs ?? null,
    successfulRunMedianWallMs: median(successes.map(item => item.wallMs)),
    timeoutRuns, timeoutRate: runs.length ? timeoutRuns / runs.length : null,
    unknownDispatchRuns,
    unknownDispatchCountLowerBound: runs.reduce((n, item) => n + Math.max(item.uncertainInputs,
      item.stopCode === "dispatch_unknown" ? 1 : 0), 0),
    unknownDispatchRate: knownInputCounts && !unknownMissingCount && countedInput ? sum("uncertainInputs") / countedInput : null,
    inputCountKnown: runs.length ? knownInputCounts : null,
    confirmedInputs: sum("confirmedInputs"), notSentInputs: sum("notSentInputs"),
    firstAttemptActionSuccessRate: firstActionAttempts
      ? runs.reduce((acc, item) => acc + (item.firstAttemptSuccessRate ?? 0) * item.actionAttempts, 0) / firstActionAttempts : null,
    responseRecoveries: sum("responseRecoveries"),
    helperAutoRecoveryReads: sum("helperAutoRecoveryReads"),
    otherAutoRecoveryReads: sum("otherAutoRecoveryReads"),
    independentResumeAttempts: sum("independentResumeAttempts"),
    duplicateBusinessActions: null,
    recoveryDurationMs: null,
    limitations: [
      "pendingRuns 表示尚未执行，绝不作为失败计入 taskSuccessRate。",
      "现有 summary 不提供可验证的业务动作去重次数与恢复专用墙钟；两个字段保持 null。",
      "当前成功定义是任务完成、证据完整、计时完整；已发送回执不等于业务成功。",
      "只能比较同一候选、同一计划指纹和相同后端；机型、App 数据集及安装 SHA 仍须在外部验收清单核对。",
    ],
  };
}
