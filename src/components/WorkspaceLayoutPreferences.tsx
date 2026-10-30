import { useState } from "react";
import type { WorkspaceLayout } from "../../shared/workspace-layout";

export function WorkspaceLayoutPreferences({ layout, onReset, error = null }: {
  layout: WorkspaceLayout; onReset?: () => boolean; error?: string | null;
}) {
  const [reset, setReset] = useState(false);
  return <section className="preferences-section preferences-workspace-layout" aria-labelledby="preferences-layout-title">
    <h3 id="preferences-layout-title">工作区布局</h3>
    <p>已保存：层级树宽 {Math.round(layout.treeWidth)} px · 属性面板{layout.inspector.floating ? "浮动" : "停靠"}。</p>
    <button type="button" disabled={!onReset} onClick={() => { onReset?.(); setReset(true); }}>恢复默认布局</button>
    <p className={error ? "preferences-error" : undefined} role="status">
      {error ?? (reset ? "已恢复默认树宽和属性面板布局。" : "窗口变小时会临时调整显示，保留原布局偏好。")}
    </p>
  </section>;
}
