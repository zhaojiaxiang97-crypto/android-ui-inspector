import type { NodePresentationFact, NodePresentationStatus as PresentationStatus } from "../../shared/node-presentation-status";
import "../styles/node-presentation-status.css";

export function NodeStatusBadge({ status }: { status: PresentationStatus }) {
  if (!status.badgeLabel) return null;
  const explanation = `${status.label}：${status.detail}`;
  return <span className="node-status-badge" data-node-status={status.code} data-tone={status.tone}
    title={explanation} aria-label={explanation}>{status.badgeLabel}</span>;
}

function StatusFact({ value, label, status }: { value: NodePresentationFact; label: string; status: PresentationStatus }) {
  return <div className="node-presentation-fact" data-node-status={value.code} data-tone={value.tone}>
    <div className="inspector-image-state node-presentation-state" data-state={status.imageStatus} data-empty={status.imageEmpty}
      data-inspector-label={label} data-inspector-value={value.label} data-inspector-terms={`${status.imageStatus ?? "未采集"} ${value.code} 独立画面 自身图 绘制方式 ${value.label}`}>
      <span>{label}</span><strong>{value.label}</strong>
    </div>
    <p className="inspector-image-note node-presentation-detail" data-inspector-label="画面状态" data-inspector-value={value.detail}>{value.detail}</p>
  </div>;
}

export function NodePresentationStatus({ status }: { status: PresentationStatus }) {
  const sameOwn = status.code === status.ownImage.code && status.label === status.ownImage.label && status.detail === status.ownImage.detail;
  const samePresentation = status.presentation?.code === status.code;
  const currentLabel = status.code === "user-hidden" || status.code === "device-hidden" ? "显示状态"
    : ["group", "composite", "outline"].includes(status.code) ? "当前图层" : "自身画面";
  return <section className="node-presentation-status" aria-label="控件画面状态">
    <StatusFact value={status} label={currentLabel} status={status} />
    {!sameOwn && <StatusFact value={status.ownImage} label="自身画面" status={status} />}
    {status.presentation && !samePresentation && <StatusFact value={status.presentation} label="当前图层" status={status} />}
  </section>;
}
