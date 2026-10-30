import { z } from "zod";
import type { DebugReportStep, DebugSessionReport, DebugSnapshotEvidence } from "./debug-report";
import type { DebugTaskAssessment, DebugTaskCheckResult, DebugTaskRecord } from "./debug-task";
import type { UiSnapshot } from "./types";

const text = z.string().max(16000);
const id = z.string().min(1).max(2048);
const status = z.enum(["passed", "failed", "timedout", "interrupted", "skipped", "flaky", "blocked", "running", "pending"]);
const source = z.object({ file: text, line: z.number().int().positive().optional(), column: z.number().int().nonnegative().optional() }).nullable();
const error = z.object({ category: text.optional(), code: text.optional(), message: text.optional(), phase: text.optional(),
  source: source.optional(), details: z.unknown().optional() }).nullable();
const artifact = z.object({ id, kind: z.enum(["screenshot", "trace", "video", "download", "log"]), stepId: id.nullable(),
  failureEvidence: z.boolean(), availability: text, href: text.nullable(), sha256: text.nullable(), stepReferenceMissing: z.boolean().optional() });
export const legacyTestReportIndexSchema = z.object({
  schemaVersion: z.literal("inspector-e2e-index-1"), generatedAt: text,
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  run: z.object({ id, status, exitCode: z.number().int(), startedAt: text, finishedAt: text,
    runner: z.object({ name: text, version: text }), modelTokens: z.number().nonnegative().nullable(), errors: z.array(error).max(100) }),
  cases: z.array(z.object({ id, title: text, targetId: id, status, selected: z.boolean(), source,
    attempts: z.array(z.object({ id, index: z.number().int().nonnegative(), status,
      durationMs: z.number().nonnegative(), cleanup: z.enum(["complete", "failed", "forced", "unknown"]), error,
      secondaryErrors: z.array(error).max(100),
      failure: z.object({ screenshot: id.optional(), screen: id.optional(), candidates: z.array(text).max(100).optional() }).nullable(),
      steps: z.array(z.object({ id, api: text, label: text, status, durationMs: z.number().nonnegative(), source, error })).max(2000),
      artifacts: z.array(artifact).max(100),
    })).max(20),
  })).max(200),
});

const recordingStatus = z.enum(["recorded", "recording"]);
const legacyCase = legacyTestReportIndexSchema.shape.cases.element;
const legacyAttempt = legacyCase.shape.attempts.element;
const debugAttempt = legacyAttempt.extend({ status: recordingStatus,
  steps: z.array(legacyAttempt.shape.steps.element.extend({ status: z.enum(["passed", "failed", "running", "completed"]) })).max(100) });
export const debugTestReportIndexSchema = legacyTestReportIndexSchema.extend({
  schemaVersion: z.literal("inspector-debug-index-1"),
  run: legacyTestReportIndexSchema.shape.run.extend({ status: recordingStatus, exitCode: z.null() }),
  cases: z.array(legacyCase.extend({ status: recordingStatus, attempts: z.array(debugAttempt).max(1) })).max(1),
});
export const testReportIndexSchema = z.union([legacyTestReportIndexSchema, debugTestReportIndexSchema]);

export type TestReportIndex = z.infer<typeof testReportIndexSchema>;
export type TestReportAttempt = TestReportIndex["cases"][number]["attempts"][number];
export type TestReportStep = TestReportAttempt["steps"][number];
export type LoadedTestReport = {
  index: TestReportIndex;
  images: Array<{ attemptId: string; artifactId: string; dataUrl: string | null; error: string | null }>;
  debug?: {
    session: DebugSessionReport["session"];
    steps: DebugReportStep[];
    snapshots: Array<{ evidence: DebugSnapshotEvidence; snapshot: UiSnapshot | null; treeError: string | null; screenshotArtifactId: string | null }>;
    task?: DebugTaskRecord | null;
    taskAssessment?: {
      checks: Array<{ recorded: DebugTaskCheckResult; effective: DebugTaskAssessment }>;
      final: DebugTaskAssessment | null;
    };
  };
};
export type ImportTestReportResult = { canceled: boolean; report: LoadedTestReport | null; error: string | null };

export function testReportStatusLabel(value: string) {
  const labels: Record<string, string> = { passed: "通过", failed: "失败", timedout: "超时", interrupted: "中断",
    skipped: "跳过", flaky: "重试后通过", blocked: "阻塞", running: "执行中", pending: "未执行",
    recorded: "已记录", recording: "记录中", completed: "操作完成" };
  return labels[value] ?? "未知";
}

export function failedReportStep(step: TestReportStep) {
  return Boolean(step.error || ["failed", "timedout", "interrupted", "blocked"].includes(step.status));
}

export function firstReportStep(attempt: TestReportAttempt) {
  return attempt.steps.find(failedReportStep)?.id
    ?? attempt.steps[0]?.id ?? null;
}

export function failedReportAttempt(attempt: TestReportAttempt) {
  return Boolean(attempt.error || attempt.secondaryErrors.length || ["failed", "timedout", "interrupted", "blocked"].includes(attempt.status)
    || ["failed", "forced"].includes(attempt.cleanup) || attempt.steps.some(failedReportStep));
}
