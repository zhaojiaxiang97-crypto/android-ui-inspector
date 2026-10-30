import type { DebugReportStep, DebugSessionReport, DebugSnapshotEvidence, DebugSnapshotReference } from "../../../shared/debug-report";
import type { LoadedTestReport, TestReportStep } from "../../../shared/test-report";
import type { DebugTaskAssessment, DebugTaskCheckResult, DebugTaskCondition, DebugTaskRecord, DebugTaskStatus } from "../../../shared/debug-task";
import type { DebugInputAction, DebugStep, PixelSize, UiNode, UiSnapshot } from "../../../shared/types";

export type DebugReportData = {
  session: DebugSessionReport["session"];
  steps: DebugReportStep[];
  snapshots: Array<{ evidence: DebugSnapshotEvidence; snapshot: UiSnapshot | null; treeError: string | null; screenshotArtifactId: string | null }>;
  task?: DebugTaskRecord | null;
  taskAssessment?: { checks: Array<{ recorded: DebugTaskCheckResult; effective: DebugTaskAssessment }>; final: DebugTaskAssessment | null } | null;
};

export function debugTaskStatusLabel(status: DebugTaskStatus) {
  return { passed: "通过", failed: "失败", insufficient_evidence: "证据不足" }[status];
}

export function debugTaskConditionLabel(condition: DebugTaskCondition) {
  const states = { visible: "应屏内可见", absent: "应无屏内可见匹配", enabled: "应已启用", disabled: "应未启用" };
  const fields: Record<string, string> = { resourceId: "资源ID", text: "文本", contentDesc: "描述", className: "类名" };
  return `${Object.entries(condition.selector).map(([key, value]) => `${fields[key] ?? key}=${JSON.stringify(value)}`).join("，")} · ${states[condition.state]}`;
}

const unavailableTaskCheck = (check: DebugTaskCheckResult): DebugTaskAssessment => ({ status: "insufficient_evidence",
  reason: "缺少可复核的验收结果，不能据原始记录宣称通过。",
  conditions: check.conditions.map(condition => ({ conditionId: condition.conditionId, status: "insufficient_evidence",
    reason: "缺少有效证据。", firstMatchCount: 0, secondMatchCount: 0, firstNodeId: null, secondNodeId: null })) });

export function debugTaskCheckAssessment(data: DebugReportData | undefined, check: DebugTaskCheckResult) {
  const reviewed = data?.taskAssessment?.checks.find(item => item.recorded.taskId === check.taskId
    && item.recorded.stepId === check.stepId && item.recorded.checkpointId === check.checkpointId && item.recorded.checkedAt === check.checkedAt);
  return reviewed?.effective ?? unavailableTaskCheck(check);
}

export function debugTaskView(data: DebugReportData) {
  const task = data.task;
  if (!task) return null;
  const latest = (checkpointId: string | null) => task.checks.filter(check => check.taskId === task.id && check.checkpointId === checkpointId)
    .sort((a, b) => b.stepId - a.stepId)[0] ?? null;
  const checkpoints = task.definition.checkpoints.map(checkpoint => {
    const check = latest(checkpoint.id);
    return { checkpoint, check, assessment: check ? debugTaskCheckAssessment(data, check) : null };
  });
  const finalCheck = latest(null);
  let finalAssessment = finalCheck ? data.taskAssessment?.final ?? unavailableTaskCheck(finalCheck) : null;
  if (finalAssessment?.status === "passed" && checkpoints.some(item => item.assessment?.status !== "passed")) finalAssessment = {
    ...finalAssessment, status: "insufficient_evidence", reason: "缺少全部阶段的有效通过证据，不能确认最终通过。",
  };
  const laterInputs = finalCheck ? data.steps.filter(record => record.step.id > finalCheck.stepId
    && ["tap_node", "scroll_node", "press_back"].includes(record.step.action)
    && (record.step.dispatchState !== "not_sent" || record.step.inputEvidence?.spawned)) : [];
  const laterInput = laterInputs[laterInputs.length - 1] ?? null;
  const earliestStep = data.steps[0]?.step.id ?? data.session.totalSteps + 1;
  const laterHistoryMissing = Boolean(finalCheck && data.session.droppedSteps > 0
    && data.session.totalSteps > finalCheck.stepId && earliestStep > finalCheck.stepId + 1);
  return { task, checkpoints, finalCheck, finalAssessment, laterInput, laterHistoryMissing,
    needsReview: Boolean(laterInput || laterHistoryMissing) };
}

export function debugVerificationState(record: DebugReportStep): "passed" | "failed" | "unverified" {
  if (record.step.action !== "wait_for_ui") return "unverified";
  if (record.step.status === "done" && record.verified === true) return "passed";
  if (record.step.status === "failed" && record.verified === false && record.step.error?.phase === "verify") return "failed";
  return "unverified";
}

export function debugStepOutcomeLabel(record: DebugReportStep, data?: DebugReportData) {
  if (record.step.status === "running") return "操作进行中";
  if (record.step.action === "check_debug_task") {
    if (!record.step.taskCheck) return "验收证据不足";
    const prefix = record.step.taskCheck.checkpointId === null ? "最终验收" : "阶段验收";
    return `${prefix}${debugTaskStatusLabel(debugTaskCheckAssessment(data, record.step.taskCheck).status)}`;
  }
  if (record.step.action === "define_debug_task" && record.step.status === "done") return "目标与验收条件已固定";
  const verification = debugVerificationState(record);
  if (verification === "failed") return "页面断言未通过";
  if (record.step.status === "failed") return "操作失败";
  return verification === "passed" ? "页面断言通过" : "操作完成 · 尚未验收";
}

export function debugStepDisplayMessage(record: DebugReportStep, data?: DebugReportData, message = record.step.message) {
  if (record.step.action !== "check_debug_task") return message;
  return record.step.taskCheck ? debugTaskCheckAssessment(data, record.step.taskCheck).reason
    : `原始记录：${message || "无附加说明"}`;
}

export function debugStepMatches(record: DebugReportStep, query: string, indexedStep?: TestReportStep, data?: DebugReportData) {
  const text = query.trim().toLocaleLowerCase();
  return !text || [String(record.step.id), `#${record.step.id}`, record.step.action, record.step.message, JSON.stringify(record.step.input),
    record.step.dispatchState, record.step.inputEvidence?.classification, debugStepOutcomeLabel(record, data),
    record.step.taskCheck ? JSON.stringify(debugTaskCheckAssessment(data, record.step.taskCheck)) : "",
    indexedStep?.error ? JSON.stringify(indexedStep.error) : ""]
    .filter(Boolean).join(" ").toLocaleLowerCase().includes(text);
}

export function confirmedDebugInput(step: DebugStep) {
  const receipt = step.inputEvidence;
  return step.dispatchState === "sent" && Boolean(receipt?.classification === "accepted"
    && receipt.spawned && receipt.closed && receipt.exitCode === 0 && receipt.signal === null);
}

export function debugDispatchLabel(step: DebugStep) {
  if (confirmedDebugInput(step)) return "已发送（回执确认）";
  if (step.dispatchState === "not_sent") return "未发送";
  if (step.dispatchState === "unknown" || step.dispatchState === "sent") return "派发未确认";
  return "没有输入派发记录";
}

export function debugObservationLabel(side: "before" | "after", reference: DebugSnapshotReference, taskCheck = false) {
  if (taskCheck) {
    const label = side === "before" ? "第1次验收观察" : "第2次验收观察";
    return reference.freshness === "current" ? label : reference.freshness === "missing" ? `${label}缺失` : `${label} · 之前观察（不能用于本次验收）`;
  }
  if (reference.freshness === "previous") return side === "before" ? "操作前参考 · 之前观察" : "操作后参考 · 之前观察（不是操作后采集）";
  if (reference.freshness === "missing") return side === "before" ? "操作前观察缺失" : "操作后观察缺失";
  return side === "before" ? "操作前观察" : "操作后观察";
}

export function debugObservation(data: DebugReportData, images: LoadedTestReport["images"], side: "before" | "after", record: DebugReportStep) {
  const reference = record[side];
  const saved = reference.snapshotId && reference.freshness !== "missing"
    ? data.snapshots.find(item => item.evidence.snapshotId === reference.snapshotId) ?? null : null;
  const image = saved?.screenshotArtifactId
    ? images.find(item => item.attemptId === data.session.id && item.artifactId === saved.screenshotArtifactId) ?? null : null;
  return { reference, label: debugObservationLabel(side, reference, record.step.action === "check_debug_task"), saved, image };
}

export function debugTaskObservation(data: DebugReportData, images: LoadedTestReport["images"], check: DebugTaskCheckResult, side: "before" | "after") {
  const observed = check.observations[side === "before" ? "first" : "second"];
  const reference: DebugSnapshotReference = observed ? { snapshotId: observed.snapshotId, freshness: "current", reason: null }
    : { snapshotId: null, freshness: "missing", reason: "本次没有接受到对应的新观察。" };
  const saved = observed ? data.snapshots.find(item => item.evidence.snapshotId === observed.snapshotId) ?? null : null;
  const image = saved?.screenshotArtifactId
    ? images.find(item => item.attemptId === data.session.id && item.artifactId === saved.screenshotArtifactId) ?? null : null;
  return { reference, label: debugObservationLabel(side, reference, true), saved, image };
}

export type DebugInputMarker = { action: Exclude<DebugInputAction, { kind: "back" }>; label: string; confirmed: boolean };

// Coordinates only belong on the fresh pre-action image, after its real pixel size
// has been checked. A command receipt confirms dispatch, never the business goal.
export function debugInputMarker(record: DebugReportStep, side: "before" | "after", imageSize: PixelSize | null): { marker: DebugInputMarker | null; reason: string | null } {
  const resolved = record.step.resolvedInput;
  if (record.step.action === "check_debug_task") return { marker: null, reason: null };
  if (side !== "before" || !resolved || resolved.action.kind === "back") return { marker: null, reason: null };
  if (record.before.freshness !== "current" || !record.before.snapshotId) return { marker: null, reason: "此图不是本次操作前的新观察，不标记操作位置。" };
  if (!imageSize) return { marker: null, reason: "图片尺寸尚未确认，暂不标记位置。" };
  const { action, frame } = resolved;
  if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width <= 0 || frame.height <= 0
    || imageSize.width !== frame.width || imageSize.height !== frame.height) {
    return { marker: null, reason: "截图尺寸与本次输入坐标系不一致，不显示位置标记。" };
  }
  const inside = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < frame.width && y < frame.height;
  if (action.kind === "tap" ? !inside(action.x, action.y) : !inside(action.fromX, action.fromY) || !inside(action.toX, action.toY)) {
    return { marker: null, reason: "输入位置无效或超出截图，不显示位置标记。" };
  }
  const confirmed = confirmedDebugInput(record.step);
  return { marker: { action, confirmed, label: confirmed ? "已发送" : record.step.dispatchState === "not_sent"
    ? "计划位置，未发送" : "计划位置，派发未确认" }, reason: null };
}

export function debugSnapshotNodes(snapshot: UiSnapshot | null, query: string, limit = 50) {
  const rows: UiNode[] = [];
  const text = query.trim().toLocaleLowerCase();
  const stack = snapshot?.root ? [snapshot.root] : [];
  let total = 0;
  while (stack.length) {
    const node = stack.pop()!;
    const matches = !text || [node.id, node.className, node.package, node.text, node.resourceId, node.contentDesc,
      ...Object.entries(node.attributes ?? {}).flatMap(([key, value]) => [key, value])]
      .filter(Boolean).join(" ").toLocaleLowerCase().includes(text);
    if (matches) { total++; if (rows.length < Math.max(0, Math.min(50, limit))) rows.push(node); }
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return { rows, total };
}

export function uniqueDebugNode(snapshot: UiSnapshot | null, id: string | undefined) {
  if (!id || !snapshot?.root) return null;
  const stack = [snapshot.root];
  let found: UiNode | null = null;
  while (stack.length) {
    const node = stack.pop()!;
    if (node.id === id) { if (found) return null; found = node; }
    for (const child of node.children) stack.push(child);
  }
  return found;
}

export function debugNodeProperties(node: UiNode) {
  return { id: node.id, index: node.index, className: node.className, package: node.package, text: node.text,
    resourceId: node.resourceId, contentDesc: node.contentDesc, bounds: node.bounds, clickable: node.clickable,
    enabled: node.enabled, focusable: node.focusable, focused: node.focused, scrollable: node.scrollable,
    selected: node.selected, visibleToUser: node.visibleToUser, attributes: node.attributes ?? {}, childCount: node.children.length };
}
