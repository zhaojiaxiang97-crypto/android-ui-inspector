import { matchesDebugSelector, type PerformUiStepInput } from "../../shared/debug-protocol";
import { flattenNodes } from "../../shared/tree-utils";
import { windowId } from "./debug-target-resolution";
import type { Current } from "./debug-step-context";

/** Resolve exact selectors against one fresh, authorized observation. Never guess a match. */
export function locateUiStepTarget(current: Current, target: NonNullable<PerformUiStepInput["target"]>, packageName: string) {
  const nodes = [...flattenNodes(current.entry.snapshot.root!).values()];
  const visible = (node: (typeof nodes)[number]) => node.package === packageName && node.visibleToUser
    && node.visibilityEvidence !== "hidden" && windowId(node, nodes) === current.target.windowId;
  let candidates = nodes;
  if (target.within) {
    const scopes = nodes.filter(node => visible(node) && matchesDebugSelector(node, target.within!));
    if (scopes.length !== 1) throw new Error(`范围必须唯一匹配，当前找到 ${scopes.length} 个；未执行操作。`);
    candidates = [...flattenNodes(scopes[0]).values()];
  }
  const matches = candidates.filter(node => visible(node) && matchesDebugSelector(node, target.selector)
    && (target.clickable === undefined || node.clickable === target.clickable)
    && (target.scrollable === undefined || node.scrollable === target.scrollable));
  if (matches.length !== 1) throw new Error(`目标必须唯一匹配，当前找到 ${matches.length} 个；请增加精确条件或 within 范围。`);
  if (!matches[0].enabled) throw new Error("目标未启用，未执行操作。");
  return matches[0];
}
