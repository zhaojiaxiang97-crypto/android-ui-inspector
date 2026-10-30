import { useId, type CSSProperties } from "react";
import { measurementCardDiagram, measurementCardNumber, measurementCardPlacement, measurementCardRelationLabel,
  type MeasurementCardData } from "../../../shared/measurement-card";
import type { Rect } from "./types";
import "../../styles/measurement-card.css";

type Props = { data: MeasurementCardData | null; viewport: Rect; onClear: () => void };

export function MeasurementCard({ data, viewport, onClear }: Props) {
  const headingId = useId();
  const placement = measurementCardPlacement(viewport);
  const diagram = data ? measurementCardDiagram(data) : null;
  if (!data || !diagram || !placement) return null;
  const style: CSSProperties = { left: placement.left, top: placement.bottomEdge, width: placement.width, maxHeight: placement.maxHeight };
  const distances = data.measurement.guides.flatMap(guide => guide.distances);
  return <section className="measurement-card" style={style} role="region" aria-labelledby={headingId}
    data-measurement-anchor={data.anchor.id} data-measurement-target={data.target.id}
    onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onPointerMove={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      event.stopPropagation();
      const editing = event.target instanceof HTMLElement && Boolean(event.target.closest("input, textarea, select, [contenteditable=true]"));
      const releaseKey = event.key === "Escape" || (event.key.toLowerCase() === "m" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.repeat);
      if (!editing && releaseKey) { event.preventDefault(); onClear(); }
    }}>
    <header><h3 id={headingId}>二维测距</h3><button type="button" onClick={onClear} title="解除固定 · M 或 Esc">解除固定</button></header>
    <div className="measurement-card-pair">
      <p className="measurement-card-anchor" title={data.anchor.label}><b>A</b><span>{data.anchor.label}</span></p>
      <p className="measurement-card-target" title={data.target.label}><b>B</b><span>{data.target.label}</span></p>
    </div>
    <svg className="measurement-card-diagram" viewBox={`0 0 ${diagram.width} ${diagram.height}`} role="img"
      aria-label={`A ${data.anchor.label}，B ${data.target.label}，${measurementCardRelationLabel(data)}，按原始外框比例绘制`}>
      <rect className="measurement-card-shape measurement-card-anchor" {...diagram.anchor} />
      <rect className="measurement-card-shape measurement-card-target" {...diagram.target} />
      {diagram.guides.map(({ from, to }, index) => <path className="measurement-card-guide" key={index}
        d={`M ${from.x} ${from.y} H ${to.x} V ${to.y}`} />)}
    </svg>
    <p className="measurement-card-relation">{measurementCardRelationLabel(data)}</p>
    {distances.length > 0 ? <dl className="measurement-card-values">{distances.map(({ label, value }, index) => <div key={index}>
      <dt>{label}</dt><dd>{measurementCardNumber(value)} <span>px</span></dd>
    </div>)}</dl> : <p className="measurement-card-zero">间距 0 px</p>}
    <p className="measurement-card-alignment">{data.alignments.length ? data.alignments.join(" · ") : "各边与中心均未对齐"}</p>
    <p className="measurement-card-units">原始外框 · 屏幕 px</p>
  </section>;
}
