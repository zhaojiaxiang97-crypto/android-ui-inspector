import { useCallback, useEffect, useRef, useState } from "react";
import type { DebugReportExportApi, DebugReportExportResult } from "../../../shared/debug-report-export";
import "./debug-report-export.css";

type Props = {
  active: boolean;
  sourceId?: string;
  reportSha256: string;
  currentStepId: number | null;
  stepCount: number;
  blocked?: boolean;
  onPendingChange?: (pending: boolean) => void;
  api?: DebugReportExportApi;
};
type Feedback = { state: "busy" | "canceling" | "canceled" | "failed" | "complete"; message: string; result?: DebugReportExportResult };
function availableApi() {
  if (typeof window === "undefined") return null;
  const api = window.electronApi as unknown as Partial<DebugReportExportApi> | undefined;
  return api?.exportDebugReportEvidence && api.cancelDebugReportExport ? api as DebugReportExportApi : null;
}

export function DebugReportExportOptions({ active, sourceId, reportSha256, currentStepId, stepCount, blocked,
  onPendingChange, api: suppliedApi }: Props) {
  const api = suppliedApi ?? availableApi();
  const [scope, setScope] = useState<"current" | "all">(currentStepId === null ? "all" : "current");
  const [includeTrees, setIncludeTrees] = useState(true);
  const [includeScreenshots, setIncludeScreenshots] = useState(true);
  const [includeLogs, setIncludeLogs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const pending = useRef<{ id: string; api: DebugReportExportApi } | null>(null);
  const generation = useRef(0), activeRef = useRef(active), onPendingRef = useRef(onPendingChange);
  activeRef.current = active; onPendingRef.current = onPendingChange;
  const discard = useCallback(() => {
    generation.current++;
    const work = pending.current; pending.current = null;
    if (work) void work.api.cancelDebugReportExport(work.id).catch(() => {});
    onPendingRef.current?.(false);
  }, []);
  useEffect(() => {
    if (!active) { discard(); setBusy(false); setFeedback(null); }
  }, [active, discard]);
  useEffect(() => () => discard(), [discard]);

  async function start() {
    if (!active || !api || !sourceId || blocked || pending.current || scope === "current" && currentStepId === null) return;
    const id = crypto.randomUUID(), operation = ++generation.current;
    pending.current = { id, api }; setBusy(true); onPendingRef.current?.(true);
    setFeedback({ state: "busy", message: "正在选择目标文件夹并准备证据，请完成系统文件夹选择。" });
    try {
      const result = await api.exportDebugReportEvidence({ requestId: id, sourceId, reportSha256,
        stepIds: scope === "all" ? "all" : [currentStepId!], includeTrees, includeScreenshots, includeLogs });
      if (!activeRef.current || operation !== generation.current || pending.current?.id !== id) return;
      if (result.canceled) setFeedback({ state: "canceled", message: "已取消导出。", result });
      else if (result.error || !result.directory) setFeedback({ state: "failed", message: result.error ?? "证据没有完成导出，请重试。", result });
      else setFeedback({ state: "complete", message: `已导出 ${result.stepCount} 步调试证据。移动整个文件夹后，可导入其中的 report.json。`, result });
    } catch {
      if (activeRef.current && operation === generation.current && pending.current?.id === id)
        setFeedback({ state: "failed", message: "证据导出失败，请重新读取报告后重试。" });
    } finally {
      if (operation === generation.current && pending.current?.id === id) {
        pending.current = null; setBusy(false); onPendingRef.current?.(false);
      }
    }
  }
  async function cancel() {
    const work = pending.current, operation = generation.current;
    if (!work || feedback?.state === "canceling") return;
    setFeedback({ state: "canceling", message: "正在取消导出并清理临时证据。" });
    try { await work.api.cancelDebugReportExport(work.id); }
    catch {
      if (activeRef.current && operation === generation.current && pending.current?.id === work.id)
        setFeedback({ state: "busy", message: "取消尚未确认，仍在导出；可再次取消或关闭面板。" });
    }
  }
  const unavailable = !sourceId ? "这份报告的来源尚未登记，请重新导入报告或查看当前调试记录后导出。"
    : !api ? "当前版本不支持证据导出。" : null;
  return <details className="debug-report-export">
    <summary>导出调试证据 <small>独立文件夹 · 可重新导入</small></summary>
    <div className="debug-report-export-body">
      <div className="debug-report-export-fields">
        <label className="debug-report-export-scope">步骤范围
          <select data-export-scope value={scope} disabled={busy || blocked || Boolean(unavailable)}
            onChange={event => setScope(event.target.value as "current" | "all")}>
            <option value="current" disabled={currentStepId === null}>{currentStepId === null ? "当前没有选中步骤" : `当前步骤 #${currentStepId}`}</option>
            <option value="all">全部已保留步骤（{stepCount} 步）</option>
          </select>
        </label>
        <fieldset disabled={busy || blocked || Boolean(unavailable)}>
          <legend>包含附件</legend>
          <label><input type="checkbox" data-export-include="trees" checked={includeTrees} onChange={event => setIncludeTrees(event.target.checked)} />树与属性</label>
          <label><input type="checkbox" data-export-include="screenshots" checked={includeScreenshots} onChange={event => setIncludeScreenshots(event.target.checked)} />整屏截图</label>
          <label><input type="checkbox" data-export-include="logs" checked={includeLogs} onChange={event => setIncludeLogs(event.target.checked)} />错误日志</label>
        </fieldset>
      </div>
      <p className="debug-report-export-note">树与截图可能包含个人信息；日志延续配置脱敏。步骤说明始终保留。未包含的验收证据会标为证据不足。</p>
      <div className="debug-report-export-actions">
        <button type="button" className="close-button" data-export-action="start"
          disabled={busy || blocked || Boolean(unavailable) || scope === "current" && currentStepId === null} onClick={() => void start()}>
          {busy ? "正在导出…" : "导出证据…"}
        </button>
        {busy && <button type="button" className="close-button" data-export-action="cancel" disabled={feedback?.state === "canceling"} onClick={() => void cancel()}>取消导出</button>}
        {unavailable && <p role="status">{unavailable}</p>}
      </div>
      {feedback && <div data-export-feedback data-export-state={feedback.state} role={feedback.state === "failed" ? "alert" : "status"}>
        <p>{feedback.message}</p>
        {feedback.result?.directory && <p className="debug-report-export-directory">{feedback.result.directory}</p>}
        {feedback.result?.warnings.length ? <details className="debug-report-export-warnings"><summary>未包含的证据 · {feedback.result.warnings.length} 项</summary>
          <ul>{feedback.result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </details> : null}
      </div>}
    </div>
  </details>;
}
