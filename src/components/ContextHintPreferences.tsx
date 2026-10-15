import { useState } from "react";

export function ContextHintPreferences({ acknowledgedCount, onReset }: {
  acknowledgedCount: number; onReset?: () => boolean;
}) {
  const [status, setStatus] = useState<string | null>(null);
  return <section className="preferences-section preferences-context-hints" aria-labelledby="preferences-context-hints-title">
    <h3 id="preferences-context-hints-title">操作提示</h3>
    <p>首次使用快速选择、聚焦和固定测距时显示；每个页面会话最多一条。关闭后保存在本机。</p>
    <div className="preferences-actions">
      <button type="button" disabled={!onReset} onClick={() => {
        if (onReset) setStatus(onReset() ? "已重置，下次相关操作会重新显示提示。" : "本次窗口已重置，但本机保存失败；重开后可能丢失。");
      }}>重置操作提示</button>
    </div>
    <p role="status">{status ?? (onReset ? `已了解 ${acknowledgedCount} 条提示。` : "当前窗口不支持重置操作提示。")}</p>
  </section>;
}
