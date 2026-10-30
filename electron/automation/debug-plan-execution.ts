import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { trackSignalDeadline } from "../device/signal-deadline";
import { debugPlanDefinition, type DebugPlanDefinition, type DebugPlanRun, type DebugPlanStepResult } from "../../shared/debug-plan";
import type { DebugCommand } from "../../shared/debug-protocol";
import type { DebugTaskCondition, DebugTaskEvidence } from "../../shared/debug-task";
import { evaluateDebugTaskConditions } from "../../shared/debug-task-checker";
import { assertSameHelperServiceEvidence } from "../../shared/helper-observation";
import type { DebugSessionState, UiSnapshot } from "../../shared/types";
import { writePrivateJson } from "./mcp-snapshot";
import { debugStepMessage } from "./debug-step-context";

export type PlanExecutionCommand = Extract<DebugCommand, { name: "capture_ui" | "perform_ui_step" | "scroll_until" | "wait_for_ui" }>;
type Entry = { definition: DebugPlanDefinition; run: DebugPlanRun; journal: string; controller: AbortController;
  cancelCode: string | null; source: UiSnapshot["helperObservation"] | null; done: Promise<void> };
class PlanStop extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const journalLimit = 128 * 1024;

/** Owns the whole plan, while every device operation still uses the session's existing execution chain. */
export class DebugPlanExecution {
  private readonly entries = new Map<string, Entry>();
  private active: Entry | null = null;

  constructor(private readonly options: {
    state: DebugSessionState; directory: string;
    execute: (command: PlanExecutionCommand, signal: AbortSignal) => Promise<Record<string, unknown>>;
    evidence: () => DebugTaskEvidence | null;
    changed: (run: DebugPlanRun) => void;
  }) {}

  get running() { return this.active !== null; }
  async settled() { await this.active?.done; }

  private view(entry: Entry) { return structuredClone(entry.run); }

  private assertJournal(entry: Entry) {
    if (!entry.journal) return;
    const fd = openSync(entry.run.ledgerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > journalLimit)
        throw new Error("计划记录缺失或已变化，禁止继续输入。");
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, length);
        if (!count) break;
        length += count;
      }
      if (length !== stat.size || bytes.subarray(0, length).toString("utf8") !== entry.journal)
        throw new Error("计划记录缺失或已变化，禁止继续输入。");
    } finally { closeSync(fd); }
  }

  private publish(entry: Entry) {
    this.assertJournal(entry);
    entry.run.reportPath = this.options.state.reportPath ?? null;
    const record = { definition: entry.definition, run: entry.run };
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json) > journalLimit) throw new Error("计划记录超过容量上限。");
    writePrivateJson(entry.run.ledgerPath, record);
    entry.journal = json;
    this.options.changed(this.view(entry));
  }

  start(runId: string, raw: DebugPlanDefinition, callerSignal?: AbortSignal): Record<string, unknown> {
    callerSignal?.throwIfAborted();
    const definition = debugPlanDefinition.parse(raw);
    const planHash = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
    const previous = this.entries.get(runId);
    if (previous) {
      if (previous.run.planHash !== planHash) throw new Error("同一计划运行编号的参数不同，未重新执行。");
      return { run: this.view(previous), replayed: true };
    }
    const state = this.options.state;
    if (!state.active) throw new Error("会话已结束，请在桌面重新授权。");
    if (this.running || state.busy) throw new Error("另一个调试操作或计划正在执行。");
    if (this.entries.size >= 10) throw new Error("本会话最多执行10份计划，请结束后创建新会话。");
    if (Date.parse(state.expiresAt) - Date.now() < definition.timeoutMs + 1500)
      throw new Error("授权剩余时间不足以覆盖计划时限和收尾，请缩短计划或重新授权。");
    const ledgerPath = join(this.options.directory, `plan-${runId}.json`);
    if (existsSync(ledgerPath)) throw new Error("该运行编号已有本地记录，禁止重新执行。");
    const entry: Entry = { definition, controller: new AbortController(), journal: "", cancelCode: null, source: null,
      done: Promise.resolve(), run: { runId, sessionId: state.id, title: definition.title, planHash,
        status: "running", startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
        currentStepId: null, completedSteps: 0, totalSteps: definition.steps.length, checkpointStepIds: [],
        reportPath: state.reportPath ?? null, ledgerPath, message: "计划已接收，准备验证起点。", stopCode: null,
        steps: definition.steps.map(step => ({ id: step.id, kind: step.kind, status: "pending",
          requestId: step.kind === "wait" ? null : randomUUID(), productStepIds: [], durationMs: null, message: "尚未执行。" })) } };
    this.active = entry;
    this.entries.set(runId, entry);
    try { this.publish(entry); }
    catch (error) { this.active = null; this.entries.delete(runId); throw error; }
    // Acceptance survives a lost start reply; only cancel/stop/deadline ends the owned background work.
    entry.done = Promise.resolve().then(() => this.execute(entry));
    return { run: this.view(entry) };
  }

  get(runId: string): Record<string, unknown> {
    const entry = this.entries.get(runId);
    return entry ? { run: this.view(entry) } : { runId, found: false };
  }

  cancel(runId: string, reason = "已请求取消计划", code = "cancelled"): Record<string, unknown> {
    const entry = this.entries.get(runId);
    if (!entry) return { runId, found: false };
    if (this.active === entry && !entry.controller.signal.aborted) {
      entry.cancelCode = code;
      entry.controller.abort(new PlanStop(code, reason));
      entry.run.message = `${reason}；等待当前操作收尾，已发出的输入无法撤回。`;
      try { this.publish(entry); }
      catch { this.options.changed(this.view(entry)); }
    }
    return { run: this.view(entry) };
  }

  stop(reason: string) { if (this.active) this.cancel(this.active.run.runId, reason, "session_ended"); }

  assertInputAllowed() { if (this.active) this.check(this.active); }

  assertObservationSource(snapshot: UiSnapshot) {
    const entry = this.active;
    if (!entry) return;
    if (snapshot.inspectionSource !== entry.definition.backend)
      throw new PlanStop("observation_source_changed", "计划的采集来源已变化，未继续操作。");
    if (entry.definition.backend === "accessibility-helper") {
      if (!snapshot.helperObservation) throw new PlanStop("observation_source_missing", "计划缺少Helper观察来源。");
      if (entry.source) assertSameHelperServiceEvidence(entry.source, snapshot.helperObservation);
      else entry.source = structuredClone(snapshot.helperObservation);
    }
  }

  private check(entry: Entry) {
    entry.controller.signal.throwIfAborted();
    if (!this.options.state.active || Date.now() >= Date.parse(this.options.state.expiresAt))
      throw new PlanStop("session_ended", "授权已结束，未继续计划。");
    try { this.assertJournal(entry); }
    catch { throw new PlanStop("plan_recording_failed", "计划记录缺失、变化或不可读，禁止继续输入。"); }
  }

  private async operation(entry: Entry, command: PlanExecutionCommand, ids: number[]) {
    this.check(entry);
    const result = await this.options.execute(command, entry.controller.signal);
    if (Number.isSafeInteger(result.stepId) && Number(result.stepId) > 0) ids.push(Number(result.stepId));
    this.publish(entry);
    entry.controller.signal.throwIfAborted();
    if (!Number.isSafeInteger(result.stepId) || Number(result.stepId) <= 0)
      throw new PlanStop("step_result_missing", "操作没有可核对的产品步骤编号，已停止。");
    if (result.dispatchState === "unknown") throw new PlanStop("dispatch_unknown", "输入结果未知，已停止；请查询原请求，不要重发。");
    if (result.recordingWarning || Array.isArray(result.recordingErrors) && result.recordingErrors.length)
      throw new PlanStop("evidence_recording_failed", "步骤证据保存失败，未继续计划。");
    if (result.isError) {
      const error = result.error as { code?: unknown } | undefined;
      throw new PlanStop(typeof error?.code === "string" ? error.code : "step_failed", String(result.message ?? "步骤执行失败。"));
    }
    if ((command.name === "perform_ui_step" || command.name === "scroll_until") && result.requestState !== "completed")
      throw new PlanStop("request_incomplete", "原请求尚未完整保存，已停止；不要重发输入。");
    return result;
  }

  private async conditions(entry: Entry, conditions: DebugPlanDefinition["startConditions"], ids: number[]) {
    const capture = () => this.operation(entry, { name: "capture_ui", input: {
      sessionId: this.options.state.id, mode: "fast", backend: entry.definition.backend } }, ids);
    await capture();
    const first = this.options.evidence();
    await delay(350, undefined, { signal: entry.controller.signal });
    await capture();
    const second = this.options.evidence();
    this.check(entry);
    const declared: DebugTaskCondition[] = conditions.map((item, index) => ({ id: `condition_${index}`, ...item }));
    return evaluateDebugTaskConditions(declared, first, second, this.options.state.packageName);
  }

  private async execute(entry: Entry) {
    const started = performance.now();
    trackSignalDeadline(entry.controller.signal, started + entry.definition.timeoutMs);
    const timer = setTimeout(() => this.cancel(entry.run.runId, "计划已达到总时限", "duration_limit"), entry.definition.timeoutMs);
    timer.unref();
    let current: DebugPlanStepResult | undefined;
    try {
      const start = await this.conditions(entry, entry.definition.startConditions, entry.run.checkpointStepIds);
      if (start.status !== "passed") throw new PlanStop("start_condition_failed", start.reason);
      for (let index = 0; index < entry.definition.steps.length; index++) {
        this.check(entry);
        const definition = entry.definition.steps[index];
        current = entry.run.steps[index];
        current.status = "running";
        entry.run.currentStepId = definition.id;
        entry.run.message = current.message = "正在执行计划步骤。";
        this.publish(entry);
        const stepStarted = performance.now();
        try {
          if (definition.when) {
            const condition = await this.conditions(entry, [definition.when], current.productStepIds);
            if (condition.status === "insufficient_evidence") throw new PlanStop("branch_evidence_insufficient", condition.reason);
            if (condition.status === "failed") {
              current.status = "skipped"; current.message = "两次新观察均不满足条件，已跳过此步。";
              entry.run.completedSteps++; continue;
            }
          }
          const sessionId = this.options.state.id;
          const command: PlanExecutionCommand = definition.kind === "step"
            ? { name: "perform_ui_step", input: { ...definition.input, sessionId, requestId: current.requestId!, backend: entry.definition.backend } }
            : definition.kind === "scroll-until"
              ? { name: "scroll_until", input: { ...definition.input, sessionId, requestId: current.requestId!, backend: entry.definition.backend } }
              : { name: "wait_for_ui", input: { ...definition.condition, sessionId, timeoutMs: definition.timeoutMs } };
          const result = await this.operation(entry, command, current.productStepIds);
          if (result.verified !== true) throw new PlanStop("step_not_verified", String(result.message ?? "步骤未通过验证。"));
          current.status = "passed"; current.message = String(result.message ?? "步骤验证通过。").slice(0, 512);
          entry.run.completedSteps++;
        } finally {
          current.durationMs = Math.max(0, performance.now() - stepStarted);
          this.publish(entry);
        }
      }
      current = undefined;
      entry.run.currentStepId = null;
      entry.run.message = "正在验证最终条件。";
      this.publish(entry);
      const final = await this.conditions(entry, entry.definition.finalConditions, entry.run.checkpointStepIds);
      if (final.status !== "passed") throw new PlanStop("final_condition_failed", final.reason);
      this.check(entry);
      entry.run.status = "passed";
      entry.run.message = "所有计划步骤和最终声明条件均已验证。";
    } catch (error) {
      const code = entry.cancelCode ?? (error instanceof PlanStop ? error.code : "plan_failed");
      entry.run.status = entry.controller.signal.aborted ? "cancelled" : "failed";
      entry.run.stopCode = code;
      entry.run.message = debugStepMessage(error).slice(0, 512);
      if (current && current.status === "running") {
        current.status = "failed"; current.errorCode = code; current.message = entry.run.message;
      }
    } finally {
      clearTimeout(timer);
      entry.run.finishedAt = new Date().toISOString();
      entry.run.durationMs = Math.max(0, performance.now() - started);
      this.active = null;
      try { this.publish(entry); }
      catch {
        entry.run.status = "interrupted"; entry.run.stopCode = "plan_recording_failed";
        entry.run.message = "计划记录未完整保存；已停止，不会自动恢复或重发输入。";
        this.options.changed(this.view(entry));
      }
    }
  }
}
