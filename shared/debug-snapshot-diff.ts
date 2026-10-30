import type { DebugSnapshotReference } from "./debug-report";
import type { UiNode, UiSnapshot } from "./types";
import { isUiSnapshot } from "./snapshot-validation";
import { assessCaptureGeometry } from "./screen-coordinates";

export type DebugDiffIdentity = { component: string; windowId: string; activityRecordId: string | null };
export type DebugDiffObservation = {
  snapshotId: string | null; capturedAt: string | null; freshness: DebugSnapshotReference["freshness"];
  snapshot: UiSnapshot | null; treeError: string | null; identity: DebugDiffIdentity | null;
};
export type DebugDiffNode = Pick<UiNode, "id" | "resourceId" | "className" | "text" | "contentDesc" | "enabled" | "visibleToUser" | "clickable" | "selected"> & {
  bounds: Pick<NonNullable<UiNode["bounds"]>, "left" | "top" | "right" | "bottom"> | null;
};
export type DebugNodeChange = { kind: "added" | "removed" | "changed"; before: DebugDiffNode | null; after: DebugDiffNode | null;
  fields: Array<"text" | "contentDesc" | "bounds" | "enabled" | "visibleToUser" | "clickable" | "selected"> };
export type DebugSnapshotDiff = {
  status: "unavailable" | "compared" | "partial"; reason: string | null; warnings: string[];
  changes: DebugNodeChange[]; totalChanges: number;
  counts: { added: number; removed: number; changed: number; unchanged: number; unmatchedBefore: number; unmatchedAfter: number };
  unmatched: { before: DebugDiffNode[]; after: DebugDiffNode[] };
};
export const DEBUG_DIFF_LIMITS = { nodes: 20_000, rows: 100, unmatchedRows: 20 } as const;
const unavailable = (reason: string): DebugSnapshotDiff => ({ status: "unavailable", reason, warnings: [], changes: [], totalChanges: 0,
  counts: { added: 0, removed: 0, changed: 0, unchanged: 0, unmatchedBefore: 0, unmatchedAfter: 0 }, unmatched: { before: [], after: [] } });

export function debugDiffSnapshotIdentity(snapshot: UiSnapshot | null): DebugDiffIdentity | null {
  const fields = snapshot?.root?.attributes;
  const component = fields?.["debug-observation-component"], windowId = fields?.["debug-observation-window-id"];
  if (component && windowId) return { component, windowId, activityRecordId: fields?.["debug-observation-activity-record-id"] || null };
  const focus = snapshot?.captureReadiness?.focus;
  return snapshot?.captureReadiness?.phase === "ready" && focus ? { component: focus.component, windowId: focus.windowId,
    activityRecordId: focus.activityRecordId } : null;
}

const describe = (node: UiNode): DebugDiffNode => ({ id: node.id, className: node.className, resourceId: node.resourceId,
  text: node.text, contentDesc: node.contentDesc, enabled: node.enabled, clickable: node.clickable,
  visibleToUser: node.visibleToUser, selected: node.selected,
  bounds: node.bounds ? { left: node.bounds.left, top: node.bounds.top, right: node.bounds.right, bottom: node.bounds.bottom } : null });

function collect(snapshot: UiSnapshot): UiNode[] | null {
  const nodes: UiNode[] = [], ids = new Set<string>(), stack = snapshot.root ? [snapshot.root] : [];
  while (stack.length) {
    const node = stack.pop()!;
    if (!node.id || ids.has(node.id) || nodes.length >= DEBUG_DIFF_LIMITS.nodes) return null;
    ids.add(node.id); nodes.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return nodes.length === snapshot.nodeCount ? nodes : null;
}

/** Resource selectors identify logical controls; positional IDs, text and coordinates never establish a match. */
function key(node: UiNode, packageName: string): string | null {
  return node.package === packageName && node.resourceId && /^[\w.]+:id\/[\w.-]+$/.test(node.resourceId)
    ? JSON.stringify([node.package, node.resourceId]) : null;
}

export function compareDebugSnapshots(input: { before: DebugDiffObservation; after: DebugDiffObservation;
  expectedSerial: string; expectedPackageName: string }): DebugSnapshotDiff {
  const { before, after } = input;
  if (before.freshness !== "current" || after.freshness !== "current")
    return unavailable(before.freshness === "previous" || after.freshness === "previous"
      ? "包含之前的观察，不能作为本次步骤前后差异。" : "缺少本次步骤的两次观察，无法比较。");
  if (!before.snapshotId || !after.snapshotId || before.snapshotId === after.snapshotId)
    return unavailable("需要两个不同的观察快照，不能用同一份记录比较。");
  if (before.treeError || after.treeError)
    return unavailable(`节点留证无法比较：${(before.treeError || after.treeError)!.slice(0, 500)}`);
  if (!before.snapshot?.root || !after.snapshot?.root)
    return unavailable("观察的节点留证缺失或加载失败，无法比较。");
  const a = before.snapshot, b = after.snapshot;
  if (!isUiSnapshot(a) || !isUiSnapshot(b) || a.error || b.error) return unavailable("观察包含错误或无效节点记录，无法比较。");
  if (!before.capturedAt || !after.capturedAt || !Number.isFinite(Date.parse(before.capturedAt)) || !Number.isFinite(Date.parse(after.capturedAt))
    || Date.parse(before.capturedAt) >= Date.parse(after.capturedAt)) return unavailable("两次观察的时间缺失或顺序不成立，无法比较。");
  if (a.serial !== input.expectedSerial || b.serial !== input.expectedSerial || a.root?.package !== input.expectedPackageName || b.root?.package !== input.expectedPackageName)
    return unavailable("两次观察不属于同一目标设备与 App，无法比较。");
  if (!a.inspectionSource || a.inspectionSource !== b.inspectionSource || !a.captureMode || a.captureMode !== b.captureMode
    || a.hierarchyDumpMode !== b.hierarchyDumpMode) return unavailable("采集来源、方式或树范围不同或未记录，无法比较。");
  const first = before.identity, second = after.identity;
  if (!first?.component || !first.windowId || !second?.component || !second.windowId)
    return unavailable("缺少页面或窗口身份，无法确认两次观察可比较。");
  if (!first.activityRecordId || !second.activityRecordId) return unavailable("缺少 Activity 实例身份，不能确认是同一页面实例。");
  for (const [snapshot, identity] of [[a, first], [b, second]] as const) {
    const saved = debugDiffSnapshotIdentity(snapshot);
    if (saved && (saved.component !== identity.component || saved.windowId !== identity.windowId || saved.activityRecordId !== identity.activityRecordId))
      return unavailable("观察的页面、窗口或 Activity 实例与节点留证不一致。");
  }
  if (!first.component.startsWith(`${input.expectedPackageName}/`) || first.component !== second.component
    || first.windowId !== second.windowId || first.activityRecordId !== second.activityRecordId)
    return unavailable("页面、窗口或 Activity 实例不同，无法确认节点前后身份。");
  const left = collect(a), right = collect(b);
  if (!left || !right) return unavailable("节点编号重复、数量不符或树超限，无法安全比较。");
  const fa = a.captureGeometry?.afterScreenshot, fb = b.captureGeometry?.afterScreenshot;
  const geometry = assessCaptureGeometry(a.captureGeometry).status === "checked" && assessCaptureGeometry(b.captureGeometry).status === "checked";
  if (geometry && (fa!.width !== fb!.width || fa!.height !== fb!.height || fa!.rotation !== fb!.rotation))
    return unavailable("两次观察的屏幕尺寸或方向不同，无法比较节点位置。");
  const warnings: string[] = [];
  if (!geometry) warnings.push("缺少核对后的屏幕坐标系；仅比较文字与状态，位置变化未知。");
  if (a.hierarchyDumpMode === "compressed") warnings.push("压缩树仅包含采集到的控件；新增或消失表示记录变化，不证明屏内出现或消失。");
  else if (a.inspectionSource === "uiautomator" && !a.hierarchyDumpMode) warnings.push("没有记录树是否完整；新增或消失仅表示留证中资源控件的变化。");
  const group = (nodes: UiNode[]) => {
    const result = new Map<string, UiNode[]>();
    for (const node of nodes) {
      const identity = key(node, input.expectedPackageName);
      if (!identity) continue;
      const group = result.get(identity);
      if (group) group.push(node); else result.set(identity, [node]);
    }
    return result;
  };
  const x = group(left), y = group(right), changes: DebugNodeChange[] = [];
  const counts = { added: 0, removed: 0, changed: 0, unchanged: 0, unmatchedBefore: 0, unmatchedAfter: 0 };
  const matchedBefore = new Set<UiNode>(), matchedAfter = new Set<UiNode>();
  const record = (change: DebugNodeChange) => { counts[change.kind]++; if (changes.length < DEBUG_DIFF_LIMITS.rows) changes.push(change); };
  for (const identity of new Set([...x.keys(), ...y.keys()])) {
    const old = x.get(identity) ?? [], fresh = y.get(identity) ?? [];
    if (old.length > 1 || fresh.length > 1) continue;
    if (old[0] && !old[0].className || fresh[0] && !fresh[0].className) continue;
    if (old[0] && fresh[0] && old[0].className !== fresh[0].className) continue;
    if (old[0]) matchedBefore.add(old[0]); if (fresh[0]) matchedAfter.add(fresh[0]);
    if (!old[0]) { record({ kind: "added", before: null, after: describe(fresh[0]), fields: [] }); continue; }
    if (!fresh[0]) { record({ kind: "removed", before: describe(old[0]), after: null, fields: [] }); continue; }
    const fields: DebugNodeChange["fields"] = (["text", "contentDesc"] as const).filter(field => (old[0][field] ?? "") !== (fresh[0][field] ?? ""));
    fields.push(...(["enabled", "visibleToUser", "clickable", "selected"] as const).filter(field => old[0][field] !== fresh[0][field]));
    if (geometry && old[0].bounds && fresh[0].bounds && ["left", "top", "right", "bottom"].some(
      coordinate => old[0].bounds![coordinate as keyof NonNullable<UiNode["bounds"]>] !== fresh[0].bounds![coordinate as keyof NonNullable<UiNode["bounds"]>])) fields.push("bounds");
    if (geometry && (!old[0].bounds || !fresh[0].bounds) && !warnings.some(warning => warning.includes("节点位置缺失")))
      warnings.push("部分节点位置缺失；这些节点的位置变化未知。");
    if (fields.length) record({ kind: "changed", before: describe(old[0]), after: describe(fresh[0]), fields });
    else counts.unchanged++;
  }
  const unconfirmedBefore = left.filter(node => !matchedBefore.has(node)), unconfirmedAfter = right.filter(node => !matchedAfter.has(node));
  counts.unmatchedBefore = unconfirmedBefore.length; counts.unmatchedAfter = unconfirmedAfter.length;
  if (counts.unmatchedBefore || counts.unmatchedAfter) warnings.push("重复资源 ID、类型改变、缺少稳定标识或其他 App 的节点没有确认匹配；不据此推断新增、消失或文字变化。");
  const totalChanges = counts.added + counts.removed + counts.changed;
  if (totalChanges > changes.length) warnings.push(`共 ${totalChanges} 个确认变化，最多展开前 ${DEBUG_DIFF_LIMITS.rows} 个。`);
  return { status: warnings.length ? "partial" : "compared", reason: null, warnings, changes, totalChanges, counts,
    unmatched: { before: unconfirmedBefore.slice(0, DEBUG_DIFF_LIMITS.unmatchedRows).map(describe), after: unconfirmedAfter.slice(0, DEBUG_DIFF_LIMITS.unmatchedRows).map(describe) } };
}
