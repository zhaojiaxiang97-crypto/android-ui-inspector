import type { InspectionSource, LayerRefreshScopeOption, UiNode } from "./types";

export function nodeRefreshScopeOptions(node: UiNode | null, context: {
  current: boolean; hasLiveRequest: boolean; source?: InspectionSource;
  busy?: "capture" | "refresh"; blocked?: boolean;
}): LayerRefreshScopeOption[] {
  const reason = !node ? "没有可刷新的控件" : !context.current ? "控件已变化，请重新选择"
    : context.busy === "capture" ? "采集中，完成后可刷新" : context.busy === "refresh" ? "刷新中，请等待完成"
    : context.blocked ? "自动调试进行中，结束后可刷新" : !context.hasLiveRequest ? "离线或历史快照不能刷新"
    : !node.attributes?.["view-ref"] ? "此控件没有 SDK View 引用" : "";
  const branchReason = reason || (context.source !== "debug-view" && context.source !== "debug-hybrid"
    ? "当前采集来源不支持分支刷新" : !node?.children.length ? "此控件没有子层" : "");
  return [{ scope: "node", available: !reason, detail: reason }, { scope: "branch", available: !branchReason, detail: branchReason }];
}
