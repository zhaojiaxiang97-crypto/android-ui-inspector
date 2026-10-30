import type { DebugScrollProgress } from "../../../shared/debug-scroll";
import { confirmedDebugInput, debugScrollInputCounts, debugScrollStopLabel, type DebugReportData } from "./debug-report-view";

export function DebugReportScrollProgress({ progress, data, resumed }: { progress: DebugScrollProgress; data: DebugReportData; resumed: boolean }) {
  const counts = debugScrollInputCounts(progress);
  const observation = (id: string | undefined) => {
    if (!id) return "未取得";
    const saved = data.snapshots.find(item => item.evidence.snapshotId === id);
    return `${id} · ${saved?.snapshot && !saved.treeError ? "树证据已保存" : "树证据未保留"}`;
  };
  return <section className="debug-report-scroll-progress" aria-label="连续滚动记录">
    <h4>连续滚动 · {debugScrollStopLabel(progress.stopReason)}</h4>
    <p>{resumed ? "下面保留原请求的手势记录；本次恢复只重新观察，没有追加滚动。" : "每次手势分别记录派发和观察结果；无变化不代表已经到底。"}</p>
    <p>{progress.iterations.length} 次尝试 · 回执确认 {counts.confirmed} 次 · 派发未确认 {counts.unknown} 次 · 未发送 {counts.notSent} 次 · {progress.observationIds.length} 次观察</p>
    {progress.confirmation && <details open><summary>两次观察确认 · {progress.confirmation.kind === "target" ? "目标" : progress.confirmation.kind === "end_marker" ? "终点标记" : "空列表（不代表目标已找到）"}</summary>
      <p>第一次：{observation(progress.confirmation.firstSnapshotId)}</p>
      <p>第二次：{observation(progress.confirmation.secondSnapshotId)}</p>
    </details>}
    {progress.iterations.map(iteration => <details key={iteration.index}>
      <summary>第 {iteration.index} 次 · {confirmedDebugInput(iteration) ? "已发送（回执确认）" : iteration.dispatchState === "not_sent" ? "未发送" : "派发未确认"} · {Math.round(iteration.durationMs)} ms · {({ changed: "页面有变化", unchanged: "页面无变化", unknown: "变化未确认" })[iteration.progress]}</summary>
      <p>开始 {iteration.startedAt}</p>
      <p>操作前：{observation(iteration.beforeId)}</p>
      <p>操作后：{observation(iteration.afterId)}</p>
      {iteration.error && <p>{iteration.error}</p>}
      <pre>{JSON.stringify({ resolvedInput: iteration.resolvedInput ?? null, inputEvidence: iteration.inputEvidence ?? null }, null, 2)}</pre>
    </details>)}
  </section>;
}
