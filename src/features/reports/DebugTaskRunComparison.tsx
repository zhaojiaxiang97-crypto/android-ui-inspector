import { useCallback, useEffect, useRef, useState } from "react";
import { compareDebugTaskRuns, debugTaskRunStatusLabel, type DebugTaskRun, type DebugTaskRunOutcome, type DebugTaskRunTime } from "../../../shared/debug-task-comparison";
import type { DebugTaskCondition } from "../../../shared/debug-task";
import type { ImportTestReportResult, LoadedTestReport } from "../../../shared/test-report";
import { debugTaskConditionLabel } from "./debug-report-view";
import "./debug-task-run-comparison.css";

type Props = { primary: LoadedTestReport; active: boolean; blocked?: boolean; loadComparisonReport?: () => Promise<ImportTestReportResult>;
  onPendingChange?: (pending: boolean) => void };
function availableImporter() {
  if (typeof window === "undefined") return undefined;
  return (window.electronApi as unknown as { importComparisonReport?: () => Promise<ImportTestReportResult> } | undefined)?.importComparisonReport;
}
const milliseconds = (value: number) => value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} 秒`;
function Time({ value }: { value: DebugTaskRunTime }) {
  return <details className="debug-run-time"><summary>{value.milliseconds === null ? "耗时未知" : milliseconds(value.milliseconds)}</summary>
    <p>{value.reason}</p>{value.startedAt && value.finishedAt && <p>{value.startedAt} → {value.finishedAt}</p>}</details>;
}
function Conditions({ conditions }: { conditions: DebugTaskCondition[] }) {
  return <ul className="debug-run-conditions">{conditions.map(condition => <li key={condition.id}><strong>{condition.id}</strong> · {debugTaskConditionLabel(condition)}</li>)}</ul>;
}
function Source({ value, title }: { value: DebugTaskRun; title: string }) {
  return <section className="debug-run-source"><h4>{title}</h4><p>App {value.source.packageName} · 设备 {value.source.serial}</p>
    <p><strong>目标：{value.definition?.goal ?? "没有完整固定任务定义"}</strong></p>
    <p>最近最终验收：<strong data-comparison-summary-status={value.phases.at(-1)?.outcome.status ?? "unchecked"}>{debugTaskRunStatusLabel(value.phases.at(-1)?.outcome.status ?? "unchecked")}</strong></p>
    <details className="debug-run-provenance"><summary>报告来源与开始时间</summary>
      <p>会话 {value.source.sessionId}<br />任务 {value.source.taskId ?? "未定义"}</p>
      <p>开始 {value.source.startedAt} · {value.source.active ? "保存时仍在授权" : "保存时已停止"}</p>
      <p className="debug-run-hash" title={value.source.reportSha256}>报告摘要 {value.source.reportSha256}</p>
    </details>
    <div className="debug-run-total-time">定义任务→最近最终检查：<Time value={value.time} /></div>
  </section>;
}
function Outcome({ value }: { value: DebugTaskRunOutcome }) {
  return <div className="debug-run-outcome" data-comparison-status={value.status}>
    <strong>{debugTaskRunStatusLabel(value.status)}</strong><p>{value.reason}</p>
    {value.stepId !== null && <p>本次报告步骤 #{value.stepId} · {value.checkedAt}</p>}
    <details className="debug-run-condition-results"><summary>各条件结果 · {value.conditions.filter(condition => condition.status === "failed").length} 个失败条件</summary>
      <ul>{value.conditions.map(condition => <li key={condition.id} data-comparison-condition-status={condition.status}>
        <strong>{condition.id} · {debugTaskRunStatusLabel(condition.status)}</strong><p>{condition.reason}</p>
      </li>)}</ul>
    </details>
    <div className="debug-run-check-time">检查步骤：<Time value={value.time} /></div>
  </div>;
}
function IndependentRun({ value, title }: { value: DebugTaskRun; title: string }) {
  return <section className="debug-run-independent"><h4>{title} · 独立定义与结果</h4>
    {value.phases.map(phase => <details key={phase.id === null ? "final" : `stage:${phase.id}`}><summary>{phase.title} · {phase.id ?? "最终条件"} · {debugTaskRunStatusLabel(phase.outcome.status)}</summary>
      <Conditions conditions={phase.conditions} /><Outcome value={phase.outcome} /></details>)}
    {!value.phases.length && <p>没有可对照的固定阶段与条件。</p>}
  </section>;
}

export function DebugTaskRunComparison({ primary, active, blocked, loadComparisonReport, onPendingChange }: Props) {
  const importer = loadComparisonReport ?? availableImporter();
  const details = useRef<HTMLDetailsElement>(null), pending = useRef<symbol | null>(null), mounted = useRef(true);
  const primaryRef = useRef(primary), activeRef = useRef(active), onPendingRef = useRef(onPendingChange);
  primaryRef.current = primary; activeRef.current = active; onPendingRef.current = onPendingChange;
  const [secondary, setSecondary] = useState<{ primary: LoadedTestReport; report: LoadedTestReport } | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ state: "loading" | "failed" | "canceled"; message: string } | null>(null);
  const discard = useCallback(() => { pending.current = null; setBusy(false); onPendingRef.current?.(false); }, []);
  useEffect(() => { setSecondary(null); setFeedback(null); discard(); }, [primary, discard]);
  useEffect(() => { if (!active) { discard(); setFeedback(null); } }, [active, discard]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null; onPendingRef.current?.(false); }; }, []);
  async function load() {
    if (!active || blocked || pending.current || !importer || !primary.debug?.task) return;
    const operation = Symbol("run-comparison"), source = primary; pending.current = operation;
    setBusy(true); onPendingRef.current?.(true); setFeedback({ state: "loading", message: "正在选择并读取第二份本地报告。" });
    const current = () => mounted.current && activeRef.current && primaryRef.current === source && pending.current === operation;
    try {
      const result = await importer();
      if (!current()) return;
      if (result.canceled) { setFeedback({ state: "canceled", message: "已取消选择，原对比仍保留。" }); return; }
      if (result.error || !result.report?.debug) { setFeedback({ state: "failed", message: result.error ?? "第二份不是调试记录，请选择本地 report.json；原对比仍保留。" }); return; }
      setSecondary({ primary: source, report: result.report }); setFeedback(null);
    } catch { if (current()) setFeedback({ state: "failed", message: "第二份报告读取失败，原对比仍保留。" }); }
    finally { if (pending.current === operation) discard(); }
  }
  function clear() { discard(); setSecondary(null); setFeedback(null); }
  function close() { discard(); setFeedback(null); if (details.current) details.current.open = false; }
  const comparison = secondary?.primary === primary ? compareDebugTaskRuns(primary, secondary.report) : null;
  const unavailable = !primary.debug?.task ? "当前报告没有固定任务定义，无法比较任务结果。" : !importer ? "当前版本不支持导入第二份报告。" : null;
  return <details ref={details} className="debug-task-run-comparison" onToggle={event => { if (!event.currentTarget.open) { discard(); setFeedback(null); } }}>
    <summary>跨次运行对比 <small>同 App · 完整固定定义</small></summary>
    <div className="debug-run-comparison-body">
      <div className="debug-run-comparison-actions">
        <button type="button" className="close-button" data-comparison-action="import" disabled={!active || busy || blocked || Boolean(unavailable)} onClick={() => void load()}>{busy ? "正在读取…" : comparison ? "更换第二份报告…" : "选择第二份报告…"}</button>
        {comparison && <button type="button" className="close-button" data-comparison-action="clear" onClick={clear}>清除对比</button>}
        <button type="button" className="close-button" data-comparison-action="close" onClick={close}>关闭对比</button>
      </div>
      <p>导入第二份本地报告比较历史验收，导出仍使用当前报告。</p>
      {unavailable && <p role="status">{unavailable}</p>}
      {feedback && <p data-comparison-feedback data-comparison-state={feedback.state} role={feedback.state === "failed" ? "alert" : "status"}>{feedback.message}</p>}
      {comparison && <div data-comparison-result={comparison.status}>
        <strong className="debug-run-match" data-comparison-match={comparison.status}>{comparison.status === "same_task" ? "同一固定任务 · 可以对比" : "不可直接比较任务结果"}</strong>
        <ul className="debug-run-match-reasons">{comparison.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
        <div className="debug-run-sources"><Source value={comparison.primary} title="当前报告" /><Source value={comparison.secondary} title="第二份报告" /></div>
        {comparison.status === "same_task" ? <>
          <details className="debug-run-definition"><summary>完整定义一致 · {comparison.primary.definition!.checkpoints.length} 个阶段和最终条件</summary>
            {comparison.primary.phases.map(phase => <section key={phase.id === null ? "final" : `stage:${phase.id}`}><h4>{phase.title} · {phase.id ?? "最终条件"}</h4><Conditions conditions={phase.conditions} /></section>)}
          </details>
          <table className="debug-run-results"><caption>历史验收结果 · 耗时差为第二份减当前，按各自报告的起止记录计算</caption>
            <thead><tr><th scope="col">阶段</th><th scope="col">当前报告</th><th scope="col">第二份报告</th></tr></thead>
            <tbody>{comparison.rows.map(row => <tr key={row.id === null ? "final" : `stage:${row.id}`} data-comparison-phase={row.id ?? "final"} data-comparison-phase-kind={row.id === null ? "final" : "checkpoint"}>
              <th scope="row"><strong>{row.title}</strong><span>{row.id ?? "最终条件"}</span><details><summary>固定条件</summary><Conditions conditions={row.conditions} /></details>
                <p>检查耗时差：{row.differenceMs === null ? "未知" : `${row.differenceMs > 0 ? "+" : row.differenceMs < 0 ? "−" : ""}${milliseconds(Math.abs(row.differenceMs))}`}</p></th>
              <td data-comparison-side="primary"><Outcome value={row.primary} /></td><td data-comparison-side="secondary"><Outcome value={row.secondary} /></td>
            </tr>)}</tbody>
          </table>
          <p>定义→最近最终检查耗时差：{comparison.differenceMs === null ? "未知" : `${comparison.differenceMs > 0 ? "+" : comparison.differenceMs < 0 ? "−" : ""}${milliseconds(Math.abs(comparison.differenceMs))}`}</p>
        </> : <div className="debug-run-independent-results"><IndependentRun value={comparison.primary} title="当前报告" /><IndependentRun value={comparison.secondary} title="第二份报告" /></div>}
        <p>结论来自各报告加载时的独立复核；未验收和缺证据不计作通过。时间仅对应标明的记录范围，结果不证明当前手机状态。</p>
      </div>}
    </div>
  </details>;
}
