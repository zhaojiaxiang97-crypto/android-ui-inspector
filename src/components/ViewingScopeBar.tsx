import { AppIcon } from "./AppIcon";
import { useId } from "react";
import type { ViewingScope } from "../features/inspection/viewing-scope";
import { HiddenLayersList } from "./HiddenLayersList";

export function ViewingScopeBar({ scope }: { scope: ViewingScope }) {
  const descriptionId = useId();
  const restricted = Boolean(scope.focusLabel || scope.query.trim() || scope.interactiveOnly || scope.identifiedOnly || scope.hiddenCount);
  const condition = (label: string, actionLabel: string, action: () => boolean, kind: string) => <button type="button"
    className={`tree-scope-condition tree-scope-${kind}`} onClick={action} disabled={Boolean(scope.disabledReason)}
    aria-label={actionLabel} aria-describedby={scope.disabledReason ? descriptionId : undefined} title={scope.disabledReason ?? `${label}；${actionLabel}`}>
    <span>{label}</span><AppIcon name="close" size={12} />
  </button>;
  return <div className="tree-viewing-scope" role="region" aria-label="当前查看范围">
    <div className="tree-scope-conditions" title="这里的手动隐藏仅影响工具显示；设备不可见控件仍遵守原来的显示开关。">
      {scope.focusLabel && condition(`聚焦${scope.focusKind === "branch" ? "分支" : "图层"}：${scope.focusLabel}`, "退出聚焦", scope.exitFocus, "focus")}
      {scope.query.trim() && condition(`筛选：${scope.query.trim()}`, "清除关键词筛选", scope.clearQuery, "query")}
      {scope.interactiveOnly && condition("可交互", "取消可交互筛选", scope.clearInteractive, "interactive")}
      {scope.identifiedOnly && condition("有标识", "取消有标识筛选", scope.clearIdentified, "identified")}
      {scope.hiddenCount > 0 && condition(`手动隐藏：${scope.hiddenCount} 层`, "恢复全部手动隐藏", scope.restoreHidden, "hidden")}
      {!restricted && <span className="tree-scope-current">当前快照</span>}
    </div>
    <HiddenLayersList scope={scope} />
    {restricted && <button type="button" className="tree-scope-restore" onClick={scope.restoreAll} disabled={Boolean(scope.disabledReason)}
      title={scope.disabledReason ?? "清除筛选、退出聚焦并恢复手动隐藏；保留折叠和不可见控件设置。"}
      aria-describedby={scope.disabledReason ? descriptionId : undefined}>恢复完整查看</button>}
    {scope.selectedHiddenAncestorLabel && <div className="tree-scope-hidden-parent" role="status">
      <span title={scope.selectedHiddenAncestorLabel}>所选控件的父层仍被隐藏：{scope.selectedHiddenAncestorLabel}</span>
      {scope.locateHiddenAncestor && <button type="button" className="tree-scope-restore tree-scope-locate-parent" onClick={scope.locateHiddenAncestor}
        disabled={Boolean(scope.disabledReason)} title={scope.disabledReason ?? "定位最近的手动隐藏父层"}>定位父层</button>}
    </div>}
    {scope.disabledReason && <span id={descriptionId} className="tree-scope-disabled" role="status">{scope.disabledReason}</span>}
  </div>;
}
