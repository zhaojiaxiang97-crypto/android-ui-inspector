import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import { z } from "zod";
import { debugToolSchemas } from "../../shared/debug-protocol";
import { DEBUG_LOG_LIMITS, DEBUG_REPORT_VERSION, LEGACY_DEBUG_REPORT_VERSION, DEBUG_SNAPSHOT_VERSION, type DebugSessionReport, type DebugSnapshotEvidence } from "../../shared/debug-report";
import { parseAndroidLogLines, sanitizeDebugLogText } from "../automation/debug-logs";
import { debugTaskCheckResult, debugTaskRecord, type DebugTaskAssessment, type DebugTaskCondition, type DebugTaskEvidence } from "../../shared/debug-task";
import { evaluateDebugTaskConditions } from "../../shared/debug-task-checker";
import { isUiSnapshot } from "../../shared/snapshot-validation";
import { debugTestReportIndexSchema, type LoadedTestReport } from "../../shared/test-report";
import type { UiSnapshot } from "../../shared/types";
import { debugTimingsSchema } from "../../shared/debug-timing";

const MiB = 1024 * 1024;
const REPORT_LIMIT = 32 * MiB, TREE_LIMIT = 2 * MiB, IMAGE_LIMIT = 10 * MiB, LOAD_LIMIT = 16 * MiB;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const text = z.string().max(16000), id = z.string().uuid(), date = z.string().datetime({ offset: true });
const errorSchema = z.object({ category: text.min(1), code: text.min(1), phase: z.enum(["capture", "locate", "input", "verify", "recording"]), message: text }).strict();
const frame = z.object({ width: z.number().int().positive(), height: z.number().int().positive(), rotation: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) }).strict();
const inputAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tap"), x: z.number(), y: z.number() }).strict(),
  z.object({ kind: z.literal("swipe"), fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number(), durationMs: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("back") }).strict(),
]);
const visualConfirmation = z.object({
  referenceSnapshotId: id, currentSnapshotId: id,
  description: z.string().min(1).max(512).refine(value => value.trim().length > 0, "视觉确认描述不能为空"),
  region: z.object({ left: z.number().int().nonnegative(), top: z.number().int().nonnegative(),
    width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  overlapNodeIds: z.array(z.string().min(1).max(2048).refine(value => value.trim().length > 0)).max(100)
    .refine(values => new Set(values).size === values.length && values.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0) <= 16 * 1024,
      "重叠控件编号重复或超过记录上限"),
}).strict();
const screenRect = z.object({ left: z.number().int().nonnegative(), top: z.number().int().nonnegative(),
  right: z.number().int().positive(), bottom: z.number().int().positive() }).strict()
  .refine(rect => rect.right > rect.left && rect.bottom > rect.top);
const scrollRegion = z.object({ viewport: screenRect, confirmationBounds: screenRect,
  excludedNavigationBounds: z.array(screenRect).max(100) }).strict();
const inputEvidence = z.object({
  classification: z.enum(["accepted", "permission-denied", "device-unavailable", "invalid-command", "command-failed", "unexpected-output", "cancelled", "timeout", "output-limit", "spawn-failed", "unconfirmed-exit"]),
  spawned: z.boolean(), closed: z.boolean(), exitCode: z.number().int().nullable(), signal: text.nullable(), errorCode: text.optional(),
  durationMs: z.number().nonnegative(), stdout: z.string().max(65536), stderr: z.string().max(65536), stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(),
}).strict();
const reference = z.object({ snapshotId: id.nullable(), freshness: z.enum(["current", "previous", "missing"]), reason: text.nullable() }).strict();
const file = (extension: string) => z.object({ path: z.string().regex(new RegExp(`^artifacts/[a-f0-9]{64}\\.${extension}$`)),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(REPORT_LIMIT) }).strict()
  .refine(value => value.path === `artifacts/${value.sha256}.${extension}`, "附件路径与摘要不符");
const logEvidence = z.object({ source: z.enum(["session", "android"]), sessionId: id, stepId: z.number().int().positive(), packageName: text.min(1),
  startedAt: date, finishedAt: date, status: z.enum(["available", "empty", "unavailable", "cancelled"]),
  attribution: z.enum(["confirmed", "missing"]), reason: text.nullable(), truncated: z.boolean(),
  lineCount: z.number().int().min(0).max(DEBUG_LOG_LIMITS.maxLines), file: file("txt").nullable(),
  androidScope: z.object({ pid: z.number().int().positive().max(0x7fffffff), processStartTicks: z.string().regex(/^\d{1,24}$/),
    deviceStartedAt: z.number().positive(), deviceFinishedAt: z.number().positive() }).strict().nullable() }).strict();
const progress = z.object({ sessionId: id, taskId: id.nullable(), stepId: z.number().int().positive().nullable(), action: text.nullable(),
  phase: z.enum(["idle", "capture", "execute", "wait", "recording", "completed", "failed", "cancelled", "expired"]),
  startedAt: date, updatedAt: date, stepStartedAt: date.nullable(), stepFinishedAt: date.nullable(), finishedAt: date.nullable(), reason: text.nullable() }).strict();
const snapshotEvidence = z.object({ snapshotId: id, capturedAt: date, source: z.enum(["uiautomator", "accessibility-helper", "debug-view", "debug-qml", "debug-hybrid", "unknown"]),
  tree: file("json").nullable(), screenshot: file("png").nullable(), warnings: z.array(text).max(100) }).strict();
const stepSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), time: date,
  action: z.enum(["capture_ui", "tap_node", "scroll_node", "press_back", "wait_for_ui"]), input: z.record(z.string(), z.unknown()),
  status: z.enum(["running", "done", "failed"]), message: text, beforeId: id.optional(), afterId: id.optional(),
  dispatchState: z.enum(["not_sent", "unknown", "sent"]).optional(), inputEvidence: inputEvidence.optional(),
  resolvedInput: z.object({ action: inputAction, frame, targetNodeId: text.min(1).optional(), anchorNodeId: text.min(1).optional(),
    visualConfirmation: visualConfirmation.optional(), scrollRegion: scrollRegion.optional() }).strict().optional(),
  error: errorSchema.optional(), recordingErrors: z.array(errorSchema).max(100).optional(), verified: z.boolean().nullable().optional(),
  timings: debugTimingsSchema.optional(),
}).strict();
const reportBaseSchema = z.object({
  schemaVersion: z.literal(LEGACY_DEBUG_REPORT_VERSION),
  session: z.object({ id, serial: z.string().min(1).max(512), packageName: z.string().min(1).max(512), startedAt: date, updatedAt: date,
    active: z.boolean(), stopReason: text.nullable(), totalSteps: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    droppedSteps: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  limits: z.object({ maxSteps: z.number().int().min(1).max(100), maxSnapshots: z.number().int().min(1).max(200), maxImages: z.number().int().min(1).max(100),
    maxBytes: z.number().int().min(1).max(REPORT_LIMIT), maxTreeBytes: z.number().int().min(1).max(TREE_LIMIT), maxImageBytes: z.number().int().min(1).max(IMAGE_LIMIT) }).strict(),
  storage: z.object({ bytes: z.number().int().nonnegative().max(REPORT_LIMIT) }).strict(),
  steps: z.array(z.object({ step: stepSchema, finishedAt: date, durationMs: z.number().nonnegative(), verified: z.boolean().nullable(), before: reference, after: reference }).strict()).max(100),
  snapshots: z.array(snapshotEvidence).max(200),
}).strict();
const taskStepSchema = stepSchema.extend({
  action: z.enum(["capture_ui", "tap_node", "scroll_node", "press_back", "wait_for_ui", "define_debug_task", "check_debug_task", "perform_ui_step", "resume_ui_step"]),
  taskCheck: debugTaskCheckResult.optional(),
}).strict();
const reportSchema = z.discriminatedUnion("schemaVersion", [reportBaseSchema, reportBaseSchema.extend({
  schemaVersion: z.literal(DEBUG_REPORT_VERSION), task: debugTaskRecord.nullable().optional(),
  session: reportBaseSchema.shape.session.extend({ progress: progress.optional(), androidLogsEnabled: z.boolean().optional() }).strict(),
  steps: z.array(reportBaseSchema.shape.steps.element.extend({ step: taskStepSchema, logs: z.array(logEvidence).max(DEBUG_LOG_LIMITS.maxSources).optional() }).strict()).max(100),
}).strict()]);

class DebugReportIdentityError extends Error {}
function originalUiStep(steps: DebugSessionReport["steps"], step: DebugSessionReport["steps"][number]["step"]) {
  return steps.find(entry => entry.step.id < step.id && entry.step.action === "perform_ui_step" && entry.step.input.requestId === step.input.requestId)?.step;
}
function verifyManifest(document: z.infer<typeof reportSchema>, bytes: number) {
  const { session, limits, steps, snapshots } = document;
  if (steps.length > limits.maxSteps || snapshots.length > limits.maxSnapshots || document.storage.bytes > limits.maxBytes
    || bytes > limits.maxBytes || session.totalSteps !== session.droppedSteps + steps.length || Date.parse(session.updatedAt) < Date.parse(session.startedAt))
    throw new Error("调试报告计数、时间或记录上限不一致。");
  const snapshotIds = new Map<string, DebugSnapshotEvidence>(), stepIds = new Set<number>(), files = new Map<string, number>();
  for (const evidence of snapshots) {
    if (snapshotIds.has(evidence.snapshotId)) throw new Error("调试报告快照编号重复。");
    snapshotIds.set(evidence.snapshotId, evidence);
    for (const artifact of [evidence.tree, evidence.screenshot]) if (artifact) {
      const previous = files.get(artifact.path);
      if (previous !== undefined && previous !== artifact.size) throw new Error("重复附件引用的大小不一致。");
      files.set(artifact.path, artifact.size);
    }
  }
  const allLogs = document.steps.flatMap(entry => "logs" in entry ? entry.logs ?? [] : []);
  for (const log of allLogs) if (log.file) {
    const previous = files.get(log.file.path);
    if (previous !== undefined && previous !== log.file.size) throw new Error("日志附件引用的大小不一致。");
    files.set(log.file.path, log.file.size);
  }
  if ([...files.keys()].filter(path => path.endsWith(".png")).length > limits.maxImages
    || bytes + [...files.values()].reduce((sum, size) => sum + size, 0) > limits.maxBytes)
    throw new Error("调试报告附件数量或总大小超过记录上限。");
  let previousStep = 0;
  for (const entry of steps) {
    const step = entry.step;
    if (stepIds.has(step.id) || step.id <= previousStep || step.id > session.totalSteps) throw new Error("调试报告步骤编号重复或顺序不一致。");
    stepIds.add(step.id); previousStep = step.id;
    const inputSchema = (debugToolSchemas as Record<string, z.ZodType>)[step.action];
    if (!inputSchema?.safeParse(step.input).success || step.input.sessionId !== session.id)
      throw new Error("调试报告步骤的输入或会话身份不一致。");
    const compound = step.action === "perform_ui_step", resume = step.action === "resume_ui_step";
    const original = resume ? originalUiStep(steps, step) : undefined;
    if (step.verified !== undefined && step.verified !== entry.verified || entry.verified === true && (step.status !== "done"
      || !["wait_for_ui", "check_debug_task", "perform_ui_step", "resume_ui_step"].includes(step.action)
      || compound && !step.input.expect || resume && original && !original.input.expect
      || (compound || resume) && entry.after.freshness !== "current"))
      throw new Error("页面断言状态与调试步骤不一致。");
    const actionKind = (step.input.action as { kind?: string } | undefined)?.kind;
    const inputKind = compound ? { tap: "tap", scroll: "swipe", back: "back" }[actionKind as "tap" | "scroll" | "back"]
      : { tap_node: "tap", scroll_node: "swipe", press_back: "back" }[step.action as "tap_node" | "scroll_node" | "press_back"];
    if (step.resolvedInput && step.resolvedInput.action.kind !== inputKind
      || !inputKind && !resume && (step.dispatchState || step.inputEvidence || step.resolvedInput)
      || resume && (step.inputEvidence || step.resolvedInput || original?.dispatchState && step.dispatchState && step.dispatchState !== original.dispatchState))
      throw new Error("实际输入类型与调试步骤不一致。");
    const visual = step.resolvedInput?.visualConfirmation;
    const scroll = step.resolvedInput?.scrollRegion;
    if (scroll) {
      const { action, frame: { width, height } } = step.resolvedInput!;
      const { viewport, confirmationBounds: area, excludedNavigationBounds } = scroll;
      if (action.kind !== "swipe" || !step.resolvedInput!.targetNodeId
        || [viewport, area, ...excludedNavigationBounds].some(rect => rect.right > width || rect.bottom > height)
        || area.left < viewport.left || area.top < viewport.top || area.right > viewport.right || area.bottom > viewport.bottom
        || [action.fromX, action.toX].some(x => x < area.left || x >= area.right)
        || [action.fromY, action.toY].some(y => y < area.top || y >= area.bottom)
        || excludedNavigationBounds.some(rect => rect.left < viewport.right && rect.right > viewport.left
          && rect.top < viewport.bottom && rect.bottom > viewport.top)
        || visual && (visual.region.left !== area.left || visual.region.top !== area.top
          || visual.region.width !== area.right - area.left || visual.region.height !== area.bottom - area.top))
        throw new Error("滚动范围与实际手势或截图确认区域不一致。");
    }
    if (visual) {
      const { region } = visual, { width, height } = step.resolvedInput!.frame;
      const request = step.input.visualConfirmation as { description?: unknown; snapshotId?: unknown } | undefined;
      if (!["tap", "swipe"].includes(inputKind) || visual.referenceSnapshotId !== (compound ? request?.snapshotId : step.input.snapshotId)
        || visual.currentSnapshotId !== step.beforeId
        || visual.description !== request?.description || !step.resolvedInput!.targetNodeId
        || region.left + region.width > width || region.top + region.height > height
        || region.width * region.height > 16 * MiB)
        throw new Error("视觉确认的输入、目标或截图区域不一致。");
    }
    if (Date.parse(entry.finishedAt) < Date.parse(step.time)) throw new Error("调试报告步骤时间不一致。");
    const logs = "logs" in entry ? entry.logs ?? [] : [];
    if (new Set(logs.map(log => log.source)).size !== logs.length) throw new Error("步骤的日志来源重复。");
    for (const log of logs) {
      if (log.sessionId !== session.id || log.stepId !== step.id || log.packageName !== session.packageName
        || log.startedAt !== step.time || Date.parse(log.finishedAt) < Date.parse(log.startedAt) || Date.parse(log.finishedAt) > Date.parse(entry.finishedAt))
        throw new Error("日志的会话、步骤、App或时间范围不一致。");
      if (log.status === "available" ? !log.file || !log.lineCount || log.attribution !== "confirmed" : log.file !== null || log.lineCount !== 0)
        throw new Error("日志内容与可用状态不一致。");
      if (log.file && log.file.size > DEBUG_LOG_LIMITS.maxBytes) throw new Error("日志附件超过128KiB上限。");
      if (log.source === "session" && (log.androidScope || log.attribution !== "confirmed")) throw new Error("本程序日志混入Android范围声明。");
      if (log.source === "android") {
        if (log.attribution === "confirmed") {
          const scope = log.androidScope;
          if (!("androidLogsEnabled" in session && session.androidLogsEnabled) || !scope || scope.deviceFinishedAt < scope.deviceStartedAt
            || Math.abs(scope.deviceStartedAt - Date.parse(log.startedAt)) > 7000
            || scope.deviceFinishedAt > Date.parse(log.finishedAt) + 2000 || scope.deviceStartedAt < Date.parse(session.startedAt) - 2000)
            throw new Error("Android日志没有明确授权或可确认的时间范围。");
        } else if (log.androidScope || log.file) throw new Error("缺证据的Android日志仍带有已确认内容。");
      }
    }
    for (const [value, recordedId] of [[entry.before, step.beforeId], [entry.after, step.afterId]] as const) {
      if (value.freshness === "missing") {
        if (value.snapshotId !== null || recordedId !== undefined || !value.reason) throw new Error("缺失快照仍带有引用编号。");
      } else if (!value.snapshotId || !snapshotIds.has(value.snapshotId) || recordedId !== value.snapshotId)
        throw new Error("调试报告引用未知快照或步骤引用不一致。");
      else {
        const capturedAt = Date.parse(snapshotIds.get(value.snapshotId)!.capturedAt);
        if (capturedAt > Date.parse(entry.finishedAt) || value.freshness === "current" && capturedAt < Date.parse(step.time)
          || value.freshness === "previous" && !value.reason)
          throw new Error("快照新旧标记与步骤时间不一致，不能把旧观察作为新结果。");
      }
    }
  }
  verifyTaskManifest(document, snapshotIds);
  if ("progress" in session && session.progress) {
    const value = session.progress;
    const latest = document.steps.at(-1);
    if (value.sessionId !== session.id || value.taskId !== ("task" in document ? document.task?.id ?? null : null)
      || value.startedAt !== session.startedAt || value.stepId !== (session.totalSteps || null)
      || latest && (value.action !== latest.step.action || value.stepStartedAt !== latest.step.time)
      || value.stepId === null && (value.action !== null || value.stepStartedAt !== null || value.stepFinishedAt !== null)
      || Date.parse(value.updatedAt) < Date.parse(value.startedAt)
      || Date.parse(value.updatedAt) > Date.parse(session.updatedAt) || value.finishedAt && Date.parse(value.finishedAt) < Date.parse(value.startedAt)
      || value.finishedAt && Date.parse(value.finishedAt) > Date.parse(value.updatedAt)
      || value.stepFinishedAt && (value.stepStartedAt === null || Date.parse(value.stepFinishedAt) < Date.parse(value.stepStartedAt)
        || Date.parse(value.stepFinishedAt) > Date.parse(value.updatedAt))
      || session.active && ["cancelled", "expired"].includes(value.phase)) throw new Error("进度不属于当前报告会话或任务。");
  }
}

function verifyTaskManifest(document: z.infer<typeof reportSchema>, snapshots: Map<string, DebugSnapshotEvidence>) {
  const task = "task" in document ? document.task : null;
  const newSteps = document.steps.filter(entry => entry.step.action === "define_debug_task" || entry.step.action === "check_debug_task");
  const rejectedRequest = (entry: typeof document.steps[number]) => entry.step.status === "failed" && Boolean(entry.step.error)
    && entry.verified === false && !("taskCheck" in entry.step && entry.step.taskCheck)
    && entry.before.freshness === "missing" && entry.after.freshness === "missing";
  if (!task) {
    if (newSteps.some(entry => !rejectedRequest(entry)) || document.steps.some(entry => "taskCheck" in entry.step)) throw new Error("任务步骤缺少所属任务定义。");
    return;
  }
  const { session } = document;
  const time = Date.parse;
  const byStep = new Map(document.steps.map(entry => [entry.step.id, entry]));
  if (task.definedStepId > session.totalSteps || time(task.definedAt) < time(session.startedAt) || time(task.definedAt) > time(session.updatedAt))
    throw new Error("任务定义的步骤或时间不属于报告会话。");
  const defined = byStep.get(task.definedStepId);
  if (defined) {
    const input = debugToolSchemas.define_debug_task.safeParse(defined.step.input);
    if (defined.step.action !== "define_debug_task" || defined.step.status !== "done" || defined.verified !== null
      || task.definedAt !== defined.step.time || !input.success || !isDeepStrictEqual(input.data.definition, task.definition))
      throw new Error("任务定义与原始定义步骤不一致。");
  } else if (task.definedStepId > session.droppedSteps) throw new Error("任务定义步骤丢失且不在滚动省略范围。");
  for (const entry of document.steps) {
    if (entry.step.action === "define_debug_task" && entry.step.id !== task.definedStepId && !rejectedRequest(entry)) throw new Error("一份会话不能替换任务定义。");
    if (["tap_node", "scroll_node", "press_back", "perform_ui_step"].includes(entry.step.action) && entry.step.id < task.definedStepId)
      throw new Error("任务条件必须在任何输入请求之前固定。");
    if ("taskCheck" in entry.step && entry.step.taskCheck && entry.step.action !== "check_debug_task") throw new Error("其他操作不能夹带任务验收结果。");
  }
  const conditions = (checkpointId: string | null) => checkpointId === null ? task.definition.finalConditions
    : task.definition.checkpoints.find(checkpoint => checkpoint.id === checkpointId)?.conditions;
  const checks = new Map<number, typeof task.checks[number]>();
  for (const check of task.checks) {
    if (checks.has(check.stepId)) throw new Error("任务验收步骤编号重复。");
    checks.set(check.stepId, check);
    const entry = byStep.get(check.stepId);
    if (entry && (!("taskCheck" in entry.step) || !isDeepStrictEqual(entry.step.taskCheck, check)))
      throw new Error("任务最新验收与对应步骤记录不一致。");
    if (!entry && check.stepId > session.droppedSteps) throw new Error("任务验收步骤丢失且不在滚动省略范围。");
  }
  let previousPhase = -1, previousStep = task.definedStepId;
  for (const check of task.checks) {
    const phase = check.checkpointId === null ? task.definition.checkpoints.length
      : task.definition.checkpoints.findIndex(checkpoint => checkpoint.id === check.checkpointId);
    if (phase < 0 || phase <= previousPhase || check.stepId <= previousStep) throw new Error("任务最新验收阶段重复、未知或顺序不一致。");
    previousPhase = phase; previousStep = check.stepId;
  }
  for (const entry of document.steps) if (entry.step.action === "check_debug_task") {
    if (!("taskCheck" in entry.step) || !entry.step.taskCheck) {
      if (rejectedRequest(entry)) continue;
      throw new Error("任务验收步骤缺少固定条件检查记录。");
    }
    const check = entry.step.taskCheck;
    if (check.stepId !== entry.step.id || entry.step.input.taskId !== task.id || (entry.step.input.checkpointId ?? null) !== check.checkpointId
      || time(check.checkedAt) < time(entry.step.time) || time(check.checkedAt) > time(entry.finishedAt)
      || time(entry.step.time) < time(task.definedAt) || entry.verified !== (check.status === "passed")
      || check.status === "passed" && entry.step.error) throw new Error("任务验收身份、时间或步骤状态不一致。");
    for (const [observation, reference] of [[check.observations.first, entry.before], [check.observations.second, entry.after]] as const) {
      if (observation && (reference.snapshotId !== observation.snapshotId || reference.freshness !== "current"))
        throw new Error("任务验收的两次观察与步骤前后引用不一致。");
      if (!observation && reference.freshness !== "missing") throw new Error("任务验收缺失观察却带有其他页面引用。");
    }
    const latest = checks.get(check.stepId);
    if (latest && !isDeepStrictEqual(latest, check)) throw new Error("任务验收存在同一步骤的冲突结果。");
    checks.set(check.stepId, check);
  }
  const observationOwners = new Map<string, number>();
  for (const check of checks.values()) {
    const expected = conditions(check.checkpointId);
    if (!expected || check.taskId !== task.id || check.stepId <= task.definedStepId || check.stepId > session.totalSteps
      || time(check.checkedAt) < time(task.definedAt) || time(check.checkedAt) > time(session.updatedAt)
      || !isDeepStrictEqual(check.conditions.map(condition => condition.conditionId), expected.map(condition => condition.id)))
      throw new Error("任务验收的定义、条件或步骤引用不一致。");
    const { first, second } = check.observations;
    if (second && !first && check.status !== "insufficient_evidence"
      || first && second && (first.snapshotId === second.snapshotId || time(first.capturedAt) > time(second.capturedAt)))
      throw new Error("任务验收不能复用同一观察或倒置两次采集。");
    for (const observation of [first, second]) if (observation) {
      if (observationOwners.has(observation.snapshotId) && observationOwners.get(observation.snapshotId) !== check.stepId)
        throw new Error("不同任务检查不能复用同一次观察。");
      observationOwners.set(observation.snapshotId, check.stepId);
      const evidence = snapshots.get(observation.snapshotId);
      if (!evidence || evidence.capturedAt !== observation.capturedAt || time(observation.capturedAt) < time(task.definedAt)
        || time(observation.capturedAt) > time(check.checkedAt)) throw new Error("任务验收引用未知、替换或过晚的观察。");
    }
    if (check.status === "passed" && (!first || !second || check.conditions.some(condition => condition.status !== "passed"))
      || check.status === "failed" && (!first || !second || check.conditions.some(condition => condition.status === "insufficient_evidence")
        || !check.conditions.some(condition => condition.status === "failed"))) throw new Error("任务验收整体结论与条件记录不一致。");
  }
}

async function readArtifact(directory: string, artifact: NonNullable<DebugSnapshotEvidence["tree"]>, limit: number) {
  if (artifact.size > limit) throw new Error("证据文件超过单文件或总加载上限。");
  const root = join(directory, "artifacts"), target = join(directory, artifact.path);
  if (await realpath(root) !== root || await realpath(target) !== target) throw new Error("证据文件不能通过链接越过或替换报告目录。");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== artifact.size || info.size > limit) throw new Error("证据文件大小已变化或超过加载上限。");
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const next = await handle.read(bytes, count, bytes.length - count, count);
      if (!next.bytesRead) break;
      count += next.bytesRead;
    }
    if (count !== info.size || sha(bytes.subarray(0, count)) !== artifact.sha256) throw new Error("证据文件读取期间变化或摘要不一致。");
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}

function safeSnapshot(value: unknown): value is UiSnapshot {
  if (!isUiSnapshot(value) || value.screenshotDataUrl !== null || value.nodeCount < 0 || !Number.isSafeInteger(value.nodeCount)) return false;
  const snapshotKeys = new Set(["serial", "root", "nodeCount", "xmlSize", "rawXml", "screenshotDataUrl", "error", "warning", "inspectionSource",
    "hierarchyDumpMode", "captureGeometry", "captureTimings", "captureDurationMs", "captureRequestDiagnostics", "captureReadiness", "captureMode"]);
  const nodeKeys = new Set(["id", "index", "className", "package", "text", "resourceId", "contentDesc", "bounds", "clickable", "enabled", "focusable", "focused",
    "scrollable", "selected", "visibleToUser", "attributes", "debugMetadata", "children", "layerImageSize", "layerCapturePlacement", "layerImageEmpty", "layerImageStatus"]);
  if (Object.keys(value).some(key => !snapshotKeys.has(key))) return false;
  const nodeIds = new Set<string>();
  const nodes = value.root ? [value.root] : [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (nodeIds.has(node.id) || Object.keys(node).some(key => !nodeKeys.has(key))) return false;
    nodeIds.add(node.id); nodes.push(...node.children);
  }
  return nodes.length === value.nodeCount;
}
const treeSchema = z.object({ schemaVersion: z.literal(DEBUG_SNAPSHOT_VERSION), snapshotId: id, capturedAt: date,
  content: z.literal("tree-properties-without-layer-bitmaps"), snapshot: z.custom<UiSnapshot>(safeSnapshot, "树属性无效或夹带了图片数据") }).strict();
const evidenceError = (error: unknown) => (error instanceof Error && !error.message.includes("ENOENT") ? error.message : "证据文件缺失或不可读取。").slice(0, 16000);

function deriveTaskAssessment(document: DebugSessionReport, snapshots: NonNullable<LoadedTestReport["debug"]>["snapshots"]): NonNullable<NonNullable<LoadedTestReport["debug"]>["taskAssessment"]> | undefined {
  const task = document.task;
  if (!task) return undefined;
  const trees = new Map(snapshots.map(item => [item.evidence.snapshotId, item]));
  const checkRecords = new Map(task.checks.map(check => [check.stepId, check]));
  const steps = new Map(document.steps.map(entry => [entry.step.id, entry]));
  for (const entry of document.steps) if (entry.step.taskCheck) checkRecords.set(entry.step.id, entry.step.taskCheck);
  const checks: NonNullable<NonNullable<LoadedTestReport["debug"]>["taskAssessment"]>["checks"] = [];
  const effectiveByStep = new Map<number, DebugTaskAssessment>();
  const stages = new Map<string, typeof checks[number]>();
  const insufficient = (assessment: DebugTaskAssessment, reason: string): DebugTaskAssessment => ({ status: "insufficient_evidence", reason,
    conditions: assessment.conditions.map(condition => ({ ...condition, status: "insufficient_evidence", reason })) });
  const conditionsFor = (checkpointId: string | null): DebugTaskCondition[] => checkpointId === null ? task.definition.finalConditions
    : task.definition.checkpoints.find(checkpoint => checkpoint.id === checkpointId)!.conditions;
  const evidenceFor = (observation: typeof task.checks[number]["observations"]["first"]): DebugTaskEvidence | null => {
    if (!observation) return null;
    const loaded = trees.get(observation.snapshotId);
    return loaded?.snapshot && !loaded.treeError ? { observation, snapshot: loaded.snapshot } : null;
  };
  const assess = (check: typeof task.checks[number]): DebugTaskAssessment => {
    const assessment = evaluateDebugTaskConditions(conditionsFor(check.checkpointId), evidenceFor(check.observations.first),
      evidenceFor(check.observations.second), document.session.packageName);
    if (check.status === "insufficient_evidence" || steps.get(check.stepId)?.step.status === "failed" || steps.get(check.stepId)?.step.status === "running")
      return insufficient(assessment, "原检查未完成或证据不足；离线读取不能补成验收通过。");
    if (check.status === "failed" && assessment.status === "passed") return insufficient(assessment, "原检查与已保存树的复核结论不一致。");
    return assessment;
  };
  const prerequisite = (check: typeof task.checks[number], phase: number, proof: (id: string) => typeof checks[number] | undefined) => {
    for (const checkpoint of task.definition.checkpoints.slice(0, phase)) {
      const prior = proof(checkpoint.id);
      if (!prior || prior.effective.status !== "passed" || prior.recorded.stepId >= check.stepId
        || !check.observations.first || Date.parse(prior.recorded.checkedAt) > Date.parse(check.observations.first.capturedAt)) return false;
    }
    return true;
  };
  for (const check of [...checkRecords.values()].sort((a, b) => a.stepId - b.stepId)) {
    const phase = check.checkpointId === null ? task.definition.checkpoints.length
      : task.definition.checkpoints.findIndex(checkpoint => checkpoint.id === check.checkpointId);
    let effective = assess(check);
    if (!prerequisite(check, phase, key => stages.get(key))) effective = insufficient(effective, "前置阶段没有按顺序保留可复核的通过证据。");
    const item = { recorded: check, effective };
    checks.push(item); effectiveByStep.set(check.stepId, effective);
    if (check.checkpointId !== null) {
      for (const checkpoint of task.definition.checkpoints.slice(phase)) stages.delete(checkpoint.id);
      stages.set(check.checkpointId, item);
    }
  }
  const lastFinal = task.checks.find(check => check.checkpointId === null);
  let final = lastFinal ? effectiveByStep.get(lastFinal.stepId)! : null;
  if (lastFinal && !prerequisite(lastFinal, task.definition.checkpoints.length, key => {
    const recorded = task.checks.find(check => check.checkpointId === key);
    const effective = recorded && effectiveByStep.get(recorded.stepId);
    return recorded && effective ? { recorded, effective } : undefined;
  })) final = insufficient(final!, "最新最终验收缺少按顺序完成且仍可复核的阶段证据。");
  if (lastFinal && final) checks.find(item => item.recorded.stepId === lastFinal.stepId)!.effective = final;
  return { checks, final };
}

export async function loadDebugReport(directory: string, bytes: Buffer, value: unknown): Promise<LoadedTestReport> {
  const parsed = reportSchema.parse(value);
  verifyManifest(parsed, bytes.length);
  const document: DebugSessionReport = parsed;
  const snapshots: NonNullable<LoadedTestReport["debug"]>["snapshots"] = [];
  const images: LoadedTestReport["images"] = [];
  const imageFiles = new Map<string, NonNullable<DebugSnapshotEvidence["screenshot"]>>();
  const errors: Array<{ category: string; code: string; phase: string; message: string }> = [];
  for (const entry of document.steps) if (entry.step.action === "resume_ui_step" && entry.verified === true && !originalUiStep(document.steps, entry.step)) {
    // Rolling retention and selective export can omit the request defining the expectation.
    // Preserve the step, but its assertion cannot be confirmed from this report alone.
    entry.verified = entry.step.verified = null;
    errors.push({ category: "evidence", code: "original-ui-step-unavailable", phase: "report-import",
      message: `步骤 #${entry.step.id} 缺少原复合请求，无法复核预期条件；恢复结果保留为未验证。` });
  }
  let logBytes = 0;
  for (const entry of document.steps) for (const log of entry.logs ?? []) {
    if (!log.file) continue;
    try {
      const limit = Math.min(DEBUG_LOG_LIMITS.maxBytes, LOAD_LIMIT - logBytes);
      if (log.file.size <= limit) logBytes += log.file.size;
      const data = await readArtifact(directory, log.file, limit);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (content.split(/\r?\n/).filter(line => line.trim()).length !== log.lineCount) throw new Error("日志附件行数与记录不一致。");
      if (log.source === "android" && parseAndroidLogLines(content, log.androidScope!).text.split(/\r?\n/).filter(line => line.trim()).length !== log.lineCount)
        throw new Error("日志附件带有步骤时间范围以外的内容。");
      log.text = sanitizeDebugLogText(content); log.loadError = null;
    } catch (error) {
      log.loadError = evidenceError(error);
      errors.push({ category: "evidence", code: "log-unavailable", phase: "report-import", message: `步骤 #${entry.step.id} ${log.source}: ${log.loadError}`.slice(0, 16000) });
    }
  }
  let treeBytes = 0, imageBytes = 0, pixels = 0;
  for (const evidence of document.snapshots) {
    let snapshot: UiSnapshot | null = null, treeError: string | null = null;
    if (!evidence.tree) treeError = "此快照没有保存树与属性证据。";
    else try {
      const limit = Math.min(document.limits.maxTreeBytes, LOAD_LIMIT - treeBytes);
      if (evidence.tree.size <= limit) treeBytes += evidence.tree.size;
      const data = await readArtifact(directory, evidence.tree, limit);
      const tree = treeSchema.parse(JSON.parse(data.toString("utf8")));
      if (tree.snapshotId !== evidence.snapshotId || tree.capturedAt !== evidence.capturedAt || tree.snapshot.serial !== document.session.serial
        || (tree.snapshot.inspectionSource ?? "unknown") !== evidence.source)
        throw new DebugReportIdentityError("树证据的快照编号、时间、来源或会话身份不一致。");
      if (tree.snapshot.root?.package !== document.session.packageName)
        throw new DebugReportIdentityError("树证据不属于报告的目标App。");
      snapshot = tree.snapshot;
    } catch (error) {
      if (error instanceof DebugReportIdentityError) throw error;
      treeError = evidenceError(error);
    }
    if (treeError) errors.push({ category: "evidence", code: "tree-unavailable", phase: "report-import", message: `${evidence.snapshotId}: ${treeError}`.slice(0, 16000) });
    const screenshotArtifactId = evidence.screenshot?.sha256 ?? null;
    if (evidence.screenshot) imageFiles.set(evidence.screenshot.sha256, evidence.screenshot);
    snapshots.push({ evidence, snapshot, treeError, screenshotArtifactId });
  }
  for (const [artifactId, artifact] of imageFiles) {
    const image: LoadedTestReport["images"][number] = { attemptId: document.session.id, artifactId, dataUrl: null, error: null };
    try {
      const limit = Math.min(document.limits.maxImageBytes, LOAD_LIMIT - imageBytes);
      if (artifact.size <= limit) imageBytes += artifact.size;
      const data = await readArtifact(directory, artifact, limit);
      if (data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("证据文件不是有效PNG。");
      const decoder = sharp(data, { failOn: "warning", limitInputPixels: 16 * 1024 * 1024 }).timeout({ seconds: 2 });
      const metadata = await decoder.metadata();
      const count = (metadata.width ?? 0) * (metadata.height ?? 0);
      if (metadata.format !== "png" || !count || (metadata.pages ?? 1) !== 1 || pixels + count > 64 * 1024 * 1024)
        throw new Error("PNG格式、尺寸或总像素数量超过加载上限。");
      pixels += count;
      const decoded = await decoder.raw().toBuffer({ resolveWithObject: true });
      if (decoded.info.width !== metadata.width || decoded.info.height !== metadata.height) throw new Error("PNG完整解码后的尺寸不一致。");
      image.dataUrl = `data:image/png;base64,${data.toString("base64")}`;
    } catch (error) { image.error = evidenceError(error); }
    if (image.error) errors.push({ category: "evidence", code: "screenshot-unavailable", phase: "report-import", message: `${artifactId}: ${image.error}`.slice(0, 16000) });
    images.push(image);
  }
  const taskAssessment = deriveTaskAssessment(document, snapshots);
  const effectiveChecks = new Map(taskAssessment?.checks.map(item => [item.recorded.stepId, item.effective]) ?? []);
  const status = document.session.active ? "recording" : "recorded";
  const index = debugTestReportIndexSchema.parse({ schemaVersion: "inspector-debug-index-1", generatedAt: document.session.updatedAt, reportSha256: sha(bytes),
    run: { id: document.session.id, status, exitCode: null, startedAt: document.session.startedAt, finishedAt: document.session.updatedAt,
      runner: { name: "Android UI Inspector", version: document.schemaVersion }, modelTokens: null, errors: errors.slice(0, 100) },
    cases: [{ id: document.session.id, title: document.session.packageName, targetId: document.session.serial, status, selected: true, source: null,
      attempts: [{ id: document.session.id, index: 0, status, durationMs: document.steps.reduce((sum, entry) => sum + entry.durationMs, 0),
        cleanup: "unknown", error: null, secondaryErrors: document.steps.flatMap(entry => entry.step.recordingErrors ?? []).slice(0, 100), failure: null,
        steps: document.steps.map(entry => ({ id: String(entry.step.id), api: entry.step.action,
          label: `${entry.step.message}${entry.step.action === "check_debug_task" ? effectiveChecks.get(entry.step.id)?.status === "passed" ? "（固定条件复核通过）" : "（验收未确认）" : entry.verified === true ? "（仅页面断言确认）" : ""}`.slice(0, 16000),
          status: entry.step.status === "failed" ? "failed" : entry.step.status === "running" ? "running"
            : entry.step.action === "check_debug_task" ? effectiveChecks.get(entry.step.id)?.status === "passed" ? "passed" : "completed" : entry.verified === true ? "passed" : "completed",
          durationMs: entry.durationMs, source: null,
          error: entry.step.error ?? (entry.step.status === "failed" ? { category: "operation", code: "debug-step-failed", phase: "unknown", message: entry.step.message } : null) })),
        artifacts: images.map(image => ({ id: image.artifactId, kind: "screenshot", stepId: null, failureEvidence: false,
          availability: image.error ? "unavailable" : "verified", href: null, sha256: image.artifactId })) }],
    }],
  });
  return { index, images, debug: { session: document.session, steps: document.steps, snapshots, task: document.task ?? null, ...(taskAssessment ? { taskAssessment } : {}) } };
}
