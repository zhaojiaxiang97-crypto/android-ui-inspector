import { useState } from "react";
import type { ColorDisplayFormat } from "../../shared/color-display";
import type { ColorAliasPreference } from "../../shared/inspector-colors";
import type { PinnedNodeReference as Reference } from "../features/inspection/node-reference";
import { ColorProperty } from "./ColorProperty";
import "../styles/node-reference.css";

function time(value: string | number | undefined) {
  if (value === undefined) return null;
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : null;
}

export function PinnedNodeReference({ reference, status, format, aliases, onCopy, onClose }: {
  reference: Reference; status: "current" | "stale" | "detached"; format: ColorDisplayFormat;
  aliases: ColorAliasPreference; onCopy?: (label: string, value: string) => void; onClose: () => void;
}) {
  const [open, setOpen] = useState(true), captureTime = time(reference.snapshot.capturedAt);
  return <section className="inspector-pinned-reference" aria-label="固定属性参考" data-reference-node={reference.node.id}
    data-reference-status={status} onKeyDown={event => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
        event.preventDefault(); event.stopPropagation(); onClose();
      }
    }}>
    <div className="inspector-reference-heading">
      <button className="inspector-reference-disclosure" type="button" aria-expanded={open} aria-label={open ? "收起固定参考" : "展开固定参考"}
        onClick={() => setOpen(!open)} title={reference.name}><span aria-hidden="true">{open ? "▾" : "▸"}</span> 参考 · {reference.name}</button>
      <button className="inspector-reference-close" type="button" aria-label="关闭固定参考" title="关闭参考（Esc）" onClick={onClose}>×</button>
    </div>
    <p className="inspector-reference-status" role="status">{status === "current" ? "固定值 · 选择其他控件时保留" : status === "stale"
      ? "固定时的旧值 · 当前快照已局部刷新" : "固定时的旧值 · 原控件身份已无法确认"}</p>
    <div className="inspector-reference-values" hidden={!open}>
      <dl className="inspector-reference-geometry">{([['X', reference.geometry?.x], ['Y', reference.geometry?.y], ['W', reference.geometry?.width], ['H', reference.geometry?.height]] as const).map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd title={value === undefined ? "快照未提供有效尺寸" : "原始屏幕 px"}>{value ?? ""}</dd></div>)}</dl>
      {reference.text !== null && <div className="inspector-reference-text"><span>文本</span><pre>{reference.text}</pre>
        {onCopy && reference.text && <button type="button" onClick={() => onCopy("参考文本", reference.text!)}>复制参考文本</button>}</div>}
      {reference.colors.length > 0 && <dl className="inspector-property-list">{reference.colors.map(color =>
        <ColorProperty key={color.label} label={`参考${color.label}`} raw={color.raw} encoding={color.encoding} aliases={aliases} format={format} onCopy={onCopy} />)}</dl>}
      <p className="inspector-reference-source">{reference.snapshot.label || "当前快照"}{reference.snapshot.id ? ` · ${reference.snapshot.id}` : ""}<br />
        采集：{captureTime || "时间未提供"}<br />来源：{reference.source}<br />固定于：{time(reference.fixedAt)}
        {reference.styleReadAt !== null && <><br />已读取样式：{time(reference.styleReadAt)}</>}
      </p>
      {reference.colors.length > 0 && <p className="inspector-reference-source">{reference.colors.map(color => `${color.label}：${color.source}`).join("；")}</p>}
    </div>
  </section>;
}
