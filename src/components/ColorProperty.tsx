import { useEffect, useState } from "react";
import { COLOR_FORMAT_LABELS, DEFAULT_COLOR_FORMAT, inspectorColorDisplay, type ColorDisplayFormat } from "../../shared/color-display";
import type { ColorAliasPreference, InspectorColorEncoding } from "../../shared/inspector-colors";
import "../styles/color-display.css";

export function ColorProperty({ label, raw, encoding, aliases, onCopy, fallback = "—", format = DEFAULT_COLOR_FORMAT, search = "", revealRevision }: {
  label: string; raw: string | null | undefined; encoding?: InspectorColorEncoding;
  aliases: ColorAliasPreference; onCopy?: (label: string, value: string) => void; fallback?: string;
  format?: ColorDisplayFormat; search?: string; revealRevision?: number;
}) {
  const display = inspectorColorDisplay(raw, encoding, format, aliases), { color, values, alias } = display;
  const [expanded, setExpanded] = useState(false), [foldedSearch, setFoldedSearch] = useState<string | null>(null);
  useEffect(() => setFoldedSearch(null), [search, revealRevision]);
  const terms = [label, ...Object.values(values), alias, "颜色 Hex RGBA 原值 透明度", display.sourceLabel].filter(Boolean).join(" ");
  const searching = search.trim() && terms.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) ? search : null;
  const open = searching ? foldedSearch !== searching : expanded;
  const copyLabel = (valueFormat: ColorDisplayFormat) => `${label}${valueFormat === "raw" ? "" : " "}${COLOR_FORMAT_LABELS[valueFormat]}`;
  const copy = (valueFormat: ColorDisplayFormat) => onCopy && values[valueFormat] ? <button type="button"
    aria-label={`复制${copyLabel(valueFormat)}`} title={`复制 ${values[valueFormat]}${valueFormat === "hex" && !display.exactHex ? "（透明度近似）" : ""}`}
    onClick={() => onCopy(copyLabel(valueFormat), values[valueFormat])}>复制 {COLOR_FORMAT_LABELS[valueFormat]}</button> : null;
  return <div className="inspector-color-property" data-color-label={label} data-color-valid={Boolean(color)}
    data-inspector-value={raw ?? undefined} data-inspector-terms={terms}>
    <dt>{label}</dt><dd>
      <div className="inspector-color-heading">
        {color && <span className="inspector-color-swatch" role="img" aria-label={`${label}色块，透明度保留`} title={values.rgba}>
          <span style={{ backgroundColor: values.rgba }} />
        </span>}
        <span className="inspector-color-value" title={display.approximate ? "Hex 的透明度已取最近的 8 位值；RGBA 保留原始精度" : `${display.label} · ${display.sourceLabel}`}>
          {display.approximate && "≈ "}{display.value || fallback}
        </span>
      </div>
      {alias && <div className="inspector-color-alias" title="本机配置的精确颜色别名">{alias}</div>}
      {onCopy && display.value && <div className="inspector-color-actions">{copy(display.format)}</div>}
      {color && <details className="inspector-color-details" open={open} onClick={event => {
        if ((event.target as Element).closest("summary")?.parentElement !== event.currentTarget) return;
        event.preventDefault(); if (searching) setFoldedSearch(open ? searching : null); else setExpanded(!open);
      }}>
        <summary>其他格式与原值</summary>
        {(Object.keys(COLOR_FORMAT_LABELS) as ColorDisplayFormat[]).filter(value => value !== display.format).map(value =>
          <div key={value} className="inspector-color-detail-value"><span>{COLOR_FORMAT_LABELS[value]}{value === "hex" && !display.exactHex ? " ≈" : ""}</span>
            <code>{values[value]}</code><div className="inspector-color-actions">{copy(value)}</div></div>)}
        <div className="inspector-color-raw">原值来源：{display.sourceLabel}</div>
        <div className="inspector-color-alpha">透明度 {Math.round(color.alpha * 10000) / 100}%</div>
      </details>}
      {!color && raw && <div className="inspector-color-raw">{encoding ? "无法解析，保留原值" : "来源未确认，保留原值"}</div>}
    </dd>
  </div>;
}
