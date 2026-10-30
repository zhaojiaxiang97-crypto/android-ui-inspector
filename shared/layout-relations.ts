import type { UiNode } from "./types";

export type LayoutRules = { type: "RelativeLayout" | "ConstraintLayout"; rules: [string, string | boolean][] };
export type LayoutRelation = {
  name: string; value: string | boolean;
  target: UiNode | null;
  status: "value" | "resolved" | "unresolved";
  reason?: "missing-node" | "missing-parent" | "unconfirmed-parent" | "invalid-parent-target" | "incomplete-id" | "missing-target" | "duplicate-id" | "self-reference";
};

export const layoutRuleLabels: Record<string, string> = Object.assign(Object.create(null), {
  leftOf: "位于目标左侧", rightOf: "位于目标右侧", above: "位于目标上方", below: "位于目标下方",
  alignBaseline: "基线对齐", alignLeft: "左边对齐", alignTop: "顶部对齐", alignRight: "右边对齐", alignBottom: "底部对齐",
  alignParentLeft: "对齐父容器左侧", alignParentTop: "对齐父容器顶部", alignParentRight: "对齐父容器右侧", alignParentBottom: "对齐父容器底部",
  centerInParent: "父容器内居中", centerHorizontal: "水平居中", centerVertical: "垂直居中",
  startOf: "位于目标起始侧", endOf: "位于目标结束侧", alignStart: "起始侧对齐", alignEnd: "结束侧对齐",
  alignParentStart: "对齐父容器起始侧", alignParentEnd: "对齐父容器结束侧",
  leftToLeft: "左边 → 目标左边", leftToRight: "左边 → 目标右边", rightToLeft: "右边 → 目标左边", rightToRight: "右边 → 目标右边",
  startToStart: "起始侧 → 目标起始侧", startToEnd: "起始侧 → 目标结束侧", endToStart: "结束侧 → 目标起始侧", endToEnd: "结束侧 → 目标结束侧",
  topToTop: "顶部 → 目标顶部", topToBottom: "顶部 → 目标底部", bottomToTop: "底部 → 目标顶部", bottomToBottom: "底部 → 目标底部",
  baselineToBaseline: "基线 → 目标基线", baselineToTop: "基线 → 目标顶部", baselineToBottom: "基线 → 目标底部",
  circleConstraint: "环绕目标", horizontalBias: "水平偏置", verticalBias: "垂直偏置", circleRadius: "环绕半径",
  circleAngle: "环绕角度", dimensionRatio: "宽高比",
});

const anchors: Record<LayoutRules["type"], ReadonlySet<string>> = {
  RelativeLayout: new Set(["leftOf", "rightOf", "above", "below", "alignBaseline", "alignLeft", "alignTop", "alignRight", "alignBottom",
    "startOf", "endOf", "alignStart", "alignEnd"]),
  ConstraintLayout: new Set(["leftToLeft", "leftToRight", "rightToLeft", "rightToRight", "startToStart", "startToEnd", "endToStart", "endToEnd",
    "topToTop", "topToBottom", "bottomToTop", "bottomToBottom", "baselineToBaseline", "baselineToTop", "baselineToBottom", "circleConstraint"]),
};

export function parseLayoutRules(raw: string | undefined): LayoutRules | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as { type?: unknown; rules?: unknown };
    if ((data.type !== "RelativeLayout" && data.type !== "ConstraintLayout")
      || data.rules === null || typeof data.rules !== "object" || Array.isArray(data.rules)) return null;
    return { type: data.type, rules: Object.entries(data.rules).filter((entry): entry is [string, string | boolean] =>
      typeof entry[1] === "string" || typeof entry[1] === "boolean") };
  } catch { return null; }
}

// These labels describe recorded values; they do not assert that a constraint took effect.
export function layoutRuleValue(name: string, value: string | boolean) {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (!value.trim()) return "—";
  if (value === "parent") return "父容器";
  if (["horizontalBias", "verticalBias"].includes(name))
    return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 1000) / 10}%` : "—";
  if (name === "circleRadius") return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100) / 100}px` : "—";
  if (name === "circleAngle") return Number.isFinite(Number(value)) ? `${Number(value)}°` : "—";
  return value.includes(":id/") ? value.slice(value.lastIndexOf(":") + 1) : value;
}

export const layoutRelationReasons: Record<NonNullable<LayoutRelation["reason"]>, string> = {
  "missing-node": "控件不在当前树中",
  "missing-parent": "当前树缺少父容器",
  "unconfirmed-parent": "无法确认父布局类型",
  "invalid-parent-target": "此规则不接受父容器目标",
  "incomplete-id": "资源 ID 不完整",
  "missing-target": "当前同级未找到",
  "duplicate-id": "同级资源 ID 重复",
  "self-reference": "目标指向当前控件",
};

// Exact object membership prevents stale/copied nodes with the same UI ID from
// resolving against a different tree. Do not infer a parent from a path prefix.
function actualParent(root: UiNode, node: UiNode): { found: boolean; parent: UiNode | null } {
  const stack: { node: UiNode; parent: UiNode | null }[] = [{ node: root, parent: null }];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.node === node) return { found: true, parent: current.parent };
    for (let index = current.node.children.length - 1; index >= 0; index--)
      stack.push({ node: current.node.children[index], parent: current.node });
  }
  return { found: false, parent: null };
}

function matchesParentType(parent: UiNode, type: LayoutRules["type"]) {
  const expected = type === "RelativeLayout" ? "android.widget.RelativeLayout" : "androidx.constraintlayout.widget.ConstraintLayout";
  return parent.className === expected || parent.attributes?.["sdk-class-hierarchy"]?.split(" → ").includes(expected) === true;
}

export function resolveLayoutRelations(root: UiNode, node: UiNode, rules: LayoutRules): LayoutRelation[] {
  const { found, parent } = actualParent(root, node);
  return rules.rules.map(([name, value]) => {
    const row: LayoutRelation = { name, value, target: null, status: "value" };
    if (typeof value !== "string" || !anchors[rules.type].has(name)) return row;
    const unresolved = (reason: NonNullable<LayoutRelation["reason"]>): LayoutRelation => ({ ...row, status: "unresolved", reason });
    if (!found) return unresolved("missing-node");
    if (!parent) return unresolved("missing-parent");
    if (!matchesParentType(parent, rules.type)) return unresolved("unconfirmed-parent");
    if (value === "parent") return rules.type === "ConstraintLayout"
      ? { ...row, status: "resolved", target: parent } : unresolved("invalid-parent-target");
    // SDK fallback numeric IDs and short names cannot identify an object safely.
    if (!/^[A-Za-z_][\w.]*:id\/[A-Za-z_][\w.]*$/.test(value)) return unresolved("incomplete-id");
    const matches = parent.children.filter(sibling => sibling.resourceId === value);
    if (!matches.length) return unresolved("missing-target");
    if (matches.length !== 1) return unresolved("duplicate-id");
    if (matches[0] === node) return unresolved("self-reference");
    return { ...row, status: "resolved", target: matches[0] };
  });
}
