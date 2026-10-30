import type { MouseEvent } from "react";
import "../styles/long-text-value.css";

export type LongTextValueProps = {
  value: string;
  label: string;
  onCopyValue?: (label: string, value: string) => void;
  className?: string;
};

export function isLongTextValue(value: string) {
  return value.length > 120 || value.split(/\r\n|\r|\n/).length > 3;
}

export function LongTextValue({ value, label, onCopyValue, className = "" }: LongTextValueProps) {
  const long = isLongTextValue(value);
  // A value inside a business-tree summary must remain selectable without toggling its branch.
  const keepReading = (event: MouseEvent<HTMLElement>) => { event.stopPropagation(); event.preventDefault(); };
  const text = <span className={`${long ? "" : className} long-text-content`.trim()}
    tabIndex={long ? 0 : undefined} role={long ? "region" : undefined} aria-label={long ? `${label}完整值` : undefined}
    onClick={keepReading}>{value}</span>;
  if (!long) return text;
  return <div className={`${className} long-text-value`.trim()} onClick={keepReading}>
    {text}
    {onCopyValue && <button className="inspector-field-copy" type="button" aria-label={`复制${label}`} title={`复制完整${label}`}
      onClick={event => { keepReading(event); onCopyValue(label, value); }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
        <rect x="5" y="5" width="8" height="8" rx="1" /><path d="M10 3H3v7" />
      </svg>
    </button>}
  </div>;
}
