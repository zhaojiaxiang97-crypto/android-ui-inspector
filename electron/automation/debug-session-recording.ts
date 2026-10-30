import { join } from "node:path";
import type { DebugCommand } from "../../shared/debug-protocol";
import type { DebugSessionState, DebugStep, DebugStepError } from "../../shared/types";
import { writePrivateJson, type McpSnapshot } from "./mcp-snapshot";
import { DebugEvidenceWriter, appendDebugRecordingErrors, debugEvidenceSnapshot, type DebugEvidenceObservation } from "./debug-evidence";
import { debugStepMessage, type StepContext } from "./debug-step-context";
import { invalidateDebugTaskCheck } from "./debug-task-execution";
import type { DebugSessionReport } from "../../shared/debug-report";

const compatibilityLimit = 8 * 1024 * 1024;
function writeCompatibility(path: string, value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > compatibilityLimit) throw new Error("兼容记录超过8MiB上限，未写入。");
  writePrivateJson(path, value);
}

/** Owns the session's existing evidence writer and compatibility file paths. */
export class DebugSessionRecording {
  readonly directory: string;
  private readonly state: DebugSessionState;
  private readonly evidence: DebugEvidenceWriter;

  constructor(options: { directory: string; state: DebugSessionState; limits?: Partial<DebugSessionReport["limits"]> }) {
    this.state = options.state;
    this.directory = join(options.directory, this.state.id);
    this.evidence = new DebugEvidenceWriter(this.directory, this.state, options.limits);
  }

  recordingFailure(step: DebugStep | undefined, code: string, error: unknown) {
    const issue: DebugStepError = { category: "recording", code, phase: "recording", message: debugStepMessage(error) };
    if (step) {
      appendDebugRecordingErrors(step, [issue]);
      if (step.assertionConfirmation) step.verified = null;
      invalidateDebugTaskCheck(this.state, step, "任务验收的记录保存失败，无法保留完整证据。");
      const summary = step.taskCheck && step.status === "done" ? step.taskCheck.reason : step.message;
      step.message = `${summary} 记录保存失败：${issue.message}`.slice(0, 16000);
    }
    return issue;
  }

  record(context: StepContext, sequence: number) {
    const before: DebugEvidenceObservation = { entry: context.before, freshness: context.beforeFreshness,
      reason: context.beforeFreshness === "previous" && context.before ? "保留操作开始前已有的观察。" : null };
    const after: DebugEvidenceObservation = context.after ? { entry: context.after, freshness: "current", reason: null }
      : !context.task && !context.invalidatedAfter && context.previousAfter ? { entry: context.previousAfter, freshness: "previous",
        reason: "本次未接受新的观察；这是此前页面，不能作为操作后结果。" }
        : { entry: null, freshness: "missing", reason: "本次未接受到操作后的新观察。" };
    try {
      const errors = this.evidence.record(this.state, sequence, { step: context.step,
        finishedAt: context.finishedAt ?? new Date().toISOString(), durationMs: Math.max(0, Math.round(performance.now() - context.started)),
        verified: context.step.verified ?? null, before: { snapshotId: null, freshness: "missing", reason: null },
        after: { snapshotId: null, freshness: "missing", reason: null } }, before, after, context.logs, context.scrollObservations, context.assertionObservations);
      this.state.reportPath = this.evidence.path;
      appendDebugRecordingErrors(context.step, errors);
    } catch (error) { this.recordingFailure(context.step, "report_write_failed", error); }
  }

  // Called after the measured save span ends. This final metadata write is intentionally unmeasured.
  finalizeTiming(context: StepContext, sequence: number) {
    if (!context.step.timings) return;
    const failed = (code: string, error: unknown) => appendDebugRecordingErrors(context.step, [{
      category: "recording", code, phase: "recording", message: debugStepMessage(error),
    }]);
    try {
      this.evidence.finalizeTiming(this.state, sequence, context.step);
      this.state.reportPath = this.evidence.path;
    } catch (error) { failed("timing_report_write_failed", error); }
    // Do not call record/saveSession on failure: those would process attachments again and recurse.
    // Measurement metadata failure also does not invalidate an already persisted task proof.
    try { this.saveSteps(); }
    catch (error) { failed("timing_steps_write_failed", error); }
  }


  saveSession(sequence: number) {
    try {
      const errors = this.evidence.saveSession(this.state, sequence); this.state.reportPath = this.evidence.path;
      const last = this.state.steps.at(-1);
      if (last) appendDebugRecordingErrors(last, errors);
    }
    catch (error) { this.recordingFailure(this.state.steps.at(-1), "report_write_failed", error); }
  }

  saveFailure(context: StepContext, command: DebugCommand) {
    try {
      // Retain only the latest failure; both observations keep their capture timestamps.
      const path = join(this.directory, "last-failure.json");
      const compatible = (entry: McpSnapshot | null) => entry ? { ...entry, snapshot: debugEvidenceSnapshot(entry.snapshot) } : null;
      writeCompatibility(path, { step: context.step, request: command, steps: this.state.steps,
        before: compatible(context.before), after: compatible(context.after),
        content: "tree-properties-without-layer-bitmaps", warning: "兼容文件不含截图或图层位图；完整屏幕证据见report.json。" });
      this.state.evidencePath = path;
    } catch (error) { this.recordingFailure(context.step, "last_failure_write_failed", error); }
  }

  // The session decides whether this failure also requires rewriting the step report.
  saveSteps() {
    writeCompatibility(join(this.directory, "steps.json"), this.state);
  }
}
