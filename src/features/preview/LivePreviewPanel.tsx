import { useMemo, useState } from "react";
import { livePreviewStatusText, livePreviewTimeLabel, type LivePreviewApi } from "../../../shared/live-preview";
import { useLivePreview } from "./useLivePreview";
import "./live-preview.css";

export type LivePreviewPanelProps = {
  serial: string;
  connected: boolean;
  treeCapturedAt: string | null;
  enabled?: boolean;
  onClose?: () => void;
  api?: LivePreviewApi;
};

export function LivePreviewPanel({ serial, connected, treeCapturedAt, enabled = false, onClose, api }: LivePreviewPanelProps) {
  const opening = useMemo(() => ({}), [serial, enabled]);
  const [dismissed, setDismissed] = useState<object | null>(null);
  const active = enabled && dismissed !== opening;
  const preview = useLivePreview({ serial, connected, enabled: active, api });
  const [failedImage, setFailedImage] = useState<string | null>(null);
  if (!active) return null;
  const paused = preview.state?.status === "paused";
  const stopped = !preview.state || preview.state.status === "stopped";
  const imageFailed = preview.frame?.screenshotDataUrl === failedImage;
  const status = connected ? preview.state ? livePreviewStatusText(preview.state)
    : preview.pending ? "正在开启…" : "已关闭" : "设备已断开";
  return <section className="live-preview-panel" aria-label="2D 实时预览">
    <header className="live-preview-header">
      <div className="live-preview-heading"><h4>2D 实时预览</h4><span title={serial}>{serial}</span></div>
      <button type="button" className="live-preview-close" aria-label="关闭实时预览" title="关闭实时预览"
        onClick={() => { setDismissed(opening); onClose?.(); }}>×</button>
    </header>
    <div className="live-preview-status-row">
      <span className={`live-preview-status${paused || stopped || !connected ? " is-inactive" : ""}`} role="status">{status}</span>
      {stopped ? <button type="button" onClick={preview.start} disabled={!connected || !preview.supported || preview.pending}>重新开启</button>
        : <button type="button" onClick={() => void (paused ? preview.resume() : preview.pause())}
          disabled={preview.pending}>{paused ? "继续" : "暂停"}</button>}
    </div>
    <figure className="live-preview-image">
      {preview.frame && !imageFailed ? <img src={preview.frame.screenshotDataUrl} alt="当前设备的实时画面，仅供观察"
        draggable={false} onError={() => { setFailedImage(preview.frame!.screenshotDataUrl); void preview.pause(); }} />
        : <figcaption>{!connected ? "设备断开，采集已停止" : imageFailed ? "截图无法显示，请继续重试"
          : preview.error ? "暂时无法读取画面" : preview.pending || preview.state?.status === "running" ? "等待第一帧画面…" : "预览已停止"}</figcaption>}
    </figure>
    <dl className="live-preview-times">
      <div><dt>预览更新</dt><dd><time dateTime={preview.state?.frameCapturedAt ?? undefined}>{livePreviewTimeLabel(preview.state?.frameCapturedAt)}</time></dd></div>
      <div><dt>控件树更新</dt><dd><time dateTime={treeCapturedAt ?? undefined}>{livePreviewTimeLabel(treeCapturedAt)}</time></dd></div>
    </dl>
    {(preview.error || preview.state?.error) && <p className="live-preview-error" role="alert">{preview.error ?? preview.state?.error}</p>}
    <p className="live-preview-note">画面仅供观察。控件操作和验收仍使用已采集的树。</p>
  </section>;
}
