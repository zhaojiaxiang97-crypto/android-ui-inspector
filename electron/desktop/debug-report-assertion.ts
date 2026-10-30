import { debugToolSchemas } from "../../shared/debug-protocol";
import { evaluateDebugTaskConditions } from "../../shared/debug-task-checker";
import type { DebugTaskCondition, DebugTaskObservation } from "../../shared/debug-task";
import type { DebugReportStep, DebugSnapshotEvidence } from "../../shared/debug-report";
import type { DebugStep, UiSnapshot } from "../../shared/types";

/** Only explicit read-only partial conditions get the new two-observation contract. */
export function partialAssertionCondition(step: DebugStep, original?: DebugStep): DebugTaskCondition | null {
  if (step.action === "wait_for_ui") {
    const parsed = debugToolSchemas.wait_for_ui.safeParse(step.input);
    return parsed.success && parsed.data.visibility === "partial"
      ? { id: "partial", selector: parsed.data.selector, state: parsed.data.state, visibility: "partial" } : null;
  }
  const request = step.action === "perform_ui_step" ? step : step.action === "resume_ui_step" ? original : undefined;
  if (request?.action !== "perform_ui_step") return null;
  const parsed = debugToolSchemas.perform_ui_step.safeParse(request.input);
  return parsed.success && parsed.data.expect?.visibility === "partial" ? { id: "partial", ...parsed.data.expect } : null;
}

export function verifyAssertionConfirmation(entry: DebugReportStep, original: DebugStep | undefined,
  snapshots: ReadonlyMap<string, DebugSnapshotEvidence>, owners: Map<string, number>) {
  const { step } = entry, confirmation = step.assertionConfirmation;
  const partial = partialAssertionCondition(step, original);
  // A selective export may omit the original request. The loader already demotes such resumes.
  const orphanResume = step.action === "resume_ui_step" && !original;
  if (confirmation && !partial && !orphanResume) throw new Error("双帧断言证据不属于显式部分可见条件。");
  if (!confirmation) {
    if (partial && entry.verified === true) throw new Error("部分可见断言缺少两次确认观察。");
    return;
  }
  const { first, second } = confirmation;
  if (first.snapshotId === second.snapshotId || Date.parse(first.capturedAt) >= Date.parse(second.capturedAt)
    || step.afterId !== second.snapshotId || entry.after.snapshotId !== second.snapshotId || entry.after.freshness !== "current")
    throw new Error("部分可见断言的观察顺序或最终快照不一致。");
  const request = step.action === "resume_ui_step" ? original : step;
  if (partial && request?.action === "perform_ui_step" && request.input.backend !== "accessibility-helper")
    throw new Error("部分可见断言需要 Helper 观察来源。");
  if (step.action === "perform_ui_step") {
    const before = step.beforeId && snapshots.get(step.beforeId);
    if (!before || first.snapshotId === step.beforeId || second.snapshotId === step.beforeId
      || Date.parse(first.capturedAt) <= Date.parse(before.capturedAt))
      throw new Error("部分可见断言必须保留输入后的两次新观察。");
  }
  for (const observation of [first, second]) {
    const evidence = snapshots.get(observation.snapshotId), captured = Date.parse(observation.capturedAt);
    if (!evidence || evidence.capturedAt !== observation.capturedAt || evidence.source !== "accessibility-helper"
      || captured < Date.parse(step.time) || captured > Date.parse(entry.finishedAt)
      || owners.has(observation.snapshotId) && owners.get(observation.snapshotId) !== step.id)
      throw new Error("部分可见断言引用旧观察、未知观察或错误来源。");
    owners.set(observation.snapshotId, step.id);
  }
}

export function boundAssertionObservation(observation: DebugTaskObservation, snapshot: UiSnapshot | undefined): snapshot is UiSnapshot {
  const attributes = snapshot?.root?.attributes;
  return snapshot?.inspectionSource === "accessibility-helper" && !!attributes
    && attributes["debug-observation-component"] === observation.component
    && attributes["debug-observation-window-id"] === observation.windowId
    && attributes["debug-observation-activity-record-id"] === (observation.activityRecordId ?? "");
}

/** Re-evaluate both saved trees; declared observation identity must match the captured tree identity. */
export function partialAssertionTreesSafe(step: DebugStep, original: DebugStep | undefined,
  lookup: (id: string) => UiSnapshot | undefined, packageName: string): boolean {
  const condition = partialAssertionCondition(step, original), confirmation = step.assertionConfirmation;
  if (!condition || !confirmation) return false;
  const first = lookup(confirmation.first.snapshotId), second = lookup(confirmation.second.snapshotId);
  if (!boundAssertionObservation(confirmation.first, first) || !boundAssertionObservation(confirmation.second, second)) return false;
  return evaluateDebugTaskConditions([condition], { observation: confirmation.first, snapshot: first },
    { observation: confirmation.second, snapshot: second }, packageName).status === "passed";
}
