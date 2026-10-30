import type { DebugReportStep } from "../../../shared/debug-report";

const statusLabel = { available: "已保存", empty: "无错误日志", unavailable: "缺少证据", cancelled: "采集已取消" };
export function DebugReportStepLogs({ record }: { record: DebugReportStep }) {
  return <section className="debug-report-logs" aria-label="此步骤的关联日志">
    <h4>步骤 #{record.step.id} 的关联日志</h4>
    {!record.logs?.length ? <p>此报告没有日志记录；旧报告不补推日志归属。</p> : record.logs.map(log => <details key={log.source} open={record.step.status === "failed" || Boolean(log.loadError)}>
      <summary>{log.source === "session" ? "本程序会话错误" : "Android 错误日志"} · {log.loadError ? "附件不可读取" : statusLabel[log.status]}{log.truncated ? " · 已截断" : ""}</summary>
      <p>会话 {log.sessionId} · 目标 {log.packageName} · {log.lineCount} 行</p>
      <p>{log.startedAt} 至 {log.finishedAt}</p>
      {log.reason && <p className={log.attribution === "missing" ? "debug-report-warning" : undefined}>{log.reason}</p>}
      {log.loadError ? <p className="debug-report-warning" role="status">{log.loadError}</p> : log.text ? <pre tabIndex={0} aria-label={`${log.source === "session" ? "本程序" : "Android"}日志内容`}>{log.text}</pre>
        : log.status === "available" ? <p>日志附件尚未读取，缺少可查看的内容。</p> : null}
    </details>)}
    <p>日志上限 200 行、128 KiB；日志缺失不改变操作回执或独立任务验收。</p>
  </section>;
}
