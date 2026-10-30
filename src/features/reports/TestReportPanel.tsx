import { useEffect, useRef, useState } from "react";
import { failedReportAttempt, failedReportStep, firstReportStep, testReportStatusLabel, type ImportTestReportResult, type LoadedTestReport } from "../../../shared/test-report";
import { TestReportDiagnosis } from "./TestReportDiagnosis";
import { LivePageDiagnosis, type LivePageDiagnosisProps } from "./LivePageDiagnosis";
import { DebugReportStepDetails, DebugTaskCheckEvidence } from "./DebugReportStepDetails";
import { DebugTaskSummary } from "./DebugTaskSummary";
import type { DebugTaskCheckResult } from "../../../shared/debug-task";
import { debugStepDisplayMessage, debugStepMatches, debugStepOutcomeLabel } from "./debug-report-view";
import "./test-report.css";
import { debugProgressElapsed, debugProgressPhaseLabel } from "../../../shared/debug-progress";
import type { DebugReportExportImportResult } from "../../../shared/debug-report-export";
import { DebugReportExportOptions } from "./DebugReportExportOptions";
import { DebugTaskRunComparison } from "./DebugTaskRunComparison";

type Props = { open: boolean; onClose: () => void; live?: LivePageDiagnosisProps; loadDebugReport?: () => Promise<DebugReportExportImportResult>; debugReportRequest?: number;
  loadComparisonReport?: () => Promise<ImportTestReportResult> };

export function TestReportPanel({ open, onClose, live, loadDebugReport, debugReportRequest, loadComparisonReport }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const pending = useRef<symbol | null>(null);
  const handledDebugRequest = useRef(0);
  const [report, setReport] = useState<LoadedTestReport | null>(null);
  const [selection, setSelection] = useState<{ caseId: string; attemptId: string; stepId: string | null } | null>(null);
  const [selectedTaskEvidence, setSelectedTaskEvidence] = useState<{ taskId: string; stepId: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [busySource, setBusySource] = useState<"import" | "debug">("import");
  const [exportSourceId, setExportSourceId] = useState<string | undefined>();
  const [exportBusy, setExportBusy] = useState(false);
  const [comparisonBusy, setComparisonBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null; }; }, []);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open) {
      pending.current = null; setBusy(false); setError(null);
      if (dialog.current?.open) dialog.current.close();
    }
  }, [open]);
  function closePanel() {
    handledDebugRequest.current = Math.max(handledDebugRequest.current, debugReportRequest ?? 0);
    pending.current = null; setBusy(false); setError(null); onClose();
  }
  async function receiveReport(load: () => Promise<DebugReportExportImportResult | undefined>, source: "import" | "debug") {
    if (!open || pending.current || exportBusy || comparisonBusy) return;
    const request = Symbol("report-import"); pending.current = request;
    setBusy(true); setBusySource(source); setError(null);
    try {
      const result = await load();
      if (!mounted.current || pending.current !== request || result?.canceled) return;
      if (!result || result.error || !result.report) { setError(result?.error ?? (source === "debug" ? "当前没有可读取的调试记录。" : "当前运行版本不支持导入报告。")); return; }
      setReport(result.report); setExportSourceId(result.exportSourceId); setQuery(""); setSelectedTaskEvidence(null);
      const entry = result.report.index.cases.find(c => c.attempts.some(failedReportAttempt)) ?? result.report.index.cases[0];
      const attempt = entry?.attempts.find(failedReportAttempt) ?? entry?.attempts[0];
      setSelection(entry && attempt ? { caseId: entry.id, attemptId: attempt.id, stepId: firstReportStep(attempt) } : null);
    } catch { if (mounted.current && pending.current === request) setError(source === "debug" ? "读取调试记录失败，旧报告仍保留。" : "导入失败，旧报告仍保留。请重新选择报告。"); }
    finally { if (mounted.current && pending.current === request) { pending.current = null; setBusy(false); } }
  }
  async function importReport() {
    await receiveReport(() => window.electronApi.importTestReport?.() ?? Promise.resolve(undefined), "import");
  }
  useEffect(() => {
    if (!open || !loadDebugReport || !debugReportRequest || debugReportRequest <= handledDebugRequest.current || pending.current || exportBusy || comparisonBusy) return;
    handledDebugRequest.current = debugReportRequest;
    void receiveReport(loadDebugReport, "debug");
  }, [open, debugReportRequest, loadDebugReport, busy, exportBusy, comparisonBusy]);
  const selectedCase = report?.index.cases.find(c => c.id === selection?.caseId);
  const attempt = selectedCase?.attempts.find(a => a.id === selection?.attemptId);
  const step = attempt?.steps.find(s => s.id === selection?.stepId);
  const debugStep = report?.debug?.steps.find(record => String(record.step.id) === step?.id);
  const taskEvidence = report?.debug?.task?.checks.find(check => check.taskId === selectedTaskEvidence?.taskId && check.stepId === selectedTaskEvidence?.stepId);
  function selectTaskCheck(check: DebugTaskCheckResult) {
    if (!report?.debug) return;
    const entry = report.index.cases[0], selectedAttempt = entry?.attempts[0];
    setQuery("");
    if (selectedAttempt?.steps.some(record => record.id === String(check.stepId))) {
      setSelectedTaskEvidence(null);
      setSelection({ caseId: entry.id, attemptId: selectedAttempt.id, stepId: String(check.stepId) });
    } else {
      setSelectedTaskEvidence({ taskId: check.taskId, stepId: check.stepId }); setSelection(null);
    }
  }
  const images = attempt?.artifacts.filter(a => a.kind === "screenshot" && (a.stepId === step?.id
    || (a.failureEvidence && (!step || failedReportStep(step))))) ?? [];
  // Keep visibility controlled by the parent; a delayed native close event must not close a newly reopened panel.
  return <dialog ref={dialog} className="test-report-dialog" aria-labelledby="test-report-title" onCancel={event => { event.preventDefault(); closePanel(); }}>
    <header className="test-report-header">
      <div><h2 id="test-report-title">测试报告</h2><p>导入报告本地只读 · 不触发手机采集或操作</p></div>
      <button type="button" className="close-button" disabled={busy || exportBusy || comparisonBusy} onClick={() => void importReport()}>{busy && busySource === "import" ? "正在导入…" : "导入报告…"}</button>
      {loadDebugReport && <button type="button" className="close-button" disabled={busy || exportBusy || comparisonBusy} onClick={() => void receiveReport(loadDebugReport, "debug")}>{busy && busySource === "debug" ? "正在读取…" : "查看当前调试记录"}</button>}
      <button type="button" className="close-button" onClick={closePanel} aria-label="关闭测试报告">关闭</button>
    </header>
    {busy && <p className="test-report-import-status" role="status">{busySource === "debug" ? "正在读取本地调试记录。" : "正在导入本地报告。如有系统权限提示，请完成确认。"}</p>}
    {live && <LivePageDiagnosis {...live} active={open} />}
    {error && <p className="test-report-error" role="alert">{error}</p>}
    {!report ? <div className="test-report-empty"><h3>查看一次测试的完整过程</h3><p>选择本地 summary 目录中的 index.json 或调试目录中的 report.json，查看步骤、失败位置和截图。无需连接手机。</p><p>报告及原始文件需保持在原目录。真实画面可能包含个人信息，请勿直接公开。</p></div> : <>
      <div className="test-report-summary"><strong data-status={report.index.run.status}>{testReportStatusLabel(report.index.run.status)}</strong><span>{report.index.run.startedAt}</span><span className={report.debug ? "debug-report-origin" : undefined}>{report.debug ? "来源：本项目自动调试记录" : `模型 Token：${report.index.run.modelTokens ?? "未知"}`}</span><span>运行编号 {report.index.run.id}</span></div>
      {report.debug && <div className="debug-report-retention" aria-label="调试记录范围"><p>目标 App {report.debug.session.packageName} · 保留最近 {report.debug.steps.length} 步（上限100步） · 总计 {report.debug.session.totalSteps} 步 · 已丢弃 {report.debug.session.droppedSteps} 步</p>
        {report.debug.session.progress && <p aria-label="保存时的任务进度">保存时：{debugProgressPhaseLabel(report.debug.session.progress.phase)} · {report.debug.session.progress.stepId ? `步骤 #${report.debug.session.progress.stepId}` : "尚未执行步骤"} · 会话耗时 {Math.floor(debugProgressElapsed(report.debug.session.progress, Date.parse(report.debug.session.updatedAt)).sessionMs / 1000)} 秒{report.debug.session.progress.reason ? ` · ${report.debug.session.progress.reason}` : ""}</p>}
        <p>记录更新时间 {report.debug.session.updatedAt} · {report.debug.session.active ? "保存这份记录时会话仍在授权中；重新查看可更新记录。" : `保存这份记录时会话已停止${report.debug.session.stopReason ? `：${report.debug.session.stopReason}` : "。"}`} {report.debug.task ? "任务结果见独立验收；" : "整体业务目标尚未验收，"}未保留的证据不能作为通过记录。</p>
      </div>}
      {report.debug && <DebugReportExportOptions key={`${report.index.reportSha256}:${exportSourceId ?? "unregistered"}`} active={open}
        sourceId={exportSourceId} reportSha256={report.index.reportSha256} currentStepId={debugStep?.step.id ?? null}
        stepCount={report.debug.steps.length} blocked={busy || comparisonBusy} onPendingChange={setExportBusy} />}
      {report.debug && <DebugTaskRunComparison primary={report} active={open} blocked={busy || exportBusy}
        loadComparisonReport={loadComparisonReport} onPendingChange={setComparisonBusy} />}
      {report.index.run.errors.length > 0 && (report.debug?.task
        ? <details className="test-report-error debug-report-read-errors"><summary>报告证据读取问题 · {report.index.run.errors.length} 项</summary><pre>{JSON.stringify(report.index.run.errors, null, 2)}</pre></details>
        : <div className="test-report-error"><strong>运行级错误</strong><pre>{JSON.stringify(report.index.run.errors, null, 2)}</pre></div>)}
      <div className="test-report-layout">
        <nav className="test-report-steps" aria-label="测试用例和步骤">
          {report.debug && <label className="debug-report-step-filter">查找步骤<input type="search" aria-label="筛选步骤" value={query} onChange={event => setQuery(event.target.value)} placeholder="步骤编号、操作、文字或错误" /></label>}
          {report.index.cases.map(entry => <section key={entry.id}>
            <h3>{entry.title} · {testReportStatusLabel(entry.status)}</h3>
            {!entry.attempts.length && <p>未执行，不作为通过证据。</p>}
            {entry.attempts.map(a => <div key={a.id}>
              <button type="button" className="test-report-attempt" onClick={() => { setSelectedTaskEvidence(null); setSelection({ caseId: entry.id, attemptId: a.id, stepId: firstReportStep(a) }); }}>{report.debug ? "调试步骤" : `尝试 ${a.index + 1}`} · {testReportStatusLabel(a.status)} · {a.durationMs} ms</button>
              <ol>{a.steps.map((s, i) => {
                const recorded = report.debug?.steps.find(record => String(record.step.id) === s.id);
                if (recorded && !debugStepMatches(recorded, query, s, report.debug)) return null;
                return <li key={s.id}><button type="button" data-status={s.status} aria-current={selection?.attemptId === a.id && selection?.stepId === s.id ? "step" : undefined}
                onClick={() => { setSelectedTaskEvidence(null); setSelection({ caseId: entry.id, attemptId: a.id, stepId: s.id }); }}>
                <span>{recorded ? `#${recorded.step.id}` : i + 1}. {s.api}</span><small>{(recorded ? debugStepDisplayMessage(recorded, report.debug, s.label) : s.label) || "无附加说明"}</small><span className="test-report-step-meta">{recorded ? debugStepOutcomeLabel(recorded, report.debug) : testReportStatusLabel(s.status)} · {s.durationMs} ms</span>
              </button></li>;
              })}</ol>
              {report.debug && !a.steps.some(s => {
                const recorded = report.debug?.steps.find(record => String(record.step.id) === s.id);
                return recorded && debugStepMatches(recorded, query, s, report.debug);
              }) && <p>没有匹配的步骤记录。</p>}
            </div>)}
          </section>)}
          {!report.index.cases.length && <p>没有执行用例，请查看运行级错误。</p>}
        </nav>
        <section className="test-report-detail" aria-label="所选步骤详情">
          {report.debug ? <>
            <DebugTaskSummary data={report.debug} onSelectCheck={selectTaskCheck} />
            {taskEvidence ? <DebugTaskCheckEvidence key={`${report.index.reportSha256}:task:${taskEvidence.stepId}`} data={report.debug} images={report.images} check={taskEvidence} />
              : debugStep && step ? <DebugReportStepDetails key={`${report.index.reportSha256}:${step.id}`} data={report.debug} images={report.images} record={debugStep} step={step} /> : <p>选择左侧步骤查看调试记录。</p>}
            {attempt?.secondaryErrors.length ? <details><summary>此次记录的留证问题</summary><pre>{JSON.stringify(attempt.secondaryErrors, null, 2)}</pre></details> : null}
          </> : attempt ? <>
            <h3>{step?.label || step?.api || "尝试详情"}</h3>
            <p>{step ? `${testReportStatusLabel(step.status)} · ${step.durationMs} ms` : "没有步骤记录"} · 清理：{{ complete: "已完成", failed: "失败", forced: "强制结束", unknown: "未知" }[attempt.cleanup]}</p>
            <TestReportDiagnosis attempt={attempt} images={report.images} onSelectStep={stepId => setSelection({ caseId: selectedCase!.id, attemptId: attempt.id, stepId })} />
            {step?.source && <p className="test-report-source">{step.source.file}:{step.source.line ?? "?"}</p>}
            {step?.error && <div className="test-report-error"><strong>步骤错误</strong><pre>{JSON.stringify(step.error, null, 2)}</pre></div>}
            {attempt.error && <details open={!step?.error}><summary>本次尝试错误</summary><pre>{JSON.stringify(attempt.error, null, 2)}</pre></details>}
            {attempt.secondaryErrors.length > 0 && <details open><summary>收尾及留证错误</summary><pre>{JSON.stringify(attempt.secondaryErrors, null, 2)}</pre></details>}
            {attempt.failure?.candidates?.length ? <details><summary>失败时的附近文字（不是实时控件）</summary><pre>{attempt.failure.candidates.join("\n")}</pre></details> : null}
            <div className="test-report-images">{images.map(a => {
              const image = report.images.find(img => img.attemptId === attempt.id && img.artifactId === a.id);
              return <figure key={a.id}>{image?.dataUrl ? <img src={image.dataUrl} alt={a.failureEvidence ? "失败时的本地截图" : `${step?.label || "此步骤"}的本地截图`} /> : <p role="status">{image?.error ?? "截图未加载"}</p>}<figcaption>{a.failureEvidence ? "失败时截图" : "此步骤截图"} · 仅本地查看</figcaption></figure>;
            })}</div>
            {!images.length && <p className="test-report-no-image">{attempt.artifacts.some(a => a.kind === "screenshot") ? "此步骤没有关联截图。请选择截图步骤查看画面。" : "这次尝试没有截图，仅有步骤和断言记录。"}</p>}
          </> : <p>选择左侧尝试或步骤查看详情。</p>}
          <p className="test-report-boundary">{report.debug ? "截图与树来自当时观察，不能用来操作手机。节点属性只在对应历史树中查询；此记录不包含独立图层位图。" : "截图不是可操作图层，不能据此识别真实控件身份。"} 导入不会修改当前快照、授权或手机页面。</p>
        </section>
      </div>
    </>}
  </dialog>;
}
