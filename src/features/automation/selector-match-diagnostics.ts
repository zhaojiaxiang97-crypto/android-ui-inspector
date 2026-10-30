import { debugSelector, matchesDebugSelector } from "../../../shared/debug-selector";
import { isUiSnapshot } from "../../../shared/snapshot-validation";
import { assessCaptureGeometry, validBounds } from "../../../shared/screen-coordinates";
import type { DebugTaskCondition } from "../../../shared/debug-task";
import type { UiNode, UiSnapshot } from "../../../shared/types";

export type DebugSelector = DebugTaskCondition["selector"];
export const SELECTOR_DIAGNOSTIC_FIELDS = [
  { key: "resourceId", label: "资源 ID" }, { key: "text", label: "文字" },
  { key: "contentDesc", label: "描述" }, { key: "className", label: "类名" },
] as const;
export const SELECTOR_DIAGNOSTIC_LIMITS = { nodes: 20_000, matches: 20, references: 5, displayedText: 512 } as const;
export type SelectorDiagnosticField = typeof SELECTOR_DIAGNOSTIC_FIELDS[number]["key"];
export type SelectorFieldMismatch = { field: SelectorDiagnosticField; expected: string; actual: string | null; similarity: string | null };
export type SelectorMatchCandidate = { node: UiNode; mismatches: SelectorFieldMismatch[]; matchedFields: number;
  navigable: boolean; navigationReason: string | null; refinements: SelectorDiagnosticField[] };
export type SelectorMatchDiagnosis = {
  status: "ready" | "invalid-selector" | "unavailable"; reason: string | null; selector: DebugSelector | null;
  exactCount: number; exact: SelectorMatchCandidate[]; references: SelectorMatchCandidate[];
  referenceCount: number; visitedNodes: number; warnings: string[]; ambiguity: string[];
};

function readTree(snapshot: UiSnapshot | null): { nodes: UiNode[]; ids: Map<string, number>; error: string | null } {
  const failure = (error: string) => ({ nodes: [], ids: new Map<string, number>(), error });
  if (!snapshot?.root) return failure("没有可读取的控件树，请使用已有快照或手动编辑条件。");
  if (snapshot.error) return failure("这份快照记录了采集错误，无法安全诊断或定位控件。");
  if (!isUiSnapshot(snapshot)) return failure("控件记录无效或超过 20,000 个节点上限，无法安全诊断。");
  const nodes: UiNode[] = [], ids = new Map<string, number>(), pending = [snapshot.root];
  while (pending.length) {
    const node = pending.pop()!;
    if (nodes.length >= SELECTOR_DIAGNOSTIC_LIMITS.nodes) return failure("控件树超过 20,000 个节点上限，未使用截断结果判断匹配。");
    nodes.push(node); ids.set(node.id, (ids.get(node.id) ?? 0) + 1);
    for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
  }
  return nodes.length === snapshot.nodeCount ? { nodes, ids, error: null } : failure("控件数量与快照记录不一致，无法安全诊断或定位。");
}

function navigationReason(node: UiNode, ids: Map<string, number>) {
  if (!node.id || node.id.length > 2048 || ids.get(node.id) !== 1) return "控件编号缺失、过长或重复，不能确定要定位的节点。";
  if (!node.bounds || !validBounds(node.bounds)) return "位置未记录或无效，不能核对画布定位。";
  return null;
}

function oneEditApart(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length <= b.length) j++;
    if (a.length >= b.length) i++;
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) === 1;
}

function similarity(expected: string, actual: string | null) {
  if (actual === null || actual.length > 512) return null;
  if (expected.trim() === actual.trim()) return "去除首尾空白后相同，原文仍不匹配";
  const a = expected.trim().toLocaleLowerCase(), b = actual.trim().toLocaleLowerCase();
  if (!a || !b) return null;
  if (a === b) return "忽略大小写后相同，原文仍不匹配";
  if (a.includes(b) || b.includes(a)) return "只有部分字符相同，原文仍不匹配";
  return oneEditApart(a, b) ? "相差一个字符，原文仍不匹配" : null;
}

/** Attribute conjunction only. Similarities explain editing options and never count as matches. */
export function diagnoseSelectorMatches(snapshot: UiSnapshot | null, selector: unknown): SelectorMatchDiagnosis {
  const blank: SelectorMatchDiagnosis = { status: "unavailable", reason: null, selector: null, exactCount: 0, exact: [],
    references: [], referenceCount: 0, visitedNodes: 0, warnings: [], ambiguity: [] };
  const parsed = debugSelector.safeParse(selector);
  if (!parsed.success) return { ...blank, status: "invalid-selector", reason: "至少填写一个有效的精确属性；仅支持资源 ID、文字、描述和类名，每项最多512字。" };
  const tree = readTree(snapshot);
  if (tree.error) return { ...blank, selector: parsed.data, reason: tree.error };
  const used = SELECTOR_DIAGNOSTIC_FIELDS.filter(({ key }) => parsed.data[key] !== undefined);
  const unused = SELECTOR_DIAGNOSTIC_FIELDS.filter(({ key }) => parsed.data[key] === undefined);
  const exact: SelectorMatchCandidate[] = [], references: Array<{ candidate: SelectorMatchCandidate; score: number }> = [];
  const resources = new Map<string, number>();
  let exactCount = 0, referenceCount = 0;
  for (const node of tree.nodes) {
    const mismatches: SelectorFieldMismatch[] = used.filter(({ key }) => node[key] !== parsed.data[key]).map(({ key }) => ({
      field: key, expected: parsed.data[key]!, actual: node[key], similarity: similarity(parsed.data[key]!, node[key]) }));
    const reason = navigationReason(node, tree.ids);
    const candidate: SelectorMatchCandidate = { node, mismatches, matchedFields: used.length - mismatches.length,
      navigable: !reason, navigationReason: reason, refinements: unused.filter(({ key }) => node[key] && node[key]!.length <= 512).map(({ key }) => key) };
    if (matchesDebugSelector(node, parsed.data)) {
      exactCount++;
      if (exact.length < SELECTOR_DIAGNOSTIC_LIMITS.matches) exact.push(candidate);
      if (node.resourceId) resources.set(node.resourceId, (resources.get(node.resourceId) ?? 0) + 1);
      continue;
    }
    const score = candidate.matchedFields * 10 + mismatches.filter(item => item.similarity).length;
    if (!score) continue;
    referenceCount++;
    const index = references.findIndex(item => item.score < score);
    references.splice(index < 0 ? references.length : index, 0, { candidate: { ...candidate, navigable: false,
      navigationReason: "参考候选不是精确匹配，不提供选择操作。" }, score });
    if (references.length > SELECTOR_DIAGNOSTIC_LIMITS.references) references.pop();
  }
  const warnings: string[] = [], ambiguity: string[] = [];
  if ([...tree.ids].some(([id, count]) => !id || id.length > 2048 || count > 1)) warnings.push("树中有缺失、过长或重复控件编号；对应候选不能定位。");
  if (assessCaptureGeometry(snapshot?.captureGeometry).status !== "checked") warnings.push("屏幕坐标系未核对，位置仅按本快照记录展示。");
  if (!snapshot?.inspectionSource) warnings.push("这份旧快照没有记录采集来源，不能据此判断当前手机页面。");
  if (used.length === 1 && used[0].key === "className") ambiguity.push("只填写了类名；同类控件可能有多个，类名不保证唯一。");
  if (exactCount > 1) {
    ambiguity.push("多个控件同时符合所有已填写字段，当前条件不能唯一定位。");
    if ([...resources.values()].some(count => count > 1)) ambiguity.push("匹配控件中有重复资源 ID，不能靠同一 ID 区分列表项。");
    if (unused.length) ambiguity.push(`未限制：${unused.map(item => item.label).join("、")}。可对照候选属性手动细化，不能自动推断稳定身份。`);
  }
  return { status: "ready", reason: null, selector: parsed.data, exactCount, exact, references: references.map(item => item.candidate),
    referenceCount, visitedNodes: tree.nodes.length, warnings, ambiguity };
}

/** Uses the same bounded validation as the list; IDs must be unique throughout the tree. */
export function uniqueSnapshotNode(snapshot: UiSnapshot | null, nodeId: string): UiNode | null {
  if (!nodeId || nodeId.length > 2048) return null;
  const tree = readTree(snapshot);
  return !tree.error && tree.ids.get(nodeId) === 1 ? tree.nodes.find(node => node.id === nodeId) ?? null : null;
}

/** Rechecks current attributes and geometry before navigating a displayed candidate. */
export function exactSelectorMatchNode(snapshot: UiSnapshot | null, selector: unknown, nodeId: string): UiNode | null {
  const parsed = debugSelector.safeParse(selector);
  if (!parsed.success) return null;
  const node = uniqueSnapshotNode(snapshot, nodeId);
  return node && matchesDebugSelector(node, parsed.data) && node.bounds && validBounds(node.bounds) ? node : null;
}
