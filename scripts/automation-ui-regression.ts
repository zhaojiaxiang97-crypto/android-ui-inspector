#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { debugUiStepExpectation, debugUiStepTarget, performUiStepInput, scrollUntilInput } from "../shared/debug-protocol";
import { scrollUntilInputBase, scrollInputMethodError } from "../shared/debug-step-input";
import { debugTimingsSchema } from "../shared/debug-timing";
import { debugScrollProgressSchema } from "../shared/debug-scroll-validation";
import { helperObservationDiagnosticsSchema } from "../shared/helper-observation-diagnostics";
import { assertSameHelperServiceEvidence } from "../shared/helper-observation";
import type { LoadedTestReport } from "../shared/test-report";
import type { DebugReportStep, DebugSnapshotEvidence } from "../shared/debug-report";

const key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const uuid = "11111111-1111-4111-8111-111111111111";
const stepInput = z.object({ target: debugUiStepTarget.optional(), action: performUiStepInput.shape.action,
  expect: debugUiStepExpectation, timeoutMs: performUiStepInput.shape.timeoutMs }).strict()
  .refine(input => performUiStepInput.safeParse({ ...input, sessionId: uuid, requestId: uuid, backend: "accessibility-helper" }).success, "操作目标与动作不一致");
const checkpoint = z.array(debugUiStepExpectation.refine(value => Boolean(value.selector.resourceId), "起点条件必须包含精确 resourceId"))
  .min(1).max(5).refine(items => items.some(item => item.state !== "absent"), "起点至少需要一个可见或启用状态条件");
export const regressionPlanSchema = z.object({
  version: z.literal(1), id: key, serial: z.string().min(1).max(512),
  packageName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/),
  backend: z.enum(["uiautomator", "accessibility-helper"]), rounds: z.number().int().min(1).max(10),
  maxDurationMs: z.number().int().min(10_000).max(25 * 60_000),
  checkpointTimeoutMs: z.number().int().min(1000).max(30_000).default(15_000),
  resumeTimeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
  startConditions: checkpoint, returnConditions: checkpoint,
  steps: z.array(z.discriminatedUnion("kind", [
    z.object({ id: key, kind: z.literal("step"), input: stepInput }).strict(),
    z.object({ id: key, kind: z.literal("scroll-until"),
      input: scrollUntilInputBase.omit({ sessionId: true, requestId: true, backend: true, visualConfirmation: true }) }).strict(),
  ])).min(1).max(8),
}).strict().refine(value => new Set(value.steps.map(item => item.id)).size === value.steps.length, "步骤 id 必须唯一")
  .superRefine((plan, context) => {
    const conditions = [...plan.startConditions, ...plan.returnConditions,
      ...plan.steps.flatMap(step => step.kind === "step" ? [step.input.expect] : [])];
    if (plan.backend !== "accessibility-helper" && conditions.some(item => item.visibility === "partial"))
      context.addIssue({ code: "custom", path: ["backend"], message: "partial 需要 accessibility-helper 观察。" });
    plan.steps.forEach((step, index) => {
      if (step.kind !== "scroll-until") return;
      const message = scrollInputMethodError({ ...step.input, backend: plan.backend });
      if (message) context.addIssue({ code: "custom", path: ["steps", index, "input"], message });
    });
  });
export type RegressionPlan = z.infer<typeof regressionPlanSchema>;
type Json = Record<string, unknown>;
type Execute = (command: string, args: string[], signal: AbortSignal) => Promise<unknown>;
type Identity = { sessionId: string; serial: string; packageName: string; expiresAtMs: number };
type RecoveryFailure = { requestId: string; originalStepId: number; originalFingerprint: string; inputSha256: string };
type Evidence = { complete: boolean | null; missingSteps: number; missingTrees: number; missingScreenshots: number;
  invalidAttachments: number; recordingErrors: number; reason: string | null;
  absentObservations?: number; recoverableFailure?: RecoveryFailure; recoveryChain?: RecoveryFailure & { resumeStepId: number } };
type Archive = { reportPath: string | null; evidence: Evidence };
type Sample = { round: number; step: string; kind: "step" | "scroll-until" | "checkpoint"; requestId: string | null;
  inputSha256?: string;
  wallMs: number; productMs: number | null; productTimingsComplete: boolean; functionalPassed: boolean;
  firstAttemptPassed: boolean; responseRecovered: boolean; helperAutoRecoveryReads: number; otherAutoRecoveryReads: number;
  independentResumeAttempts: number; independentResumePassed: boolean; confirmedInputs: number; uncertainInputs: number;
  notSentInputs: number; inputCountKnown: boolean; recordingErrorCount: number; evidenceCapacityExceeded: boolean;
  productStepIds: number[]; archives: Archive[]; stopCode: string | null };
export type RegressionSummary = { version: 1; runId: string; planId: string; planSha256: string;
  sessionId: string; backend: RegressionPlan["backend"]; requestedRounds: number; completedRounds: number;
  startedAt: string; finishedAt: string; wallMs: number; productMs: number | null; measuredProductMs: number;
  productTimingsComplete: boolean; actionAttempts: number; firstAttemptSuccessRate: number | null;
  helperAutoRecoveryReads: number; otherAutoRecoveryReads: number; independentResumeAttempts: number;
  responseRecoveries: number; confirmedInputs: number; uncertainInputs: number; notSentInputs: number;
  inputCountKnown: boolean; scriptHumanConfirmations: 0; externalHumanInterventions: null; humanInterventionRequired: boolean;
  functionalPassed: boolean; evidence: Evidence; completeSuccess: boolean; stopCode: string | null;
  productReportPath: string | null; roundEvidence: { round: number; evidence: Evidence }[] };
type Options = { plan: unknown; sessionId: string; outputDirectory: string; execute: Execute; signal?: AbortSignal;
  archive?: (path: string | null, ids: number[], parent: string, identity: Identity, signal: AbortSignal, expectedVerifiedId?: number) => Promise<Archive>; now?: () => number };

const object = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
class RunStop extends Error { constructor(readonly code: string) { super(code); } }
function stopped(code: string): never { throw new RunStop(code); }
const safeCode = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : "product_failure";
const unknownEvidence = (reason: string): Evidence => ({ complete: null, missingSteps: 0, missingTrees: 0,
  missingScreenshots: 0, invalidAttachments: 0, recordingErrors: 0, absentObservations: 0, reason });

/** A process may lose its reply after input. This transport never repeats a command. */
export function createCliExecute(cliFile: string, snapshotFile?: string): Execute {
  return (command, args, signal) => new Promise((resolveResult, reject) => {
    if (signal.aborted) { reject(new RunStop("cancelled")); return; }
    const child = spawn(process.execPath, [cliFile, command, ...args, ...(snapshotFile ? ["--snapshot-file", snapshotFile] : [])],
      { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const chunks: Buffer[] = []; let bytes = 0, overflow = false;
    const limit = 8 * 1024 * 1024;
    const receive = (chunk: Buffer) => { bytes += chunk.length; if (bytes > limit) { overflow = true; child.kill("SIGTERM"); }
      else chunks.push(chunk); };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 1000); killTimer.unref(); };
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => { signal.removeEventListener("abort", abort); if (killTimer) clearTimeout(killTimer); };
    child.once("error", () => { cleanup(); reject(new RunStop("cli_unavailable")); });
    child.once("close", () => {
      cleanup();
      if (signal.aborted) { reject(new RunStop("cancelled")); return; }
      if (overflow) { reject(new RunStop("cli_output_limit")); return; }
      try { resolveResult(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new RunStop("cli_response_unavailable")); }
    });
  });
}

function verifyIdentity(raw: unknown, expected: Omit<Identity, "expiresAtMs">, now: number, expiresAtMs?: number): Identity {
  const state = object(raw), expiry = typeof state.expiresAt === "string" ? Date.parse(state.expiresAt) : NaN;
  if (state.id !== expected.sessionId || state.serial !== expected.serial || state.packageName !== expected.packageName)
    stopped("session_identity_mismatch");
  if (state.active !== true || state.busy !== false || !Number.isFinite(expiry) || expiry <= now)
    stopped("session_inactive_busy_or_expired");
  if (expiresAtMs !== undefined && expiry !== expiresAtMs) stopped("session_expiry_changed");
  return { ...expected, expiresAtMs: expiry };
}

function readObservationFailures(raw: Json) {
  let helper = 0, other = 0;
  if (Array.isArray(raw.observationFailures)) for (const entry of raw.observationFailures.slice(0, 3)) {
    const failure = object(entry), error = object(failure.error);
    if (failure.willRetry !== true) continue;
    if (helperObservationDiagnosticsSchema.safeParse(error.helperDiagnostics).success) helper++; else other++;
  }
  return { helper, other };
}
function inputCounts(raw: Json, kind: Sample["kind"]) {
  if (kind === "checkpoint") return { sent: 0, unknown: 0, notSent: 0, known: true };
  if (kind === "scroll-until") {
    const progress = debugScrollProgressSchema.safeParse(raw.scrollTask);
    if (!progress.success) return { sent: 0, unknown: 0, notSent: 0, known: false };
    return { sent: progress.data.iterations.filter(item => item.dispatchState === "sent").length,
      unknown: progress.data.iterations.filter(item => item.dispatchState === "unknown").length,
      notSent: progress.data.iterations.filter(item => item.dispatchState === "not_sent").length, known: true };
  }
  return { sent: raw.dispatchState === "sent" ? 1 : 0, unknown: raw.dispatchState === "unknown" ? 1 : 0,
    notSent: raw.dispatchState === "not_sent" ? 1 : 0, known: ["sent", "unknown", "not_sent"].includes(String(raw.dispatchState)) };
}

function recoveryFailure(entry: DebugReportStep, sessionId: string, before: DebugSnapshotEvidence | undefined): RecoveryFailure | null {
  const { step } = entry, request = performUiStepInput.safeParse(step.input), receipt = step.inputEvidence;
  const helperDiagnostics = step.error?.code === "helper-incomplete"
    ? helperObservationDiagnosticsSchema.safeParse(step.error.helperDiagnostics) : undefined;
  const captureFailed = step.error?.code === "capture_failed" || helperDiagnostics?.success === true && helperDiagnostics.data.reasons.length > 0;
  if (step.action !== "perform_ui_step" || !request.success || request.data.sessionId !== sessionId
    || request.data.backend !== "accessibility-helper" || request.data.expect?.visibility !== "partial"
    || step.status !== "failed" || entry.verified !== false || step.dispatchState !== "sent"
    || step.error?.category !== "capture" || !captureFailed || step.error.phase !== "capture"
    || !entry.before.snapshotId || entry.before.freshness !== "current" || step.beforeId !== entry.before.snapshotId
    || entry.after.snapshotId !== null || entry.after.freshness !== "missing" || step.afterId
    || step.assertionConfirmation || !step.resolvedInput || receipt?.classification !== "accepted"
    || before?.snapshotId !== entry.before.snapshotId || before.source !== "accessibility-helper") return null;
  if (receipt.transport === "accessibility-helper"
    ? receipt.helperInput?.dispatchState !== "sent" || receipt.helperInput.receipt?.status !== "completed"
      || receipt.helperInput.receipt.dispatchState !== "sent"
    : !receipt.spawned || !receipt.closed || receipt.exitCode !== 0 || receipt.signal !== null || receipt.systemInjection?.status === "rejected") return null;
  // Includes the original request/expectation, input receipt and failure; never publish page contents.
  return { requestId: request.data.requestId, originalStepId: step.id,
    inputSha256: digest(request.data),
    originalFingerprint: digest({ step, finishedAt: entry.finishedAt, before: entry.before, after: entry.after, verified: entry.verified,
      beforeEvidence: { snapshotId: before.snapshotId, capturedAt: before.capturedAt, source: before.source, tree: before.tree, screenshot: before.screenshot } }) };
}

/** Fixed counts and opaque recovery bindings only; page contents stay in the product report. */
export async function inspectRegressionEvidence(path: string | null, stepIds: number[], expected: Pick<Identity, "sessionId" | "serial" | "packageName">,
  load: (path: string) => Promise<LoadedTestReport>, expectedVerifiedId?: number): Promise<Evidence> {
  if (!path || !stepIds.length) return unknownEvidence("report_or_steps_unavailable");
  try {
    const loaded = await load(path), document = loaded.debug;
    if (!document || document.session.id !== expected.sessionId || document.session.serial !== expected.serial
      || document.session.packageName !== expected.packageName) return unknownEvidence("report_identity_mismatch");
    const needed = new Set(stepIds), steps = document.steps.filter(item => needed.has(item.step.id));
    const references = new Set(steps.flatMap(item => [item.before.snapshotId, item.after.snapshotId,
      item.step.assertionConfirmation?.first.snapshotId, item.step.assertionConfirmation?.second.snapshotId,
      ...(item.step.scrollTask?.iterations ?? []).flatMap(iteration => [iteration.resolvedInput?.visualConfirmation?.referenceSnapshotId,
        iteration.resolvedInput?.visualConfirmation?.currentSnapshotId]),
      ...item.step.scrollTask?.observationIds ?? []]).filter((id): id is string => id !== null && id !== undefined));
    const evidence: Evidence = { complete: true, missingSteps: needed.size - steps.length, missingTrees: 0,
      missingScreenshots: 0, invalidAttachments: 0, recordingErrors: 0, absentObservations: 0, reason: null };
    if (expectedVerifiedId !== undefined && steps.find(item => item.step.id === expectedVerifiedId)?.verified !== true)
      evidence.invalidAttachments++;
    for (const id of references) {
      const snapshot = document.snapshots.find(item => item.evidence.snapshotId === id);
      if (!snapshot?.evidence.tree) evidence.missingTrees++;
      else if (snapshot.treeError || !snapshot.snapshot?.root) evidence.invalidAttachments++;
      if (!snapshot?.evidence.screenshot) evidence.missingScreenshots++;
      else {
        const image = loaded.images.find(item => item.artifactId === snapshot.screenshotArtifactId);
        if (!image?.dataUrl || image.error) evidence.invalidAttachments++;
      }
    }
    for (const entry of steps) {
      evidence.recordingErrors += entry.step.recordingErrors?.length ?? 0;
      evidence.invalidAttachments += entry.logs?.filter(log => Boolean(log.loadError) || log.status === "available" && !log.file).length ?? 0;
      const needsBefore = ["perform_ui_step", "scroll_until", "resume_ui_step", "tap_node", "scroll_node", "press_back"].includes(entry.step.action);
      const needsAfter = entry.step.action !== "define_debug_task";
      const missingReferences = Number(needsBefore && !entry.before.snapshotId) + Number(needsAfter && !entry.after.snapshotId);
      evidence.absentObservations! += missingReferences;
    }
    if (evidence.missingSteps || evidence.missingTrees || evidence.missingScreenshots || evidence.invalidAttachments || evidence.recordingErrors) {
      evidence.complete = false; evidence.reason = "evidence_missing_or_invalid";
    } else if (evidence.absentObservations) {
      evidence.complete = false; evidence.reason = "observation_not_produced";
      const original = steps.find(entry => entry.step.action === "perform_ui_step");
      const beforeSnapshot = document.snapshots.find(item => item.evidence.snapshotId === original?.before.snapshotId);
      const before = beforeSnapshot?.evidence;
      const failure = original && recoveryFailure(original, expected.sessionId, before);
      if (steps.length === 1 && evidence.absentObservations === 1 && failure) evidence.recoverableFailure = failure;
      const resumed = steps.find(entry => entry.step.id === expectedVerifiedId), proof = resumed?.step.assertionConfirmation;
      if (steps.length === 2 && failure && original && before && resumed && proof
        && resumed.step.action === "resume_ui_step" && resumed.step.input.sessionId === expected.sessionId
        && resumed.step.input.requestId === failure.requestId && resumed.step.id > original.step.id
        && resumed.verified === true && resumed.step.status === "done" && !resumed.step.error
        && resumed.step.dispatchState === "sent" && !resumed.step.inputEvidence && !resumed.step.resolvedInput
        && Date.parse(resumed.step.time) >= Date.parse(original.finishedAt)
        && Date.parse(proof.first.capturedAt) >= Date.parse(resumed.step.time)
        && Date.parse(proof.first.capturedAt) > Date.parse(before.capturedAt)
        && proof.first.snapshotId !== before.snapshotId && proof.second.snapshotId !== before.snapshotId
        && evidence.absentObservations === (resumed.before.snapshotId ? 1 : 2)) {
        const beforeCapture = beforeSnapshot?.snapshot?.helperObservation;
        const firstCapture = document.snapshots.find(item => item.evidence.snapshotId === proof.first.snapshotId)?.snapshot?.helperObservation;
        if (!beforeCapture || !firstCapture) return evidence;
        // Navigation may change windows; the service and device monotonic clock must still prove a new capture.
        try { assertSameHelperServiceEvidence(beforeCapture, firstCapture); } catch { return evidence; }
        const receipt = original.step.inputEvidence?.helperInput?.receipt;
        if (receipt && firstCapture.timing.startedAtMs < receipt.finishedAtMs) return evidence;
        // The real loader has independently checked both fresh partial frames, their identity and original input safety.
        evidence.complete = true; evidence.reason = null;
        evidence.recoveryChain = { ...failure, resumeStepId: resumed.step.id };
      }
    }
    return evidence;
  } catch { return unknownEvidence("report_load_failed"); }
}

function mergeEvidence(items: Evidence[]): Evidence {
  const combined = unknownEvidence("archive_unavailable");
  if (!items.length) return combined;
  combined.complete = items.every(item => item.complete === true) ? true : items.some(item => item.complete === false) ? false : null;
  for (const key of ["missingSteps", "missingTrees", "missingScreenshots", "invalidAttachments", "recordingErrors"] as const)
    combined[key] = items.reduce((sum, item) => sum + item[key], 0);
  combined.absentObservations = items.reduce((sum, item) => sum + (item.absentObservations ?? 0), 0);
  combined.reason = combined.complete === true ? null : "archive_incomplete_or_unknown";
  return combined;
}

function sampleEvidence(sample: Sample): Evidence {
  const last = sample.archives.at(-1)?.evidence, chain = last?.complete === true && last.recoveryChain;
  return mergeEvidence(sample.archives.map((archive, index) => {
    const evidence = archive.evidence, failure = evidence.recoverableFailure;
    const resolved = sample.independentResumePassed && chain && failure && index < sample.archives.length - 1
      && sample.requestId === chain.requestId && sample.productStepIds[0] === chain.originalStepId
      && sample.inputSha256 === chain.inputSha256 && failure.inputSha256 === chain.inputSha256
      && sample.productStepIds.at(-1) === chain.resumeStepId
      && failure.requestId === chain.requestId && failure.originalStepId === chain.originalStepId
      && failure.originalFingerprint === chain.originalFingerprint
      && evidence.complete === false && evidence.reason === "observation_not_produced" && evidence.absentObservations === 1
      && !evidence.missingSteps && !evidence.missingTrees && !evidence.missingScreenshots
      && !evidence.invalidAttachments && !evidence.recordingErrors;
    // Preserve the failed archive verbatim; only the combined chain can resolve its absent post-input observation.
    return resolved ? { ...evidence, complete: true, reason: null } : evidence;
  }));
}

async function archiveRegressionEvidence(path: string | null, ids: number[], parent: string, identity: Identity, signal: AbortSignal, expectedVerifiedId?: number): Promise<Archive> {
  if (!path || !ids.length) return { reportPath: null, evidence: unknownEvidence("report_or_steps_unavailable") };
  try {
    signal.throwIfAborted();
    const { loadTestReport } = await import("../electron/desktop/test-report");
    const sourceFile = join(await realpath(dirname(path)), basename(path));
    const loaded = await loadTestReport(sourceFile);
    if (loaded.debug?.session.id !== identity.sessionId || loaded.debug.session.serial !== identity.serial
      || loaded.debug.session.packageName !== identity.packageName) return { reportPath: null, evidence: unknownEvidence("report_identity_mismatch") };
    const selectedIds = new Set(ids), definitionId = loaded.debug.task?.definedStepId;
    if (definitionId && loaded.debug.steps.some(entry => entry.step.id === definitionId)) selectedIds.add(definitionId);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const { exportDebugReportEvidence } = await import("../electron/desktop/debug-report-export");
    const result = await exportDebugReportEvidence({ filePath: sourceFile, reportSha256: loaded.index.reportSha256 }, {
      requestId: randomUUID(), sourceId: identity.sessionId, reportSha256: loaded.index.reportSha256, stepIds: [...selectedIds],
      includeTrees: true, includeScreenshots: true, includeLogs: true,
    }, parent, { appVersion: "automation-regression-1", signal });
    if (!result.directory || result.error || result.canceled) return { reportPath: null, evidence: unknownEvidence("archive_failed") };
    const reportPath = join(result.directory, "report.json");
    return { reportPath, evidence: await inspectRegressionEvidence(reportPath, ids, identity, loadTestReport, expectedVerifiedId) };
  } catch { return { reportPath: null, evidence: unknownEvidence(signal.aborted ? "archive_cancelled" : "archive_failed") }; }
}

export async function runUiRegression(options: Options): Promise<RegressionSummary> {
  const plan = regressionPlanSchema.parse(options.plan), sessionId = z.string().uuid().parse(options.sessionId);
  if (Buffer.byteLength(JSON.stringify(plan)) > 64 * 1024) stopped("plan_too_large");
  const now = options.now ?? Date.now, started = now(), runId = randomUUID(), planSha256 = digest(plan);
  // Exclusive creation prevents accidentally reusing a log containing previously dispatched UUIDs.
  await mkdir(dirname(options.outputDirectory), { recursive: true, mode: 0o700 });
  await mkdir(options.outputDirectory, { recursive: false, mode: 0o700 });
  const journal = await open(join(options.outputDirectory, "samples.jsonl"), "wx", 0o600);
  const parentSignal = options.signal, deadline = AbortSignal.timeout(plan.maxDurationMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
  const identity = { sessionId, serial: plan.serial, packageName: plan.packageName };
  const samples: Sample[] = [], roundEvidence: RegressionSummary["roundEvidence"] = [];
  const productMeasurements = new Map<number, number>();
  let missingTimings = false, expiresAtMs: number | undefined, reportPath: string | null = null, stopCode: string | null = null, completedRounds = 0;
  const append = async (value: unknown) => { await journal.writeFile(`${JSON.stringify(value)}\n`); await journal.sync(); };
  const check = () => { if (signal.aborted) stopped(deadline.aborted ? "duration_limit" : "cancelled");
    if (now() - started >= plan.maxDurationMs) stopped("duration_limit"); };
  const call = async (command: string, args: string[]) => { check(); return object(await options.execute(command, args, signal)); };
  const attach = async () => {
    const state = await call("attach", []), verified = verifyIdentity(state, identity, now(), expiresAtMs);
    expiresAtMs = verified.expiresAtMs;
    if (typeof state.reportPath === "string" && isAbsolute(state.reportPath)) reportPath = state.reportPath;
    return state;
  };
  const register = (raw: Json, sample: Sample) => {
    const parsedId = count(raw.stepId), id = parsedId && parsedId > 0 ? parsedId : null;
    if (id !== null && id > 0 && !sample.productStepIds.includes(id)) sample.productStepIds.push(id);
    const timings = debugTimingsSchema.safeParse(raw.timings);
    if (id === null || !timings.success || timings.data.status === "running") { sample.productTimingsComplete = false; missingTimings = true; }
    else productMeasurements.set(id, timings.data.durationMs);
    const recovery = readObservationFailures(raw);
    sample.helperAutoRecoveryReads += recovery.helper; sample.otherAutoRecoveryReads += recovery.other;
    sample.recordingErrorCount += Array.isArray(raw.recordingErrors) ? raw.recordingErrors.length : raw.recordingWarning ? 1 : 0;
    sample.evidenceCapacityExceeded ||= Array.isArray(raw.recordingErrors)
      && raw.recordingErrors.some(error => object(error).code === "evidence_capacity_exceeded");
  };
  const makeSample = (round: number, step: string, kind: Sample["kind"], requestId: string | null): Sample => ({ round, step, kind, requestId,
    wallMs: 0, productMs: null, productTimingsComplete: true, functionalPassed: false, firstAttemptPassed: false,
    responseRecovered: false, helperAutoRecoveryReads: 0, otherAutoRecoveryReads: 0, independentResumeAttempts: 0,
    independentResumePassed: false, confirmedInputs: 0, uncertainInputs: 0, notSentInputs: 0, inputCountKnown: true,
    recordingErrorCount: 0, evidenceCapacityExceeded: false, productStepIds: [], archives: [], stopCode: null });
  const archive = async (sample: Sample, suffix: string, ids = sample.productStepIds,
    verifiedId = sample.functionalPassed ? ids.at(-1) : undefined) => {
    if (!signal.aborted) await attach();
    const saved = await (options.archive ?? archiveRegressionEvidence)(reportPath, [...ids],
      join(options.outputDirectory, "evidence", `round-${sample.round}`, `${sample.step}-${suffix}`), { ...identity, expiresAtMs: expiresAtMs! }, signal,
      verifiedId);
    sample.archives.push(saved);
    await append({ event: "archive", round: sample.round, step: sample.step, requestId: sample.requestId, ...saved });
  };
  const requireCompleteArchives = (sample: Sample) => {
    if (sampleEvidence(sample).complete !== true) stopped("evidence_archive_incomplete");
  };
  const finishSample = async (sample: Sample, sampleStarted: number) => {
    sample.wallMs = Math.max(0, now() - sampleStarted);
    sample.productMs = sample.productTimingsComplete ? sample.productStepIds.reduce((sum, id) => sum + (productMeasurements.get(id) ?? 0), 0) : null;
    samples.push(sample); await append({ event: "result", ...sample });
  };
  const validateCheckpoint = async (round: number, conditions: RegressionPlan["startConditions"], label: string) => {
    const sample = makeSample(round, label, "checkpoint", null), sampleStarted = now();
    const frozen = new Set<number>();
    const freeze = async (suffix: string, verifiedId?: number) => {
      const ids = sample.productStepIds.filter(id => !frozen.has(id));
      if (!ids.length) return;
      ids.forEach(id => frozen.add(id));
      try { await archive(sample, suffix, ids, verifiedId); }
      catch (error) {
        sample.archives.push({ reportPath: null, evidence: unknownEvidence("archive_failed") });
        if (error instanceof RunStop) throw error;
        check(); stopped("evidence_archive_incomplete");
      }
      requireCompleteArchives(sample);
    };
    try {
      await attach();
      for (const condition of conditions) {
        const selectorFlags = Object.entries(condition.selector).flatMap(([key, value]) => [
          `--${({ resourceId: "resource-id", text: "text", contentDesc: "desc", className: "class" })[key as "resourceId"]}`, String(value)]);
        const result = await call("wait", ["--session", sessionId, "--backend", plan.backend, ...selectorFlags, "--state", condition.state,
          ...condition.visibility ? ["--visibility", condition.visibility] : [],
          "--timeout-ms", String(plan.checkpointTimeoutMs)]);
        register(result, sample);
        if (result.isError || result.verified !== true || typeof result.snapshotId !== "string") stopped("checkpoint_not_verified");
        const timings = debugTimingsSchema.safeParse(result.timings);
        const observations = timings.success ? timings.data.spans.filter(item => item.phase === "observation") : [];
        if (!observations.length || observations.some(item => item.backend !== plan.backend)) stopped("checkpoint_backend_unconfirmed");
        const matched = await call("find", ["", "--snapshot", result.snapshotId, ...selectorFlags, "--visible", "true",
          ...(condition.state === "enabled" || condition.state === "disabled" ? ["--enabled", String(condition.state === "enabled")] : []), "--limit", "1"]);
        if (matched.snapshotId !== result.snapshotId || matched.total !== (condition.state === "absent" ? 0 : 1)) stopped("checkpoint_not_unique");
        await freeze(`condition-${sample.productStepIds.length - 1}`, sample.productStepIds.at(-1));
      }
      sample.functionalPassed = true;
      requireCompleteArchives(sample);
    } catch (error) {
      sample.stopCode = error instanceof RunStop ? error.code : "checkpoint_failed";
      if (!sample.functionalPassed && sample.productStepIds.length && !signal.aborted) {
        try { await freeze("failed-checkpoint"); } catch { /* Keep the original checkpoint failure. */ }
      }
      throw error;
    }
    finally { await finishSample(sample, sampleStarted); }
  };
  const action = async (round: number, definition: RegressionPlan["steps"][number]) => {
    const requestId = randomUUID(), sampleStarted = now(), sample = makeSample(round, definition.id, definition.kind, requestId);
    let latest: Json = {}, registeredIds = new Set<number>();
    const knownInputs: { counts: ReturnType<typeof inputCounts> | null } = { counts: null };
    const rememberInputs = (receipt: Json) => {
      if (receipt.requestId !== requestId) return;
      const counts = inputCounts(receipt, definition.kind);
      if (counts.known && !knownInputs.counts) knownInputs.counts = counts;
    };
    const registerOnce = (result: Json) => {
      const parsedId = count(result.stepId), id = parsedId && parsedId > 0 ? parsedId : null;
      if (id === null || !registeredIds.has(id)) { register(result, sample); if (id !== null) registeredIds.add(id); }
    };
    try {
      await attach();
      const input = (definition.kind === "step" ? performUiStepInput : scrollUntilInput).parse({ ...definition.input,
        sessionId, requestId, backend: plan.backend });
      sample.inputSha256 = digest(input);
      await append({ event: "prepared", round, step: definition.id, kind: definition.kind, requestId, backend: plan.backend,
        timeoutMs: input.timeoutMs, planSha256, inputSha256: digest(input) });
      try { latest = await call(definition.kind, ["--input-json", JSON.stringify(input)]); }
      catch {
        check();
        // A missing response proves nothing about dispatch. Only query the already persisted UUID.
        latest = await call("get-step", ["--session", sessionId, "--request-id", requestId]);
        sample.responseRecovered = true;
      }
      if (latest.requestId !== requestId || latest.found === false) stopped("request_result_unavailable");
      rememberInputs(latest);
      registerOnce(latest);
      if (latest.requestState !== "completed") stopped("request_not_completed");
      if (latest.dispatchState === "unknown") stopped("dispatch_unknown");
      const passed = latest.verified === true && latest.isError !== true;
      sample.firstAttemptPassed = passed && sample.helperAutoRecoveryReads === 0 && sample.otherAutoRecoveryReads === 0 && !sample.responseRecovered;
      if (!passed && object(latest.error).code === "expectation_not_met_timeout") stopped("expectation_not_met_timeout");
      if (!passed && latest.dispatchState === "sent") {
        await archive(sample, "failed");
        await attach();
        sample.independentResumeAttempts = 1;
        await append({ event: "resume_prepared", round, step: definition.id, requestId });
        try { latest = await call("resume-step", ["--session", sessionId, "--request-id", requestId, "--timeout-ms", String(plan.resumeTimeoutMs)]); }
        catch { check(); latest = await call("get-step", ["--session", sessionId, "--request-id", requestId]); sample.responseRecovered = true; }
        if (latest.requestId !== requestId) stopped("request_result_mismatch");
        rememberInputs(latest);
        registerOnce(latest);
        if (latest.requestState !== "completed") stopped("request_not_completed");
        sample.independentResumePassed = latest.verified === true && latest.isError !== true;
      }
      const counts = inputCounts(latest, definition.kind);
      if (knownInputs.counts && counts.known && (counts.sent !== knownInputs.counts.sent || counts.unknown !== knownInputs.counts.unknown
        || counts.notSent !== knownInputs.counts.notSent)) stopped("input_history_mismatch");
      sample.confirmedInputs = counts.sent; sample.uncertainInputs = counts.unknown;
      sample.notSentInputs = counts.notSent; sample.inputCountKnown = counts.known;
      if (!counts.known) stopped("input_count_unavailable");
      if (latest.dispatchState === "unknown" || counts.unknown) stopped("dispatch_unknown");
      if (latest.verified !== true || latest.isError === true) stopped(latest.dispatchState === "not_sent" ? "input_not_sent" : safeCode(object(latest.error).code));
      if (definition.kind === "step" && latest.dispatchState !== "sent") stopped("dispatch_unconfirmed");
      sample.functionalPassed = true;
      await archive(sample, sample.independentResumeAttempts ? "resumed" : "verified");
      // A bound read-only recovery may complete an observation chain, never replace missing captured attachments.
      requireCompleteArchives(sample);
    } catch (error) {
      const counts = knownInputs.counts ?? inputCounts({}, definition.kind);
      sample.confirmedInputs = counts.sent; sample.uncertainInputs = counts.unknown;
      sample.notSentInputs = counts.notSent; sample.inputCountKnown = counts.known;
      if (!registeredIds.size) { sample.productTimingsComplete = false; missingTimings = true; }
      sample.stopCode = error instanceof RunStop ? error.code : "action_failed";
      if (sample.productStepIds.length && !sample.archives.length && !signal.aborted) {
        try { await archive(sample, "stopped"); } catch { sample.archives.push({ reportPath: null, evidence: unknownEvidence("archive_failed") }); }
      }
      throw error;
    } finally { await finishSample(sample, sampleStarted); }
  };
  try {
    await append({ event: "run", version: 1, runId, planId: plan.id, planSha256, sessionId, backend: plan.backend,
      startedAt: new Date(started).toISOString(), requestedRounds: plan.rounds });
    await attach();
    if (expiresAtMs! - now() < plan.maxDurationMs + 5000) stopped("insufficient_grant_duration");
    for (let round = 1; round <= plan.rounds; round++) {
      await validateCheckpoint(round, plan.startConditions, "start");
      for (const step of plan.steps) await action(round, step);
      await validateCheckpoint(round, plan.returnConditions, "return");
      completedRounds++;
      await attach();
      roundEvidence.push({ round, evidence: mergeEvidence(samples.filter(sample => sample.round === round).map(sampleEvidence)) });
      await append({ event: "round", round, evidence: roundEvidence[roundEvidence.length - 1].evidence });
    }
  } catch (error) { stopCode = signal.aborted ? deadline.aborted ? "duration_limit" : "cancelled"
    : error instanceof RunStop ? error.code : "run_failed"; }
  finally { await journal.close(); }
  const evidence = mergeEvidence(samples.map(sampleEvidence));
  if (samples.some(sample => sample.recordingErrorCount)) {
    evidence.complete = false; evidence.reason = "recording_error";
    evidence.recordingErrors = Math.max(evidence.recordingErrors, samples.reduce((sum, sample) => sum + sample.recordingErrorCount, 0));
  }
  const actions = samples.filter(sample => sample.kind !== "checkpoint");
  const sum = (field: "helperAutoRecoveryReads" | "otherAutoRecoveryReads" | "independentResumeAttempts" | "confirmedInputs" | "uncertainInputs" | "notSentInputs") => samples.reduce((total, sample) => total + sample[field], 0);
  const productTimingsComplete = !missingTimings && productMeasurements.size > 0, measuredProductMs = [...productMeasurements.values()].reduce((a, b) => a + b, 0);
  const functionalPassed = !stopCode && completedRounds === plan.rounds;
  const summary: RegressionSummary = { version: 1, runId, planId: plan.id, planSha256, sessionId, backend: plan.backend,
    requestedRounds: plan.rounds, completedRounds, startedAt: new Date(started).toISOString(), finishedAt: new Date(now()).toISOString(),
    wallMs: Math.max(0, now() - started), productMs: productTimingsComplete ? measuredProductMs : null, measuredProductMs, productTimingsComplete,
    actionAttempts: actions.length, firstAttemptSuccessRate: actions.length ? actions.filter(sample => sample.firstAttemptPassed).length / actions.length : null,
    helperAutoRecoveryReads: sum("helperAutoRecoveryReads"), otherAutoRecoveryReads: sum("otherAutoRecoveryReads"), independentResumeAttempts: sum("independentResumeAttempts"),
    responseRecoveries: actions.filter(sample => sample.responseRecovered).length, confirmedInputs: sum("confirmedInputs"), uncertainInputs: sum("uncertainInputs"),
    notSentInputs: sum("notSentInputs"), inputCountKnown: actions.every(sample => sample.inputCountKnown), scriptHumanConfirmations: 0, externalHumanInterventions: null,
    humanInterventionRequired: Boolean(stopCode), functionalPassed, evidence, completeSuccess: functionalPassed && productTimingsComplete && evidence.complete === true,
    stopCode, productReportPath: reportPath, roundEvidence };
  await writeFile(join(options.outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const value = (item: number | null) => item === null ? "未知" : String(item);
  const markdown = ["# UI 多轮回测", "", `- 计划：${plan.id}`, `- 完成轮数：${completedRounds}/${plan.rounds}`,
    `- 功能验证：${functionalPassed ? "通过" : "停止"}`, `- 完整成功（含证据和计时）：${summary.completeSuccess ? "是" : "否"}`,
    `- 证据完整：${evidence.complete === null ? "未知" : evidence.complete ? "是" : "否"}`, `- 停止编码：${stopCode ?? "无"}`,
    `- 墙钟耗时：${summary.wallMs} ms`, `- 产品耗时：${value(summary.productMs)} ms（已测 ${measuredProductMs} ms）`,
    `- 首次成功率：${summary.firstAttemptSuccessRate === null ? "未知" : (summary.firstAttemptSuccessRate * 100).toFixed(1) + "%"}（${actions.length} 个输入步骤；不含自动重读、独立恢复和丢响应查询）`,
    `- Helper 自动重读：${summary.helperAutoRecoveryReads}`, `- 其他自动重读：${summary.otherAutoRecoveryReads}`,
    `- 独立只读恢复：${summary.independentResumeAttempts}`,
    `- 已确认输入：${summary.confirmedInputs}；不确定输入：${summary.uncertainInputs}；计数完整：${summary.inputCountKnown}`,
    `- 脚本内人工确认次数：0；外部人工介入次数：未知；需要人工处理：${summary.humanInterventionRequired}`, "",
    "| 轮次 | 步骤 | 墙钟 ms | 产品 ms | 功能通过 | 已确认输入 | 不确定输入 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...samples.map(sample => `| ${sample.round} | ${sample.step} | ${sample.wallMs} | ${value(sample.productMs)} | ${sample.functionalPassed} | ${sample.confirmedInputs} | ${sample.uncertainInputs} |`), "",
    "产品原报告位于 summary.json 的 productReportPath，私有 evidence 目录按步骤归档现有报告与附件。",
    "samples.jsonl 只保存编码、数值、参数摘要和归档路径；完整参数和页面正文未复制到统计文件。",
    "重新运行会生成新请求，请先确认停点；本入口不支持恢复进程后继续发送操作。", ""].join("\n");
  await writeFile(join(options.outputDirectory, "report.md"), markdown, { flag: "wx", mode: 0o600 });
  return summary;
}

async function main() {
  const { values } = parseArgs({ options: { plan: { type: "string" }, session: { type: "string" }, out: { type: "string" },
    cli: { type: "string" }, "snapshot-file": { type: "string" }, help: { type: "boolean", short: "h" } }, allowPositionals: false });
  if (values.help) {
    console.log("用法：bun scripts/automation-ui-regression.ts --plan PLAN.json --session UUID --out NEW_DIRECTORY [--cli CLI.cjs] [--snapshot-file PATH]\n先手动开启调试并准备起点。计划最多10轮、8步/轮、25分钟；不授权、不启动App、不换后端。中断后请用日志中的同UUID只读查询，不重新发送。\n离线测试：bun test tests/automation-ui-regression.test.ts（只有假CLI，无手机输入）。");
    return;
  }
  if (!values.plan || !values.session || !values.out) stopped("missing_required_options");
  const planFile = await open(resolve(values.plan), "r");
  let plan: unknown;
  try {
    const stat = await planFile.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) stopped("plan_file_invalid");
    const bytes = await planFile.readFile();
    if (bytes.length !== stat.size || bytes.length > 64 * 1024) stopped("plan_file_changed");
    plan = JSON.parse(bytes.toString("utf8"));
  } finally { await planFile.close(); }
  const controller = new AbortController(), abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    const result = await runUiRegression({ plan, sessionId: values.session, outputDirectory: resolve(values.out), signal: controller.signal,
      execute: createCliExecute(resolve(values.cli ?? join(dirname(fileURLToPath(import.meta.url)), "../dist-electron/cli.cjs")), values["snapshot-file"] ? resolve(values["snapshot-file"]) : undefined) });
    console.log(JSON.stringify({ output: resolve(values.out), functionalPassed: result.functionalPassed, completeSuccess: result.completeSuccess, stopCode: result.stopCode }));
    if (!result.completeSuccess) process.exitCode = controller.signal.aborted ? 130 : 2;
  } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error(JSON.stringify({ isError: true, code: "regression_setup_failed", message: "回测入口未完成；请核对计划、会话和新输出目录。原始错误与页面数据不会写入控制台。" }));
  process.exitCode = 1;
});
