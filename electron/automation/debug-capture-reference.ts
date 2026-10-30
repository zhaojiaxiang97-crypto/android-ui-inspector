import assert from "node:assert/strict";
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { debugSelector } from "../../shared/debug-protocol";
import type { DebugSessionReport } from "../../shared/debug-report";
import type { DebugSessionState } from "../../shared/types";
import type { DebugTaskEvidence } from "../../shared/debug-task";
import { evaluateDebugTaskConditions } from "../../shared/debug-task-checker";
import { assertSafeHelperObservationSnapshot } from "../../shared/helper-observation";
import { debugTimingsSchema } from "../../shared/debug-timing";
import { trackSignalDeadline } from "../device/signal-deadline";
import { loadTestReport } from "../desktop/test-report";
import { DEBUG_EVIDENCE_LIMITS, DEBUG_FINAL_TIMING_RESERVE_BYTES } from "./debug-evidence";
import { debugStepMessage } from "./debug-step-context";
import { writePrivateJson } from "./mcp-snapshot";

export const captureReferencePairInput = z.object({
  sessionId: z.string().uuid(), runId: z.string().uuid(),
  selector: debugSelector, expectedNodeCount: z.number().int().min(1).max(20_000),
  timeoutMs: z.number().int().min(1000).max(90_000).default(15_000),
}).strict();
export type CaptureReferencePairInput = z.input<typeof captureReferencePairInput>;
const manifestLimit = 128 * 1024;
const metadataReserve = 128 * 1024;
const pairDelayMs = 350;
class PairStop extends Error { constructor(readonly code: string, message: string) { super(message); } }
function requirePair(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new PairStop(code, message);
}
function boundedRead(path: string, limit: number) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    requirePair(stat.isFile() && stat.size <= limit, "recording_unavailable", "参考记录不是普通文件或超过原容量。");
    const bytes = readFileSync(fd);
    requirePair(bytes.length === stat.size, "recording_changed", "参考记录读取期间变化。");
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}

/** Conservative exclusive reservation inside the original quota; never changes writer limits. */
export function captureReferenceBudget(report: DebugSessionReport, frames: number) {
  requirePair(frames === 1 || frames === 2, "capacity_invalid", "参考对只能预留一帧或两帧。");
  for (const [key, cap] of Object.entries(DEBUG_EVIDENCE_LIMITS))
    requirePair(Number.isSafeInteger(report.limits[key as keyof typeof report.limits])
      && report.limits[key as keyof typeof report.limits] > 0
      && report.limits[key as keyof typeof report.limits] <= cap, "capacity_invalid", "证据限额无效或超过原上限。");
  requirePair(Number.isSafeInteger(report.storage.bytes) && report.storage.bytes >= 0, "capacity_invalid", "证据容量无效。");
  const perFrame = report.limits.maxTreeBytes + report.limits.maxImageBytes + DEBUG_FINAL_TIMING_RESERVE_BYTES + metadataReserve;
  const requiredBytes = frames * perFrame + manifestLimit;
  requirePair(report.storage.bytes + requiredBytes <= report.limits.maxBytes
    && report.steps.length + frames <= report.limits.maxSteps
    && report.snapshots.length + frames <= report.limits.maxSnapshots
    && report.snapshots.filter(s => s.screenshot).length + frames <= report.limits.maxImages,
  "capacity_reserved", "原容量内无法保守预留完整参考帧及最终计时，未继续采集。");
  return { frames, requiredBytes, manifestReserveBytes: manifestLimit, finalTimingReservePerFrame: DEBUG_FINAL_TIMING_RESERVE_BYTES,
    metadataReservePerFrame: metadataReserve, maxBytes: report.limits.maxBytes, usedBytes: report.storage.bytes };
}

type Frame = { role: "R1" | "R2"; stepId: number | null; snapshotId: string | null;
  requestStartedMs: number; requestReturnedMs?: number; productStatus?: string;
  afterFreshness?: string; afterSnapshotId?: string | null; complete: boolean };
export type CaptureReferencePairResult = {
  runId: string; sessionId: string; ownerPid: number; manifestPath: string; reportPath: string | null;
  startedAt: string; finishedAt: string | null; status: "running" | "passed" | "failed" | "cancelled" | "timed_out";
  completeSuccess: boolean; waitVerified: false; frames: Frame[];
  reserved?: ReturnType<typeof captureReferenceBudget>; secondReserved?: ReturnType<typeof captureReferenceBudget>;
  wait?: { requestedMs: 350; startedMs: number; endedMs?: number };
  assessment?: ReturnType<typeof evaluateDebugTaskConditions>;
  failure?: { code: string; message: string };
};

/** Internal diagnostic work only. The owner holds the session lock; this never creates a grant. */
export async function runCaptureReferencePair(options: {
  state: DebugSessionState; directory: string; signal: AbortSignal;
  prepareRecording: () => void;
  capture: (signal: AbortSignal) => Promise<Record<string, unknown>>;
  evidence: () => DebugTaskEvidence | null;
}, input: z.output<typeof captureReferencePairInput>): Promise<CaptureReferencePairResult> {
  const { state } = options, started = performance.now(), deadline = started + input.timeoutMs;
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const signal = trackSignalDeadline(AbortSignal.any([options.signal, timeout]), deadline, [options.signal]);
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  requirePair(lstatSync(options.directory).isDirectory() && !lstatSync(options.directory).isSymbolicLink(),
    "recording_unavailable", "参考目录不能是链接。");
  const manifestPath = join(options.directory, `reference-${input.runId.toLowerCase()}.json`);
  const result: CaptureReferencePairResult = { runId: input.runId, sessionId: state.id, ownerPid: process.pid, manifestPath,
    reportPath: state.reportPath ?? null, startedAt: new Date().toISOString(), finishedAt: null,
    status: "running", completeSuccess: false, waitVerified: false, frames: [] };
  let committed = JSON.stringify(result);
  const fd = openSync(manifestPath, "wx", 0o600);
  try { writeFileSync(fd, committed); fsyncSync(fd); } finally { closeSync(fd); }
  const publish = () => {
    requirePair(boundedRead(manifestPath, manifestLimit) === committed, "manifest_changed", "参考编号的记录已变化，未覆盖或继续。");
    const contents = JSON.stringify(result);
    requirePair(Buffer.byteLength(contents) <= manifestLimit, "manifest_capacity", "参考记录超过128KiB。");
    writePrivateJson(manifestPath, result);
    const f = openSync(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { fsyncSync(f); } finally { closeSync(f); }
    committed = contents;
  };
  const check = () => {
    signal.throwIfAborted();
    requirePair(performance.now() < deadline, "duration_limit", "参考对总期限已到。");
    requirePair(state.active && state.id === input.sessionId && Date.now() < Date.parse(state.expiresAt),
      "session_ended", "参考对会话已结束或不匹配。");
    requirePair(boundedRead(manifestPath, manifestLimit) === committed, "manifest_changed", "参考记录已变化。");
  };
  const readReport = () => {
    requirePair(state.reportPath, "recording_unavailable", "缺少持久化报告，未继续参考采集。");
    requirePair(state.reportPath === join(options.directory, "report.json"), "recording_unavailable", "报告不属于当前会话目录。");
    const report = JSON.parse(boundedRead(state.reportPath, DEBUG_EVIDENCE_LIMITS.maxBytes)) as DebugSessionReport;
    requirePair(report.session.id === state.id && report.session.serial === state.serial
      && report.session.packageName === state.packageName && report.session.droppedSteps === 0,
    "recording_identity", "报告身份或步骤覆盖无效。");
    requirePair(report.steps.every(s => !s.step.recordingErrors?.length && s.step.timings?.status !== "running")
      && report.snapshots.every(s => s.tree && s.screenshot && !s.warnings.length),
    "recording_warning", "现有记录含警告或未完成计时，未继续采集。");
    result.reportPath = state.reportPath;
    return report;
  };
  try {
    check();
    options.prepareRecording();
    result.reserved = captureReferenceBudget(readReport(), 2);
    publish();
    const evidence: DebugTaskEvidence[] = [];
    for (const role of ["R1", "R2"] as const) {
      check();
      if (role === "R2") result.secondReserved = captureReferenceBudget(readReport(), 1);
      const beforeId = state.steps.at(-1)?.id ?? 0;
      const frame: Frame = { role, stepId: null, snapshotId: null,
        requestStartedMs: performance.now() - started, complete: false };
      result.frames.push(frame); publish();
      let response: Record<string, unknown>;
      try { response = await options.capture(signal); }
      finally {
        frame.requestReturnedMs = performance.now() - started;
        const step = state.steps.at(-1);
        if (step && step.id > beforeId) { frame.stepId = step.id; frame.productStatus = step.status; }
      }
      check();
      requirePair(!response.recordingWarning && !(response.recordingErrors as unknown[] | undefined)?.length,
        "recording_warning", "capture证据或最终计时保存失败，未继续参考对。");
      requirePair(!response.isError, "capture_failed", String(response.message ?? "完整capture失败。"));
      const report = readReport(), saved = report.steps.find(s => s.step.id === response.stepId);
      requirePair(saved?.step.status === "done" && saved.step.action === "capture_ui"
        && saved.after.freshness === "current" && saved.after.snapshotId === response.snapshotId
        && !saved.step.inputEvidence && !saved.step.dispatchState, "capture_not_persisted", "capture未完整持久化或不是只读新观察。");
      const timings = debugTimingsSchema.parse(saved.step.timings);
      requirePair(timings.status === "success" && timings.droppedSpans === 0 && timings.observationCount === 1,
        "timing_incomplete", "capture最终计时或单帧观察不完整。");
      const current = options.evidence();
      requirePair(current && current.observation.snapshotId === response.snapshotId
        && current.snapshot.inspectionSource === "accessibility-helper"
        && current.snapshot.nodeCount === input.expectedNodeCount, "capture_identity", "参考快照来源、节点数或身份不符。");
      assertSafeHelperObservationSnapshot(current.snapshot);
      evidence.push(current); frame.snapshotId = current.observation.snapshotId;
      frame.afterFreshness = saved.after.freshness; frame.afterSnapshotId = saved.after.snapshotId; frame.complete = true;
      publish();
      if (role === "R1") {
        result.wait = { requestedMs: 350, startedMs: performance.now() - started }; publish();
        const due = started + result.wait.startedMs + pairDelayMs;
        while (performance.now() < due) {
          check(); await delay(Math.max(1, Math.ceil(due - performance.now())), undefined, { signal });
        }
        check(); result.wait.endedMs = performance.now() - started; publish();
      }
    }
    assert.equal(evidence.length, 2);
    result.assessment = evaluateDebugTaskConditions([
      { id: "reference_visible", selector: input.selector, state: "visible" },
      { id: "reference_enabled", selector: input.selector, state: "enabled" },
    ], evidence[0], evidence[1], state.packageName);
    requirePair(result.assessment.status === "passed", "conditions_not_proved", result.assessment.reason);
    const loaded = await loadTestReport(state.reportPath!, { preferredDebugStepIds: new Set(result.frames.map(f => f.stepId!)) });
    for (const frame of result.frames) {
      const step = loaded.debug?.steps.find(s => s.step.id === frame.stepId);
      const snapshot = loaded.debug?.snapshots.find(s => s.evidence.snapshotId === frame.snapshotId);
      requirePair(step?.after.freshness === "current" && step.verified === null && snapshot?.snapshot && !snapshot.treeError
        && loaded.images.some(i => i.artifactId === snapshot.evidence.screenshot?.sha256 && i.dataUrl && !i.error),
      "archive_incomplete", `参考对归档无法按原读取预算完整重导入：${snapshot?.treeError ?? loaded.images.find(i => i.error)?.error ?? "缺少当前步骤或截图"}`);
    }
    check(); result.completeSuccess = true; result.status = "passed";
  } catch (error) {
    result.status = timeout.aborted ? "timed_out" : options.signal.aborted ? "cancelled" : "failed";
    result.failure = { code: timeout.aborted ? "duration_limit" : options.signal.aborted ? "cancelled"
      : error instanceof PairStop ? error.code : "reference_failed", message: debugStepMessage(error) };
  } finally {
    result.reportPath = state.reportPath ?? result.reportPath;
    // A failed second read may retain R1 as previous evidence; never label it as a new R2.
    for (const frame of result.frames.filter(f => !f.complete && f.stepId !== null)) {
      try {
        const report = JSON.parse(boundedRead(join(options.directory, "report.json"), DEBUG_EVIDENCE_LIMITS.maxBytes)) as DebugSessionReport;
        const saved = report.steps.find(s => s.step.id === frame.stepId);
        if (saved) { frame.afterFreshness = saved.after.freshness; frame.afterSnapshotId = saved.after.snapshotId; }
      } catch { /* The failed manifest keeps the missing fields instead of borrowing old state. */ }
    }
    result.finishedAt = new Date().toISOString();
    try { publish(); } catch (error) {
      throw Object.assign(new Error("reference_manifest_write_failed"), { errors: [result.failure, error] });
    }
  }
  return structuredClone(result);
}
