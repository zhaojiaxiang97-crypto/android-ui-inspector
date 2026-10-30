import type { DebugSessionReport } from "./debug-report";

type EvidenceReport = Pick<DebugSessionReport, "snapshots" | "steps" | "task">;

/** 5: selected export; 4: current boundary; 3: confirmation; 2: failure; 1: input; 0: ordinary; -1: intermediate. */
export function debugSnapshotPriorities(report: EvidenceReport, preferredStepIds?: ReadonlySet<number>) {
  const priorities = new Map(report.snapshots.map(item => [item.snapshotId, -1]));
  const promote = (id: string | null | undefined, priority: number) => {
    if (id) priorities.set(id, Math.max(priorities.get(id) ?? -1, priority));
  };
  const check = (value: NonNullable<DebugSessionReport["task"]>["checks"][number]) => {
    const priority = value.status === "passed" ? 3 : 2;
    promote(value.observations.first?.snapshotId, priority); promote(value.observations.second?.snapshotId, priority);
  };
  const boundary = (item: EvidenceReport["steps"][number], priority: number) => {
    for (const id of [item.before.snapshotId, item.after.snapshotId, item.step.beforeId, item.step.afterId,
      item.step.resolvedInput?.visualConfirmation?.referenceSnapshotId, item.step.resolvedInput?.visualConfirmation?.currentSnapshotId,
      item.step.scrollTask?.confirmation?.firstSnapshotId, item.step.scrollTask?.confirmation?.secondSnapshotId,
      item.step.taskCheck?.observations.first?.snapshotId, item.step.taskCheck?.observations.second?.snapshotId]) promote(id, priority);
  };
  for (const item of report.steps) {
    const failed = item.step.status === "failed" || Boolean(item.step.error) || Boolean(item.step.observationFailures?.length);
    const input = item.step.dispatchState === "sent" || item.step.dispatchState === "unknown" || Boolean(item.step.resolvedInput || item.step.inputEvidence);
    const priority = failed ? 2 : input ? 1 : 0;
    for (const id of [item.before.snapshotId, item.after.snapshotId, item.step.beforeId, item.step.afterId,
      item.step.resolvedInput?.visualConfirmation?.referenceSnapshotId, item.step.resolvedInput?.visualConfirmation?.currentSnapshotId]) promote(id, priority);
    for (const iteration of item.step.scrollTask?.iterations ?? []) {
      const value = iteration.error ? 2 : iteration.dispatchState !== "not_sent" ? 1 : 0;
      promote(iteration.beforeId, value); promote(iteration.afterId, value);
    }
    const confirmation = item.step.scrollTask?.confirmation;
    if (confirmation) { promote(confirmation.firstSnapshotId, 3); promote(confirmation.secondSnapshotId, 3); }
    if (item.step.taskCheck) check(item.step.taskCheck);
  }
  for (const value of report.task?.checks ?? []) check(value);
  // Historical failures must not consume the whole quota ahead of the step
  // currently being reviewed or exported. Intermediate scroll reads stay low.
  const current = report.steps.at(-1);
  const currentBoundary = current && (["perform_ui_step", "resume_ui_step", "tap_node", "press_back", "scroll_node", "scroll_until", "check_debug_task"].includes(current.step.action)
    || current.step.status === "failed" || Boolean(current.step.error || current.step.resolvedInput || current.step.inputEvidence || current.step.observationFailures?.length));
  if (currentBoundary) boundary(current, 4);
  for (const item of report.steps) if (preferredStepIds?.has(item.step.id)) boundary(item, 5);
  return priorities;
}

/** Read critical evidence first within the existing budgets; presentation order is independent. */
export function debugSnapshotReadOrder(report: EvidenceReport, preferredStepIds?: ReadonlySet<number>) {
  const priorities = debugSnapshotPriorities(report, preferredStepIds);
  return report.snapshots.map((snapshot, index) => ({ snapshot, index }))
    .sort((left, right) => priorities.get(right.snapshot.snapshotId)! - priorities.get(left.snapshot.snapshotId)! || right.index - left.index)
    .map(item => item.snapshot);
}

export function debugScreenshotReadOrder(report: EvidenceReport, preferredStepIds?: ReadonlySet<number>) {
  // The first occurrence already has the shared image's strongest role.
  return [...new Set(debugSnapshotReadOrder(report, preferredStepIds).flatMap(item => item.screenshot ? [item.screenshot.sha256] : []))];
}
