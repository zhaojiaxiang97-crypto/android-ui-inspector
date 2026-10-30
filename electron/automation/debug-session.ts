import { randomUUID } from "node:crypto";
import { debugCommand } from "../../shared/debug-protocol";
import type { DebugSessionEvent, DebugSessionState, DebugStep, DebugStepError } from "../../shared/types";
import type { inputDebugApp, DebugObserver } from "./device-actions";
import { DebugInputError } from "../device/debug-input";
import { DebugStepLogCollector } from "./debug-logs";
import type { DebugProgressPhase } from "../../shared/debug-progress";
import { debugStepFailure, debugStepMessage, type Observation, type StepContext } from "./debug-step-context";
import { DebugStepExecutor } from "./debug-step-executor";
import { DebugVisualConfirmationRequired } from "./debug-visual-confirmation";
import { DebugSessionRecording } from "./debug-session-recording";

export class DebugSession {
  readonly state: DebugSessionState;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private busy = false;
  private sequence = 0;
  private done: Promise<unknown> = Promise.resolve();
  private readonly executor: DebugStepExecutor;
  private readonly recording: DebugSessionRecording;
  private pending: StepContext | null = null;
  private readonly logs: DebugStepLogCollector;

  constructor(private readonly options: {
    serial: string; packageName: string; snapshotPath: string; directory: string;
    onEvent: (event: DebugSessionEvent) => void;
    observe: DebugObserver; input?: typeof inputDebugApp;
    androidLogs?: boolean;
    logExecute?: ConstructorParameters<typeof DebugStepLogCollector>[0]["execute"];
  }) {
    const startedAt = new Date().toISOString();
    this.state = { id: randomUUID(), serial: options.serial, packageName: options.packageName,
      active: true, busy: false, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), steps: [], evidencePath: null, reportPath: null, stopReason: null, task: null };
    Object.assign(this.state, { startedAt, revision: 0, androidLogsEnabled: options.androidLogs === true,
      progress: { sessionId: this.state.id, taskId: null, stepId: null, action: null, phase: "idle", startedAt,
        updatedAt: startedAt, stepStartedAt: null, stepFinishedAt: null, finishedAt: null, reason: "等待调试请求；授权不会自动执行任务。" } });
    this.logs = new DebugStepLogCollector({ serial: options.serial, packageName: options.packageName, sessionId: this.state.id,
      androidLogs: options.androidLogs === true, execute: options.logExecute });
    this.executor = new DebugStepExecutor(this.state, { snapshotPath: options.snapshotPath, observe: options.observe, input: options.input,
      events: { phase: (context, phase) => this.phase(context, phase), emit: (snapshot, selectedNodeId) => this.emit(snapshot, selectedNodeId) } });
    this.recording = new DebugSessionRecording({ directory: options.directory, state: this.state });
    this.timer = setTimeout(() => this.stop("授权已到期"), 30 * 60_000);
    this.timer.unref();
  }

  private emit(snapshot?: Observation["snapshot"], selectedNodeId?: string | null) {
    this.state.revision = (this.state.revision ?? 0) + 1;
    this.options.onEvent({ state: structuredClone(this.state), snapshot, selectedNodeId });
  }

  private progress(phase: DebugProgressPhase, context?: StepContext, reason: string | null = null) {
    const previous = this.state.progress!;
    const now = new Date().toISOString();
    this.state.progress = { ...previous, taskId: this.state.task?.id ?? null,
      ...(context ? { stepId: context.step.id, action: context.step.action, stepStartedAt: context.step.time } : {}),
      phase, updatedAt: now, reason,
      stepFinishedAt: (context || previous.stepId !== null) && ["completed", "failed", "cancelled", "expired"].includes(phase) ? previous.stepFinishedAt ?? now : null,
      finishedAt: !this.state.active ? previous.finishedAt ?? now : null };
  }

  private phase(context: StepContext, phase: DebugStepError["phase"]) {
    context.phase = phase;
    if (!this.state.active) return;
    this.progress(phase === "capture" ? "capture" : phase === "verify" ? "wait" : phase === "recording" ? "recording" : "execute",
      context, phase === "verify" ? "等待两次新观察确认页面条件。" : null);
    this.emit();
  }

  stop(reason = "已停止自动调试") {
    if (!this.state.active) return;
    this.state.active = false;
    this.state.busy = false;
    this.state.stopReason = reason;
    clearTimeout(this.timer);
    this.controller.abort(new Error(reason));
    this.logs.stop();
    this.progress(reason === "授权已到期" ? "expired" : "cancelled", this.pending ?? undefined, reason);
    try { this.executor.stop(); }
    catch (error) { this.recording.recordingFailure(this.state.steps.at(-1), "share_cleanup_failed", error); }
    if (this.pending) {
      // Stopping optional log/attachment work must preserve a finished action or Checker result.
      if (this.pending.step.status === "running") {
        this.pending.step.status = "failed";
        this.pending.step.verified = false;
        this.pending.step.message = reason;
        this.pending.step.error = debugStepFailure(new Error(reason), this.pending, false, true);
        if (this.pending.task) this.executor.finishTaskCheck(this.pending, `任务验收已停止：${reason}`);
      }
      this.pending.finishedAt = new Date().toISOString();
      this.pending.logs = this.logs.cancelled(this.pending.step, this.pending.finishedAt);
      this.recording.record(this.pending, this.sequence);
    } else this.recording.saveSession(this.sequence);
    try { this.recording.saveSteps(); }
    catch (error) { this.recording.recordingFailure(this.state.steps.at(-1), "steps_write_failed", error); }
    this.emit();
  }

  // Authorization can stop before the owned request has finished releasing its work.
  get hasPendingWork() { return this.busy; }

  settled() { return this.done.catch(() => undefined); }

  async request(raw: unknown, callerSignal?: AbortSignal): Promise<Record<string, unknown>> {
    const command = debugCommand.parse(raw);
    if (command.name === "get_debug_session") return { ...structuredClone(this.state), steps: structuredClone(this.state.steps.slice(-20)), snapshotId: this.executor.snapshotId };
    if (command.input.sessionId !== this.state.id || !this.state.active) throw new Error("会话已结束或不匹配，请在桌面重新授权。");
    if (command.name === "stop_debug_session") { this.stop("CLI / MCP 请求停止自动调试"); return { stopped: true }; }
    // ponytail: one desktop/device session at a time; reject concurrent actions instead of queuing stale clicks.
    if (this.busy) throw new Error("另一个调试操作正在执行，请等待完成后重试。");
    this.busy = this.state.busy = true;
    const limit = command.name === "check_debug_task" ? 30_000 : command.name === "wait_for_ui" ? command.input.timeoutMs : command.name === "capture_ui" && command.input.mode === "deep" ? 120_000 : 45_000;
    const timeout = AbortSignal.timeout(limit);
    const cancellationSignal = AbortSignal.any([this.controller.signal, ...(callerSignal ? [callerSignal] : [])]);
    const signal = AbortSignal.any([cancellationSignal, timeout]);
    const step: DebugStep = { id: ++this.sequence, time: new Date().toISOString(), action: command.name, input: command.input,
      status: "running", verified: command.name === "capture_ui" || command.name === "define_debug_task" ? null : false,
      message: command.name === "wait_for_ui" ? `等待 ${JSON.stringify(command.input.selector)} ${command.input.state}` : "执行中",
      ...(command.name === "define_debug_task" || command.name === "check_debug_task" ? {} : { beforeId: this.executor.snapshotId ?? undefined }) };
    if (command.name === "tap_node" || command.name === "scroll_node" || command.name === "press_back") step.dispatchState = "not_sent";
    this.state.steps.push(step);
    this.state.steps = this.state.steps.slice(-100);
    const context = this.executor.beginStep(command, step);
    this.pending = context;
    this.progress(context.phase === "capture" ? "capture" : context.phase === "verify" ? "wait" : "execute", context);
    this.emit();
    const run = async () => {
      let outcome: Record<string, unknown> = {};
      try {
        this.executor.prepareCaptureSource(command, context);
        if (this.options.androidLogs === true) context.logWindow = await this.logs.begin(step, signal, cancellationSignal);
        const result = await this.executor.execute(command, signal, context);
        signal.throwIfAborted();
        step.status = "done";
        const description = String(result.message ?? "完成");
        step.message = description.length > 16000 ? `${description.slice(0, 15999)}…` : description;
        step.verified = typeof result.verified === "boolean" ? result.verified : null;
        step.afterId = context.after?.id;
        outcome = { ...result, stepId: step.id };
      } catch (error) {
        if (error instanceof DebugInputError) {
          step.inputEvidence = error.evidence;
          step.dispatchState = error.evidence.spawned ? "unknown" : "not_sent";
        }
        step.status = "failed";
        step.verified = false;
        step.error = debugStepFailure(error, context, timeout.aborted, signal.aborted);
        step.message = timeout.aborted ? "等待超时，未验证成功；操作可能已经发出，请重新观察，不要盲目重试。" : debugStepMessage(error);
        step.afterId = context.after?.id;
        if (context.task) this.executor.finishTaskCheck(context, `任务验收未完成：${step.error.message}`);
        this.recording.saveFailure(context, command);
        outcome = { isError: true, verified: false, error: step.error, stepId: step.id, message: step.message, snapshotId: this.executor.snapshotId, evidencePath: this.state.evidencePath,
          ...(error instanceof DebugVisualConfirmationRequired ? { recovery: error.recovery } : {}),
          ...(step.dispatchState ? { dispatchState: step.dispatchState } : {}) };
      } finally {
        if (this.state.active) { this.progress("recording", context, "正在保存步骤证据和有限日志。"); this.emit(); }
        // A failed step deadline still permits bounded failure logs. Only a grant/caller cancellation stops them.
        context.logs = context.logWindow ? await this.logs.finish(context.logWindow, step, new Date().toISOString(), cancellationSignal)
          : cancellationSignal.aborted ? this.logs.cancelled(step, new Date().toISOString()) : this.logs.localOnly(step, new Date().toISOString());
        context.finishedAt = new Date().toISOString();
        for (const log of context.logs) log.evidence.finishedAt = context.finishedAt;
        if (this.state.active) this.progress(step.status === "done" ? "completed" : "failed", context, step.message);
        this.busy = this.state.busy = false;
        this.pending = null;
        this.recording.record(context, this.sequence);
        try { this.recording.saveSteps(); }
        catch (error) {
          outcome.recordingWarning = `记录保存失败：${debugStepMessage(error)}`;
          this.recording.recordingFailure(step, "steps_write_failed", error);
          this.recording.record(context, this.sequence);
        }
        if (step.recordingErrors?.length) {
          outcome.recordingWarning = step.recordingErrors.map(error => `记录保存失败：${error.message}`).join(" ");
          outcome.recordingErrors = step.recordingErrors;
        }
        this.emit();
      }
      if (step.taskCheck) { outcome.taskResult = structuredClone(step.taskCheck); outcome.verified = step.taskCheck.status === "passed"; }
      if (command.name === "define_debug_task" && !outcome.isError) {
        outcome.task = structuredClone(this.state.task); outcome.state = structuredClone(this.state);
      }
      return { ...outcome, message: step.message };
    };
    this.done = run();
    return this.done as Promise<Record<string, unknown>>;
  }
}
