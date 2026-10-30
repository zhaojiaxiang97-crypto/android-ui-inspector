import { matchesDebugSelector } from "./debug-selector";
import { debugTaskObservation, type DebugTaskAssessment, type DebugTaskCondition, type DebugTaskEvidence } from "./debug-task";
import { assessCaptureGeometry, clipBounds } from "./screen-coordinates";
import { isUiSnapshot } from "./snapshot-validation";
import type { UiNode } from "./types";

function nodes(evidence: DebugTaskEvidence | null, packageName: string): UiNode[] | null {
  if (!evidence || !debugTaskObservation.safeParse(evidence.observation).success || !isUiSnapshot(evidence.snapshot)) return null;
  const snapshot = evidence.snapshot;
  if (!snapshot.root || snapshot.root.package !== packageName || snapshot.error || !snapshot.serial
    || snapshot.inspectionSource !== "uiautomator" || snapshot.captureMode !== "fast"
    || !evidence.observation.component.startsWith(`${packageName}/`)
    || evidence.observation.component.length <= packageName.length + 1
    || assessCaptureGeometry(snapshot.captureGeometry).status !== "checked") return null;
  const result: UiNode[] = [], stack = [snapshot.root], ids = new Set<string>();
  while (stack.length) {
    const node = stack.pop()!;
    if (result.length >= 20_000 || !node.id || node.id.length > 2048 || ids.has(node.id)) return null;
    ids.add(node.id); result.push(node); stack.push(...node.children);
  }
  return result.length === snapshot.nodeCount ? result : null;
}

/** Declared page conditions only; this function never observes, inputs, or interprets the goal. */
export function evaluateDebugTaskConditions(conditions: DebugTaskCondition[], first: DebugTaskEvidence | null,
  second: DebugTaskEvidence | null, packageName: string): DebugTaskAssessment {
  const firstNodes = nodes(first, packageName), secondNodes = nodes(second, packageName);
  let unavailable: string | null = null;
  if (!firstNodes || !secondNodes || !first || !second) unavailable = "缺少两次完整、属于目标页面且方向已核对的 UIAutomator fast 观察。";
  else {
    const a = first.observation, b = second.observation;
    const fa = first.snapshot.captureGeometry!.afterScreenshot!, fb = second.snapshot.captureGeometry!.afterScreenshot!;
    if (a.snapshotId === b.snapshotId || Date.parse(b.capturedAt) <= Date.parse(a.capturedAt))
      unavailable = "两次观察必须来自不同新快照，并按采集时间先后排列。";
    else if (first.snapshot.serial !== second.snapshot.serial || a.component !== b.component || a.windowId !== b.windowId
      || a.activityRecordId !== b.activityRecordId)
      unavailable = "两次观察的设备、页面、窗口或 Activity 实例不一致。";
    else if (fa.width !== fb.width || fa.height !== fb.height || fa.rotation !== fb.rotation)
      unavailable = "两次观察的屏幕尺寸或方向不一致。";
  }
  const matches = (all: UiNode[] | null, evidence: DebugTaskEvidence | null, condition: DebugTaskCondition) => {
    const candidates = all?.filter(node => node.package === packageName && node.visibleToUser && matchesDebugSelector(node, condition.selector)) ?? [];
    const unknown = candidates.filter(node => !node.bounds || node.bounds.right <= node.bounds.left || node.bounds.bottom <= node.bounds.top);
    const visible = evidence ? candidates.filter(node => node.bounds && clipBounds(node.bounds, evidence.snapshot.captureGeometry!.screenshotSize)) : [];
    return { items: [...visible, ...unknown], unknown: unknown.length > 0 };
  };
  const results = conditions.map(condition => {
    const xMatches = matches(firstNodes, first, condition), yMatches = matches(secondNodes, second, condition);
    const a = xMatches.items, b = yMatches.items;
    const base = { conditionId: condition.id, firstMatchCount: a.length, secondMatchCount: b.length,
      firstNodeId: a.length === 1 ? a[0].id : null, secondNodeId: b.length === 1 ? b[0].id : null };
    if (unavailable) return { ...base, status: "insufficient_evidence" as const, reason: unavailable };
    if (xMatches.unknown || yMatches.unknown) return { ...base, status: "insufficient_evidence" as const,
      reason: "精确匹配的可见控件缺少有效位置，无法核对其屏幕范围，也不能证明不存在。" };
    if (condition.state === "absent" && (first!.snapshot.hierarchyDumpMode !== "full" || second!.snapshot.hierarchyDumpMode !== "full"))
      return { ...base, status: "insufficient_evidence" as const, reason: "不存在条件需要两次完整控件树；压缩树或未知范围不能证明不存在。" };
    if (condition.state !== "absent" && (a.length > 1 || b.length > 1))
      return { ...base, status: "insufficient_evidence" as const, reason: "精确匹配到多个可见且在屏幕内的控件，无法唯一验收。" };
    const met = (items: UiNode[]) => condition.state === "absent" ? items.length === 0
      : items.length === 1 && (condition.state === "visible" || items[0].enabled === (condition.state === "enabled"));
    const x = met(a), y = met(b);
    return x && y ? { ...base, status: "passed" as const, reason: "两次新观察均满足此页面条件。" }
      : !x && !y ? { ...base, status: "failed" as const, reason: "两次新观察均不满足此页面条件。" }
        : { ...base, status: "insufficient_evidence" as const, reason: "两次观察的条件结果不一致，页面尚不稳定。" };
  });
  const status = !results.length || results.some(item => item.status === "insufficient_evidence") ? "insufficient_evidence"
    : results.every(item => item.status === "passed") ? "passed" : "failed";
  return { status, reason: status === "passed" ? "两次新观察均满足所有声明的页面条件。"
    : status === "failed" ? "至少一个声明的页面条件在两次观察中均未满足。"
      : unavailable ?? "声明的页面条件缺少稳定、完整且唯一的证据。", conditions: results };
}
