import { AppIcon } from "./AppIcon";
import type { UiSnapshot } from "../../shared/types";
import { captureFeedback, type CaptureFailureRecord } from "../../shared/capture-feedback";

export function CaptureFailureFeedback({ snapshot, error, onRetry, canRetry }: {
  snapshot: UiSnapshot | null; error: string; onRetry: () => void; canRetry: boolean;
}) {
  const feedback = captureFeedback(snapshot, error);
  return <div className="workspace-empty-copy error-placeholder capture-failure-feedback">
    <AppIcon name="alert" size={36} className="error-mark" />
    <h4 role="status" aria-live="polite">{feedback.title}</h4>
    <p>{feedback.hint}</p>
    {feedback.timing.length > 0 && <ul className="capture-failure-timing">{feedback.timing.map(text => <li key={text}>{text}</li>)}</ul>}
    <button className="tree-clear capture-retry" type="button" onClick={onRetry} disabled={!canRetry}>重新采集</button>
    <span className="tree-hint">只在点击后发起新请求，不会自动重试。</span>
    <details className="capture-failure-detail"><summary>技术原因</summary><p>{error}</p></details>
  </div>;
}

export function CaptureFailureHistory({ records }: { records: CaptureFailureRecord[] }) {
  if (!records.length) return null;
  return <details className="capture-failure-history">
    <summary>本次会话的失败记录 · {records.length}</summary>
    <ol>{records.map((record, index) => {
      const feedback = captureFeedback({ serial: record.serial, error: record.error, root: null, nodeCount: 0,
        xmlSize: 0, rawXml: null, screenshotDataUrl: null, warning: null,
        ...(record.readiness ? { captureReadiness: record.readiness } : {}) }, record.error);
      return <li key={`${record.requestId}-${record.attempt}-${index}`}>
        <strong>{feedback.title}</strong><span>请求 {record.requestId.slice(0, 8)} · 第 {record.attempt} 次尝试</span>
        {feedback.timing.length > 0 && <p>{feedback.timing.join(" · ")}</p>}<p>{record.error}</p>
      </li>;
    })}</ol>
  </details>;
}
