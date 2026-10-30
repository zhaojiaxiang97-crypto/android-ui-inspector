import { useEffect, useMemo, useRef, useState } from "react";
import type { UiSnapshot } from "../../../shared/types";
import { validDiagnosticPackage } from "../../../shared/inspection-policy";
import { diagnosticImageLabels, summarizeLiveDiagnosis, type LiveDiagnosisResult } from "./live-diagnosis";

export type LivePageDiagnosisProps = {
  serial: string | null; deviceLabel: string; supported: boolean; blocked: boolean; stage: string; active?: boolean;
  onCapture: (serial: string, packageName: string, requestId: string) => Promise<UiSnapshot | null>;
  onCancel: (requestId: string) => void;
  onViewNode: (snapshot: UiSnapshot, nodeId: string) => void;
};

export function LivePageDiagnosis({ serial, deviceLabel, supported, blocked, stage, active = true, onCapture, onCancel, onViewNode }: LivePageDiagnosisProps) {
  const [packageName, setPackageName] = useState("");
  const [result, setResult] = useState<LiveDiagnosisResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const pending = useRef<string | null>(null);
  const cancel = useRef(onCancel); cancel.current = onCancel;
  useEffect(() => () => { if (pending.current) cancel.current(pending.current); pending.current = null; }, []);
  useEffect(() => {
    if (!active && pending.current) {
      const requestId = pending.current; pending.current = null; cancel.current(requestId);
      setBusy(false); setError("关闭面板已取消本次采集；不会自动重试。");
    }
  }, [active]);
  const summary = useMemo(() => result ? summarizeLiveDiagnosis(result) : null, [result]);
  const rows = summary?.rows.filter(row => [row.name, row.className, row.id, row.source, row.reason, diagnosticImageLabels[row.state]]
    .some(value => value.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) ?? [];
  async function capture() {
    if (!active || !serial || !supported || blocked || pending.current || !validDiagnosticPackage(packageName.trim())) return;
    const requestId = crypto.randomUUID(), target = packageName.trim(), startedAt = new Date().toISOString();
    pending.current = requestId; setBusy(true); setError(null); setResult(null); setQuery("");
    try {
      const snapshot = await onCapture(serial, target, requestId);
      if (pending.current !== requestId) return;
      if (!snapshot) { setError("采集被取消或替换，未采用迟到结果。不会自动重试。"); return; }
      setResult({ requestId, serial, expectedPackage: target, startedAt, finishedAt: new Date().toISOString(), snapshot });
    } catch (failure) {
      if (pending.current === requestId) setError(failure instanceof Error ? failure.message : "只读采集失败；不会自动重试。");
    } finally {
      if (pending.current === requestId) { pending.current = null; setBusy(false); }
    }
  }
  return <details className="test-report-live">
    <summary>当前页面诊断 <small>单次只读 · 不操作手机</small></summary>
    <div className="test-report-live-body">
      <p>这是一次新的采集，不是原测试现场。会更新工作台，不自动匹配旧截图或控件。</p>
      <form onSubmit={event => { event.preventDefault(); void capture(); }}>
        <label>目标 App 包名<input value={packageName} onChange={event => setPackageName(event.target.value)} placeholder="例如 com.example.app" autoComplete="off" spellCheck={false} disabled={busy} /></label>
        <span className="test-report-live-device">{serial ? deviceLabel : "没有在线设备"}</span>
        <button className="close-button" type="submit" disabled={!serial || !supported || blocked || busy || !validDiagnosticPackage(packageName.trim())}>只读采集一次</button>
        {busy && <button className="close-button" type="button" onClick={() => {
          const requestId = pending.current; pending.current = null;
          if (requestId) onCancel(requestId);
          setBusy(false); setError("已取消，只停止本次采集；不会自动重试。");
        }}>取消本次采集</button>}
      </form>
      {!supported && <p role="status">当前运行版本不支持限定 App 的诊断采集。</p>}
      {blocked && !busy && <p role="status">已有采集或自动调试正在运行，请先结束。</p>}
      {busy && <p role="status">{stage} · 单次采集，30秒到期停止</p>}
      {error && <p className="test-report-live-error" role="alert">{error}</p>}
      {result && summary && <section aria-label="本次只读采集结果">
        <p>{result.expectedPackage} · 采集结束 {result.finishedAt}</p>
        {summary.rejection ? <p className="test-report-live-error" role="alert">{summary.rejection}</p> : <>
          <p>读取 {summary.rows.length} 个节点 · 来源 {summary.source} · {summary.geometry}</p>
          <p>有色 {summary.counts.visible} · 全透明 {summary.counts.transparent} · 透明度未知 {summary.counts.captured} · 样式 {summary.counts.style} · 缺图 {summary.counts.unavailable} · 失败 {summary.counts.failed} · 歧义 {summary.counts.ambiguous} · 不可见 {summary.counts.hidden} · 未采集 {summary.counts.unknown}</p>
          <details><summary>采集身份</summary><p>进程 {summary.processId} · 窗口 {summary.windowId}</p><p>{summary.component}</p><p>请求 {result.requestId} · 开始 {result.startedAt}</p></details>
          {result.snapshot.warning && <p role="status">采集提示：{result.snapshot.warning}</p>}
          <label className="test-report-live-search">查找当前节点<input value={query} onChange={event => setQuery(event.target.value)} placeholder="名称、类、来源或缺图原因" /></label>
          <p>匹配 {rows.length} 个，最多显示前50个。画面来源不是逐像素正确性证明。</p>
          <ul className="test-report-live-nodes">{rows.slice(0, 50).map(row => <li key={row.id}>
            <button type="button" disabled={blocked} onClick={() => onViewNode(result.snapshot, row.id)}><strong>{row.name}</strong><span>#{row.id} · {diagnosticImageLabels[row.state]}</span></button>
            <small>{row.className} · {row.bounds}</small><small>来源：{row.source}{row.reason ? ` · ${row.reason}` : ""}</small>
          </li>)}</ul>
          {!rows.length && <p>没有匹配节点。</p>}
        </>}
      </section>}
    </div>
  </details>;
}
