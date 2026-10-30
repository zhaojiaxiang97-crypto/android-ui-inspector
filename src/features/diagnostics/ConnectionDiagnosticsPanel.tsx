import { AppIcon } from "../../components/AppIcon";
import { useState } from "react";
import type { FastCaptureBackend } from "../../../shared/types";
import type { ConnectionDiagnosticReport } from "../../../shared/connection-diagnostics";
import { EntryDialog } from "../../components/EntryDialog";
import { useConnectionDiagnostics, type ConnectionDiagnosticApi } from "./useConnectionDiagnostics";
import "./connection-diagnostics.css";

const statusLabels = { pass: "通过", fail: "需处理", unknown: "未知" };
const resultLabels = { ready: "必需检查已通过", blocked: "有必需项需要处理", unknown: "尚不能确认采集条件" };
const terminalLabels = { completed: "诊断完成", timed_out: "诊断超时", cancelled: "诊断已取消", identity_changed: "设备或 App 已变化" };

export function ConnectionDiagnosticResults({ report }: { report: ConnectionDiagnosticReport }) {
  return <div className="connection-diagnostic-results">
    <div className={`connection-diagnostic-result ${report.outcome}`} role="status" aria-live="polite">
      <strong>{report.status === "completed" ? resultLabels[report.outcome] : terminalLabels[report.status]}</strong>
      <span>{(report.elapsedMs / 1000).toFixed(1)} 秒 · {new Date(report.completedAt).toLocaleString()}</span>
    </div>
    <p className="connection-diagnostic-identity">设备：{report.serial}<br />App：{report.expectedPackageName ?? report.identity.packageName ?? "未确认"}
      {report.identity.component && <><br />窗口：{report.identity.component}</>}</p>
    {report.status !== "completed" && <p className="connection-diagnostic-note">本轮检查未完整结束，请保持当前设备和目标页面稳定后重新诊断。</p>}
    <ul className="connection-diagnostic-checks">{report.checks.map(check => <li key={check.id} className={check.status}>
      <div className="connection-diagnostic-check-heading"><strong>{check.label}</strong><span>{check.required ? "必需" : "可选"} · {statusLabels[check.status]}</span></div>
      <p>{check.detail}</p>{check.suggestion && <p className="connection-diagnostic-suggestion">{check.suggestion}</p>}
    </li>)}</ul>
    <p className="connection-diagnostic-note">检查结果只说明当前连接条件，实际采集仍需手动发起。</p>
  </div>;
}

export function ConnectionDiagnosticsPanel({ open, onClose, serial, packageName, captureMode = "fast", backend = "uiautomator", api }: {
  open: boolean; onClose: () => void; serial: string | null; packageName?: string; captureMode?: "fast" | "deep";
  backend?: FastCaptureBackend; api?: ConnectionDiagnosticApi;
}) {
  const sourceKey = JSON.stringify([serial, packageName, captureMode, backend]);
  const [selection, setSelection] = useState<{ key: string; packageName: string; captureMode: "fast" | "deep"; backend: FastCaptureBackend } | null>(null);
  const values = selection?.key === sourceKey ? selection : { key: sourceKey, packageName: packageName ?? "", captureMode, backend };
  const target = open && serial ? { serial, packageName: values.packageName.trim() || undefined, captureMode: values.captureMode, backend: values.backend } : null;
  const diagnostic = useConnectionDiagnostics(target, api);
  const close = () => { diagnostic.cancel(); onClose(); };
  if (!open) return null;
  return <EntryDialog className="connection-diagnostic-dialog" labelledBy="connection-diagnostic-title" onClose={close}>
    <div className="entry-dialog-heading"><h2 id="connection-diagnostic-title">连接与采集诊断</h2>
      <button className="entry-dialog-close" type="button" onClick={close} aria-label="关闭诊断"><AppIcon name="close" size={14} /></button></div>
    <p className="connection-diagnostic-note">只检查当前状态，并给出处理提示。手机设置由你手动处理。</p>
    <p className="connection-diagnostic-identity">设备：{serial ?? "尚未选择"}</p>
    <label className="connection-diagnostic-field">目标 App 包名（可选）<input value={values.packageName} maxLength={256} placeholder="留空时检查当前前台 App"
      onChange={event => setSelection({ ...values, packageName: event.target.value })} /></label>
    <div className="connection-diagnostic-selections"><label className="connection-diagnostic-field">采集方式<select value={values.captureMode}
      onChange={event => setSelection({ ...values, captureMode: event.target.value as "fast" | "deep", backend: "uiautomator" })}>
      <option value="fast">轻量采集</option><option value="deep">深度采集</option></select></label>
      <label className="connection-diagnostic-field">轻量后端<select value={values.backend} disabled={values.captureMode === "deep"}
        onChange={event => setSelection({ ...values, backend: event.target.value as FastCaptureBackend })}>
        <option value="uiautomator">UIAutomator</option><option value="accessibility-helper">无障碍 Helper</option></select></label></div>
    <div className="connection-diagnostic-actions"><button className="close-button" type="button" disabled={!diagnostic.available || diagnostic.running} onClick={() => void diagnostic.run()}>
      {diagnostic.running ? "正在检查…" : "开始诊断"}</button>
      {diagnostic.running && <button className="close-button" type="button" onClick={diagnostic.cancel}>取消</button>}</div>
    {!api && <p className="connection-diagnostic-note">当前运行环境没有连接诊断服务。</p>}
    {diagnostic.message && <p className="connection-diagnostic-note" role="status">{diagnostic.message}</p>}
    {diagnostic.report && <ConnectionDiagnosticResults report={diagnostic.report} />}
  </EntryDialog>;
}
