import { debugTaskDefinition, type DebugTaskAssessment, type DebugTaskCondition, type DebugTaskDefinition, type DebugTaskStatus } from "./debug-task";
import type { LoadedTestReport } from "./test-report";

export type DebugTaskRunStatus = DebugTaskStatus | "unchecked";
export type DebugTaskRunTime = { milliseconds: number | null; startedAt: string | null; finishedAt: string | null; reason: string };
export type DebugTaskRunOutcome = {
  status: DebugTaskRunStatus; reason: string; stepId: number | null; checkedAt: string | null;
  conditions: Array<{ id: string; status: DebugTaskRunStatus; reason: string }>;
  time: DebugTaskRunTime;
};
export type DebugTaskRun = {
  source: { reportSha256: string; sessionId: string; taskId: string | null; packageName: string; serial: string; startedAt: string; active: boolean };
  definition: DebugTaskDefinition | null;
  phases: Array<{ id: string | null; title: string; conditions: DebugTaskCondition[]; outcome: DebugTaskRunOutcome }>;
  time: DebugTaskRunTime;
};
export type DebugTaskRunsComparison = {
  status: "same_task" | "different_app" | "different_definition" | "missing_task";
  reasons: string[]; primary: DebugTaskRun; secondary: DebugTaskRun;
  rows: Array<{ id: string | null; title: string; conditions: DebugTaskCondition[]; primary: DebugTaskRunOutcome; secondary: DebugTaskRunOutcome; differenceMs: number | null }>;
  differenceMs: number | null;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const unknownTime = (reason: string): DebugTaskRunTime => ({ milliseconds: null, startedAt: null, finishedAt: null, reason });
function timeBetween(startedAt: string | undefined, finishedAt: string | undefined, reason: string): DebugTaskRunTime {
  const start = Date.parse(startedAt ?? ""), end = Date.parse(finishedAt ?? "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? { milliseconds: end - start, startedAt: startedAt!, finishedAt: finishedAt!, reason }
    : unknownTime("缺少可确认的起止时间，耗时未知。");
}

function run(report: LoadedTestReport): DebugTaskRun {
  const data = report.debug, task = data?.task, parsed = debugTaskDefinition.safeParse(task?.definition);
  const definition = parsed.success ? parsed.data : null;
  const source = { reportSha256: report.index.reportSha256, sessionId: data?.session.id ?? report.index.run.id, taskId: task?.id ?? null,
    packageName: data?.session.packageName ?? "未知", serial: data?.session.serial ?? "未知", startedAt: data?.session.startedAt ?? report.index.run.startedAt,
    active: data?.session.active ?? false };
  if (!data || !task || !definition) return { source, definition: null, phases: [], time: unknownTime("没有完整固定任务定义，耗时未知。") };
  const latest = (id: string | null) => task.checks.filter(check => check.taskId === task.id && check.checkpointId === id)
    .sort((a, b) => b.stepId - a.stepId)[0] ?? null;
  const outcome = (id: string | null, conditions: DebugTaskCondition[]): DebugTaskRunOutcome => {
    const check = latest(id);
    if (!check) return { status: "unchecked", reason: id === null ? "尚未最终验收。" : "此阶段尚未验收。", stepId: null, checkedAt: null,
      conditions: conditions.map(condition => ({ id: condition.id, status: "unchecked", reason: "尚未验收。" })), time: unknownTime("没有检查记录，耗时未知。") };
    const reviewed = data.taskAssessment?.checks.find(value => canonical(value.recorded) === canonical(check));
    let assessment: DebugTaskAssessment | null = reviewed ? (id === null ? data.taskAssessment?.final ?? null : reviewed.effective) : null;
    const fullProof = [check.observations.first, check.observations.second].every(observation => {
      const saved = observation && data.snapshots.filter(snapshot => snapshot.evidence.snapshotId === observation.snapshotId);
      return saved?.length === 1 && saved[0].snapshot && saved[0].evidence.tree && !saved[0].treeError;
    });
    const reason = !fullProof ? "缺少此检查的完整树证据，不能据原始记录确认通过。" : "缺少加载器复核结果，不能据原始记录确认通过。";
    if (!assessment || !fullProof && assessment.status !== "insufficient_evidence"
      || canonical(assessment.conditions.map(condition => condition.conditionId)) !== canonical(conditions.map(condition => condition.id)))
      assessment = { status: "insufficient_evidence", reason, conditions: check.conditions.map(condition => ({ ...condition, status: "insufficient_evidence", reason })) };
    const entry = data.steps.find(value => value.step.id === check.stepId && value.step.action === "check_debug_task"
      && value.step.taskCheck && canonical(value.step.taskCheck) === canonical(check));
    const time = entry && entry.step.status !== "running" && Date.parse(check.checkedAt) <= Date.parse(entry.finishedAt)
      ? timeBetween(entry.step.time, check.checkedAt, "验收步骤开始→检查结束；含采集与等待，不含之后写报告。")
      : unknownTime("原检查步骤未保留或未结束，检查耗时未知。");
    return { status: assessment.status, reason: assessment.reason, stepId: check.stepId, checkedAt: check.checkedAt, time,
      conditions: conditions.map(condition => { const result = assessment!.conditions.find(value => value.conditionId === condition.id);
        return { id: condition.id, status: result?.status ?? "insufficient_evidence", reason: result?.reason ?? "没有有效条件结果。" }; }) };
  };
  const phases = [...definition.checkpoints.map(checkpoint => ({ id: checkpoint.id as string | null, title: checkpoint.title,
    conditions: checkpoint.conditions, outcome: outcome(checkpoint.id, checkpoint.conditions) })),
  { id: null, title: "最终验收", conditions: definition.finalConditions, outcome: outcome(null, definition.finalConditions) }];
  const final = phases.at(-1)!;
  if (final.outcome.status === "passed" && phases.slice(0, -1).some(phase => phase.outcome.status !== "passed")) {
    final.outcome.status = "insufficient_evidence"; final.outcome.reason = "前置阶段未保留全部有效通过证据，最终验收证据不足。";
    final.outcome.conditions = final.outcome.conditions.map(condition => ({ ...condition, status: "insufficient_evidence", reason: final.outcome.reason }));
  }
  const finalCheck = latest(null);
  const finalRunning = finalCheck && data.steps.some(entry => entry.step.id === finalCheck.stepId && entry.step.status === "running");
  return { source, definition, phases, time: finalCheck && !finalRunning
    ? timeBetween(task.definedAt, finalCheck.checkedAt, "固定任务定义→最近最终检查；包含操作、采集和等待，不代表纯App执行时间。")
    : unknownTime(finalRunning ? "最近检查步骤仍在进行，结束范围未知。" : "尚未最终验收，定义→最近最终检查范围未知。") };
}

function definitionDifferences(a: DebugTaskDefinition, b: DebugTaskDefinition) {
  const reasons: string[] = [];
  if (a.goal !== b.goal) reasons.push("任务目标不同。");
  if (canonical(a.checkpoints.map(stage => stage.id)) !== canonical(b.checkpoints.map(stage => stage.id))) reasons.push("阶段数量、编号或顺序不同。");
  for (let i = 0; i < Math.min(a.checkpoints.length, b.checkpoints.length); i++)
    if (canonical(a.checkpoints[i]) !== canonical(b.checkpoints[i])) reasons.push(`第 ${i + 1} 阶段的名称、编号或固定条件不同。`);
  if (canonical(a.finalConditions) !== canonical(b.finalConditions)) reasons.push("最终条件的编号、顺序、选择器或状态不同。");
  return reasons;
}

/** Align fixed definitions only. Node IDs, screenshots and task UUIDs never align different runs. */
export function compareDebugTaskRuns(primaryReport: LoadedTestReport, secondaryReport: LoadedTestReport): DebugTaskRunsComparison {
  const primary = run(primaryReport), secondary = run(secondaryReport);
  const status = !primary.definition || !secondary.definition ? "missing_task"
    : primary.source.packageName !== secondary.source.packageName ? "different_app"
    : canonical(primary.definition) !== canonical(secondary.definition) ? "different_definition" : "same_task";
  const reasons = status === "missing_task" ? ["有一份报告没有完整固定任务定义，不能直接比较任务结果。"]
    : status === "different_app" ? ["目标 App 不同，不能直接比较任务结果。"]
    : status === "different_definition" ? definitionDifferences(primary.definition!, secondary.definition!) : ["目标 App 与完整固定任务定义一致，可比较历史验收结果。"];
  const difference = (a: DebugTaskRunTime, b: DebugTaskRunTime) => status === "same_task" && a.milliseconds !== null && b.milliseconds !== null
    ? b.milliseconds - a.milliseconds : null;
  return { status, reasons, primary, secondary, differenceMs: difference(primary.time, secondary.time),
    rows: status === "same_task" ? primary.phases.map((phase, index) => ({ id: phase.id, title: phase.title, conditions: phase.conditions,
      primary: phase.outcome, secondary: secondary.phases[index].outcome, differenceMs: difference(phase.outcome.time, secondary.phases[index].outcome.time) })) : [] };
}

export const debugTaskRunStatusLabel = (status: DebugTaskRunStatus) => ({ passed: "通过", failed: "失败", insufficient_evidence: "证据不足", unchecked: "未验收" })[status];
