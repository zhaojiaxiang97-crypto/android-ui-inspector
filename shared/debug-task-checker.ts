import { matchesDebugSelector } from "./debug-selector";
import { debugTaskObservation, type DebugTaskAssessment, type DebugTaskCondition, type DebugTaskEvidence } from "./debug-task";
import { assessCaptureGeometry, clipBounds } from "./screen-coordinates";
import { isUiSnapshot } from "./snapshot-validation";
import type { UiNode } from "./types";
import { assertSameHelperObservationSource, createHelperNodeRegionSafety, hasSafeHelperObservationContext,
  helperNodePartialVisibility, commonHelperPartialVisibilityRegion } from "./helper-observation";

function nodes(evidence: DebugTaskEvidence | null, packageName: string): UiNode[] | null {
  if (!evidence || !debugTaskObservation.safeParse(evidence.observation).success || !isUiSnapshot(evidence.snapshot)) return null;
  const snapshot = evidence.snapshot;
  if (!snapshot.root || snapshot.root.package !== packageName || snapshot.error || !snapshot.serial
    || !(snapshot.inspectionSource === "uiautomator" || hasSafeHelperObservationContext(snapshot)) || snapshot.captureMode !== "fast"
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
  if (!firstNodes || !secondNodes || !first || !second) unavailable = "缺少两次完整、属于目标页面且方向已核对的 fast 观察。";
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
    else if (first.snapshot.inspectionSource !== second.snapshot.inspectionSource)
      unavailable = "两次观察的采集来源不一致，不能合并验收。";
    else if (first.snapshot.inspectionSource === "accessibility-helper") {
      try { assertSameHelperObservationSource(first.snapshot, second.snapshot); }
      catch { unavailable = "两次 Helper 观察的服务、窗口或采集顺序不一致。"; }
    }
  }
  const matches = (all: UiNode[] | null, evidence: DebugTaskEvidence | null, condition: DebugTaskCondition) => {
    const matched = all?.filter(node => node.package === packageName && matchesDebugSelector(node, condition.selector)) ?? [];
    const candidates = matched.filter(node => node.visibleToUser && node.visibilityEvidence !== "hidden");
    const unknown = candidates.filter(node => !node.bounds || node.bounds.right <= node.bounds.left || node.bounds.bottom <= node.bounds.top);
    const visible = evidence ? candidates.filter(node => node.bounds && clipBounds(node.bounds, evidence.snapshot.captureGeometry!.screenshotSize)) : [];
    const regionSafety = evidence && createHelperNodeRegionSafety(evidence.snapshot);
    return { items: [...visible, ...unknown], unknown: unknown.length > 0,
      occluded: !!regionSafety && matched.some(node => regionSafety(node) !== "clear") };
  };
  const results = conditions.map(condition => {
    const xMatches = matches(firstNodes, first, condition), yMatches = matches(secondNodes, second, condition);
    const a = xMatches.items, b = yMatches.items;
    const base = { conditionId: condition.id, firstMatchCount: a.length, secondMatchCount: b.length,
      firstNodeId: a.length === 1 ? a[0].id : null, secondNodeId: b.length === 1 ? b[0].id : null };
    if (unavailable) return { ...base, status: "insufficient_evidence" as const, reason: unavailable };
    if (condition.visibility === "partial") {
      if (condition.state !== "visible" || first!.snapshot.inspectionSource !== "accessibility-helper"
        || second!.snapshot.inspectionSource !== "accessibility-helper")
        return { ...base, status: "insufficient_evidence" as const, reason: "partial 仅支持 Helper 的 visible 只读断言。" };
      const exact = (all: UiNode[]) => all.filter(node => node.package === packageName && matchesDebugSelector(node, condition.selector));
      const x = exact(firstNodes!), y = exact(secondNodes!);
      const partialBase = { ...base, firstMatchCount: x.length, secondMatchCount: y.length,
        firstNodeId: x.length === 1 ? x[0].id : null, secondNodeId: y.length === 1 ? y[0].id : null };
      if (x.length > 1 || y.length > 1) return { ...partialBase, status: "insufficient_evidence" as const,
        reason: "partial 精确匹配到多个控件（包含隐藏匹配），无法唯一验收。" };
      const px = x[0] ? helperNodePartialVisibility(first!.snapshot, x[0]) : null;
      const py = y[0] ? helperNodePartialVisibility(second!.snapshot, y[0]) : null;
      if (px?.status === "unknown" || py?.status === "unknown") return { ...partialBase, status: "insufficient_evidence" as const,
        reason: "partial 缺少完整窗口、祖先裁剪或有界几何证据。" };
      const identity = (node: UiNode) => JSON.stringify([node.id, node.package, node.resourceId, node.className,
        node.text, node.contentDesc, node.attributes?.["window-id"]]);
      if (x[0] && y[0] && identity(x[0]) !== identity(y[0])) return { ...partialBase, status: "insufficient_evidence" as const,
        reason: "partial 两次精确匹配的控件身份发生变化。" };
      if (px?.status === "exposed" && py?.status === "exposed") return commonHelperPartialVisibilityRegion(px, py)
        ? { ...partialBase, status: "passed" as const, reason: "两次新观察中该语义控件有共同的未遮挡正面积区域；不证明文字区域或播放进度。" }
        : { ...partialBase, status: "insufficient_evidence" as const, reason: "partial 两次虽有露出区域，但没有共同的正面积区域。" };
      return px?.status !== "exposed" && py?.status !== "exposed"
        ? { ...partialBase, status: "failed" as const, reason: "两次新观察均未证明该语义控件有露出区域；不作为不存在证明。" }
        : { ...partialBase, status: "insufficient_evidence" as const, reason: "partial 两次控件露出状态不一致。" };
    }
    if (xMatches.unknown || yMatches.unknown) return { ...base, status: "insufficient_evidence" as const,
      reason: "精确匹配的可见控件缺少有效位置，无法核对其屏幕范围，也不能证明不存在。" };
    if (xMatches.occluded || yMatches.occluded) return { ...base, status: "insufficient_evidence" as const,
      reason: "精确匹配的控件区域被遮挡或缺少窗口范围证据，不能确认状态，也不能证明不存在。" };
    const complete = (evidence: DebugTaskEvidence) => evidence.snapshot.hierarchyDumpMode === "full"
      || hasSafeHelperObservationContext(evidence.snapshot);
    if (condition.state === "absent" && (!complete(first!) || !complete(second!)))
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
