import type { DebugTimings } from "../../../shared/debug-timing";
import { debugCommandCategoryLabels, debugObservationReasonLabels, debugTimingCoveredMs, debugTimingPhaseLabels } from "../../../shared/debug-timing";

const statusLabels = { running: "进行中", success: "成功", failed: "失败", cancelled: "取消" };
const ms = (value: number) => `${Math.round(value * 100) / 100} ms`;
export function DebugReportStepTimings({ timings }: { timings?: DebugTimings }) {
  if (!timings) return <p className="debug-report-timings-missing">分段计时：未记录</p>;
  return <details className="debug-report-timings">
    <summary>分段计时 · 总经过 {ms(timings.durationMs)} · {statusLabels[timings.status]}</summary>
    <p>各区间可能并行或包含子阶段；总经过时间由单调时钟测量，不是各行耗时相加。已覆盖 {ms(debugTimingCoveredMs(timings))}。</p>
    <p>设备命令尝试 {timings.commandCount} 次{Object.entries(timings.commandCounts).map(([category, count]) => ` · ${debugCommandCategoryLabels[category as keyof typeof debugCommandCategoryLabels]} ${count}`).join("")}</p>
    <p>观察 {timings.observationCount} 次{Object.entries(timings.observationCounts).map(([reason, count]) => ` · ${debugObservationReasonLabels[reason as keyof typeof debugObservationReasonLabels]} ${count}`).join("")}</p>
    <p>关联编号 {timings.correlationId} · 开始 {timings.startedAt}</p>
    {timings.droppedSpans > 0 && <p>达到记录上限，省略 {timings.droppedSpans} 个区间；次数仍包含这些调用。</p>}
    <table><caption>起止时间均相对本次调用；相交区间表示重叠执行</caption>
      <thead><tr><th>阶段</th><th>开始</th><th>结束</th><th>耗时</th><th>结果</th></tr></thead>
      <tbody>{timings.spans.map(span => <tr key={span.id}>
        <th>#{span.id} {debugTimingPhaseLabels[span.phase]}{span.commandCategory ? ` · ${debugCommandCategoryLabels[span.commandCategory]}` : ""}{span.backend ? ` · ${span.backend}` : ""}{span.reason ? ` · ${debugObservationReasonLabels[span.reason]}` : ""}{span.parentId !== null ? `（父 #${span.parentId}）` : ""}</th>
        <td>{ms(span.startOffsetMs)}</td><td>{ms(span.startOffsetMs + span.durationMs)}</td><td>{ms(span.durationMs)}</td><td>{statusLabels[span.status]}</td>
      </tr>)}</tbody>
    </table>
  </details>;
}
