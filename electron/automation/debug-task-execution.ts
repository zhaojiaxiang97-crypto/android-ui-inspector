import { randomUUID } from "node:crypto";
import type { DebugCommand } from "../../shared/debug-protocol";
import type { DebugSessionState, DebugStep } from "../../shared/types";
import { evaluateDebugTaskConditions } from "../../shared/debug-task-checker";
import type { DebugTaskAssessment, DebugTaskCheckResult, DebugTaskEvidence } from "../../shared/debug-task";
import type { McpSnapshot } from "./mcp-snapshot";
import type { Observation, StepContext } from "./debug-step-context";

/** Task definition, ordered checkpoints and checker evidence belong to this session. */
export class DebugTaskExecution {
  constructor(private readonly state: DebugSessionState) {}

  define(input: Extract<DebugCommand, { name: "define_debug_task" }>["input"], context: StepContext, inputRequested: boolean) {
    if (this.state.task) throw new Error("每个会话只能定义一个任务，已有任务定义不能修改。");
    if (inputRequested) throw new Error("任务必须在任何输入请求开始前定义；请重新授权新会话。");
    this.state.task = { id: randomUUID(), definedAt: context.step.time, definedStepId: context.step.id, definition: structuredClone(input.definition), checks: [] };
    return { task: structuredClone(this.state.task), taskId: this.state.task.id, verified: null, message: "任务条件已固定；定义任务不会采集或操作手机。" };
  }

  beginCheck(input: Extract<DebugCommand, { name: "check_debug_task" }>["input"], signal: AbortSignal, context: StepContext): Record<string, unknown> | null {
    const task = this.state.task;
    if (!task || task.id !== input.taskId) throw new Error("任务不存在或 taskId 不匹配，请使用本会话定义的任务编号。");
    const checkpointId = input.checkpointId ?? null;
    const index = checkpointId === null ? task.definition.checkpoints.length
      : task.definition.checkpoints.findIndex(item => item.id === checkpointId);
    if (index < 0) throw new Error("没有这个验收阶段。");
    const passed = (id: string) => task.checks.some(item => item.checkpointId === id && item.status === "passed");
    const current = task.definition.checkpoints.findIndex(item => !passed(item.id));
    if (checkpointId !== null && current >= 0 && index > current) throw new Error("阶段必须按定义顺序检查，请先完成当前阶段。");
    task.checks = task.checks.filter(check => check.checkpointId !== null
      && task.definition.checkpoints.findIndex(item => item.id === check.checkpointId) < index);
    context.task = { taskId: task.id, checkpointId, conditions: structuredClone(checkpointId === null
      ? task.definition.finalConditions : task.definition.checkpoints[index].conditions), first: null, second: null };
    signal.throwIfAborted();
    if (checkpointId === null && task.definition.checkpoints.some(item => !passed(item.id)))
      return this.result(context, "最终验收需要所有前置阶段都有有效的通过证据；本次没有采集页面。");
    return null;
  }

  observe(context: StepContext, entry: McpSnapshot, observation: Observation) {
    const task = context.task!;
    const evidence: DebugTaskEvidence = { snapshot: observation.snapshot, observation: { snapshotId: entry.id, capturedAt: entry.sharedAt,
      component: observation.target.component, windowId: observation.target.windowId, activityRecordId: observation.target.activityRecordId ?? null } };
    if (!task.first) {
      task.first = evidence; context.before = entry; context.beforeFreshness = "current"; context.step.beforeId = entry.id;
    } else { task.second = evidence; context.after = entry; }
  }

  finish(context: StepContext, reason?: string): DebugTaskCheckResult {
    const task = context.task!;
    const assessment: DebugTaskAssessment = evaluateDebugTaskConditions(task.conditions, task.first, task.second, this.state.packageName);
    if (reason) {
      assessment.status = "insufficient_evidence"; assessment.reason = reason.slice(0, 16000);
      assessment.conditions = assessment.conditions.map(item => ({ ...item, status: "insufficient_evidence", reason: assessment.reason }));
    }
    const check: DebugTaskCheckResult = { taskId: task.taskId, checkpointId: task.checkpointId, stepId: context.step.id,
      checkedAt: new Date().toISOString(), ...assessment,
      observations: { first: task.first?.observation ?? null, second: task.second?.observation ?? null } };
    context.step.taskCheck = check; context.step.verified = check.status === "passed";
    const record = this.state.task!;
    record.checks = [...record.checks.filter(item => item.checkpointId !== check.checkpointId), check].sort((a, b) => {
      const order = (id: string | null) => id === null ? record.definition.checkpoints.length
        : record.definition.checkpoints.findIndex(item => item.id === id);
      return order(a.checkpointId) - order(b.checkpointId);
    });
    return check;
  }

  result(context: StepContext, reason?: string) {
    const taskResult = this.finish(context, reason);
    return { taskId: context.task!.taskId, taskResult, verified: taskResult.status === "passed",
      snapshotId: context.after?.id ?? null, message: taskResult.reason };
  }
}

/** A missing record invalidates proof, while preserving whether the action itself completed. */
export function invalidateDebugTaskCheck(state: DebugSessionState, step: DebugStep, reason: string) {
  if (!step.taskCheck) return;
  const check = step.taskCheck;
  check.status = "insufficient_evidence"; check.reason = reason.slice(0, 16000);
  check.conditions = check.conditions.map(item => ({ ...item, status: "insufficient_evidence", reason: check.reason }));
  step.verified = false;
  const saved = state.task?.checks.find(item => item.stepId === step.id);
  if (saved) Object.assign(saved, structuredClone(check));
}
