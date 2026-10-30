import { debugSelector, matchesDebugSelector } from "../../../shared/debug-selector";
import { debugTaskDefinition, type DebugTaskCondition, type DebugTaskDefinition } from "../../../shared/debug-task";
import { debugTaskFragment, debugTaskTemplate, type DebugTaskFragment, type DebugTaskTemplate } from "../../../shared/debug-task-templates";
import type { DebugSessionState, UiNode, UiSnapshot } from "../../../shared/types";

export const selectorFields = [
  { key: "resourceId", label: "资源 ID" }, { key: "text", label: "文字" },
  { key: "contentDesc", label: "描述" }, { key: "className", label: "类名" },
] as const;
export const conditionStates = [
  { value: "visible", label: "出现" }, { value: "absent", label: "消失" },
  { value: "enabled", label: "启用" }, { value: "disabled", label: "禁用" },
] as const;

export function createDebugTaskDraft(): DebugTaskDefinition {
  return { goal: "", checkpoints: [], finalConditions: [{ id: "condition1", selector: {}, state: "visible" }] };
}

export function countDebugTaskConditions(definition: DebugTaskDefinition) {
  return definition.finalConditions.length + definition.checkpoints.reduce((count, stage) => count + stage.conditions.length, 0);
}

export function nextDebugTaskEditorId(definition: DebugTaskDefinition, kind: "stage" | "condition") {
  const ids = new Set(kind === "stage" ? definition.checkpoints.map(stage => stage.id)
    : [...definition.finalConditions, ...definition.checkpoints.flatMap(stage => stage.conditions)].map(condition => condition.id));
  let number = 1;
  while (ids.has(`${kind}${number}`)) number++;
  return `${kind}${number}`;
}

export function restoreDebugTaskTemplate(value: DebugTaskTemplate): DebugTaskDefinition {
  return debugTaskTemplate.parse(value).definition;
}

export function insertDebugTaskFragment(draft: DebugTaskDefinition, value: DebugTaskFragment, stageId: string | null = null): { definition: DebugTaskDefinition; error: string | null } {
  const parsed = debugTaskFragment.safeParse(value);
  if (!parsed.success) return { definition: draft, error: "片段内容无效，草稿已保留。" };
  const fragment = parsed.data;
  if (fragment.kind === "condition" && stageId !== null && !draft.checkpoints.some(stage => stage.id === stageId)) {
    return { definition: draft, error: "插入目标阶段已不存在，请重新选择；草稿已保留。" };
  }
  const existing = [...draft.finalConditions, ...draft.checkpoints.flatMap(stage => stage.conditions)];
  const source = fragment.kind === "condition" ? [fragment.condition] : fragment.stage.conditions;
  const conditionIds = new Set([...existing, ...source].map(condition => condition.id));
  function freshId(kind: "condition" | "stage", ids: Set<string>) {
    let number = 1;
    while (ids.has(`${kind}${number}`)) number++;
    const id = `${kind}${number}`; ids.add(id); return id;
  }
  const conditions = source.map(condition => ({ ...condition, selector: { ...condition.selector }, id: freshId("condition", conditionIds) }));
  let next: DebugTaskDefinition;
  if (fragment.kind === "stage") {
    const stageIds = new Set([...draft.checkpoints.map(stage => stage.id), fragment.stage.id]);
    next = { ...draft, checkpoints: [...draft.checkpoints, { ...fragment.stage, id: freshId("stage", stageIds), conditions }] };
  } else if (stageId === null) next = { ...draft, finalConditions: [...draft.finalConditions, ...conditions] };
  else next = { ...draft, checkpoints: draft.checkpoints.map(stage => stage.id === stageId ? { ...stage, conditions: [...stage.conditions, ...conditions] } : stage) };
  // An unfinished local draft may have empty fields. Capacity checks must not force premature task definition.
  const bytes = new TextEncoder().encode(JSON.stringify({ ...next, goal: next.goal.trim(), checkpoints: next.checkpoints.map(stage => ({ ...stage, title: stage.title.trim() })) })).length;
  const error = next.checkpoints.length > 5 ? "插入后超过5个阶段。" : next.finalConditions.length > 10 || next.checkpoints.some(stage => stage.conditions.length > 10)
    ? "每个阶段和最终条件最多10个条件。" : countDebugTaskConditions(next) > 20 ? "插入后超过20个验收条件。" : bytes > 12000 ? "插入后任务定义超过12KB。" : null;
  return error ? { definition: draft, error: `${error}草稿已保留。` } : { definition: next, error: null };
}

function nodes(snapshot: UiSnapshot | null) {
  const result: UiNode[] = [], pending = snapshot?.root ? [snapshot.root] : [];
  while (pending.length) {
    const node = pending.pop()!;
    result.push(node);
    pending.push(...node.children);
  }
  return result;
}

export function selectorFromSelectedNode(snapshot: UiSnapshot | null, selectedNode: UiNode | null) {
  if (!selectedNode || !snapshot?.root) return { selector: null, error: "请先在工作台选择一个控件，或手动填写精确匹配条件。" };
  const candidates = nodes(snapshot).filter(node => node.id === selectedNode.id);
  if (candidates.length !== 1 || selectorFields.some(({ key }) => candidates[0][key] !== selectedNode[key])) {
    return { selector: null, error: "选中控件已不属于当前快照，请重新选择。" };
  }
  const selector: DebugTaskCondition["selector"] = {};
  for (const { key } of selectorFields) {
    const value = candidates[0][key];
    if (value !== null && value !== "") selector[key] = value;
  }
  const parsed = debugSelector.safeParse(selector);
  return parsed.success ? { selector: parsed.data, error: null }
    : { selector: null, error: "该控件缺少有效属性，或属性超过512字。请手动填写精确匹配条件。" };
}

export function countSnapshotSelectorMatches(snapshot: UiSnapshot | null, selector: DebugTaskCondition["selector"]) {
  if (!snapshot?.root || !debugSelector.safeParse(selector).success) return null;
  return nodes(snapshot).filter(node => matchesDebugSelector(node, selector)).length;
}

export function debugTaskDefinitionError(definition: DebugTaskDefinition): string | null {
  const parsed = debugTaskDefinition.safeParse(definition);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  if (issue.path[0] === "goal") return "请填写任务目标，最多1024字。";
  if (issue.path.includes("title")) return "请填写每个阶段的名称，最多256字。";
  if (issue.path.includes("selector")) return "每个条件至少填写一个精确匹配属性，每项最多512字。";
  return issue.message;
}

export function debugTaskSessionBlockedReason(state: DebugSessionState | null, now = Date.now()) {
  if (!state?.active || !Number.isFinite(Date.parse(state.expiresAt)) || Date.parse(state.expiresAt) <= now) {
    return "本地模板可离线编辑。固定任务或验收前，请在工作台授权当前手机和 App。";
  }
  if (state.busy) return "当前会话正在执行操作，请等待完成。";
  return null;
}

export function debugTaskDefinitionBlockedReason(state: DebugSessionState | null, now = Date.now()) {
  return debugTaskSessionBlockedReason(state, now) ?? (state?.task ? "当前会话已经固定任务，不能改写。可继续编辑本地模板。"
    : state?.steps.some(step => ["tap_node", "scroll_node", "press_back", "perform_ui_step", "scroll_until"].includes(step.action))
      ? "本会话已请求过手机输入；任务必须在首次输入前固定。可保存模板供下一会话使用。" : null);
}
