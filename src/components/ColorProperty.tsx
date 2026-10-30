import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { COLOR_FORMAT_LABELS, DEFAULT_COLOR_FORMAT, inspectorColorDisplay, type ColorDisplayFormat } from "../../shared/color-display";
import type { ColorAliasPreference, InspectorColorEncoding } from "../../shared/inspector-colors";
import "../styles/color-display.css";

export function ColorProperty({ label, raw, encoding, aliases, onCopy, fallback = "—", format = DEFAULT_COLOR_FORMAT, search = "", revealRevision, scope }: {
  label: string; raw: string | null | undefined; encoding?: InspectorColorEncoding;
  aliases: ColorAliasPreference; onCopy?: (label: string, value: string) => void; fallback?: string;
  format?: ColorDisplayFormat; search?: string; revealRevision?: number;
  scope?: object | string | null;
}) {
  const display = inspectorColorDisplay(raw, encoding, format, aliases), { color, values, alias } = display;
  const [expanded, setExpanded] = useState(false), [foldedSearch, setFoldedSearch] = useState<string | null>(null);
  const source = { scope, label, raw, encoding, aliases };
  const current = useRef({ ...source, onCopy }); current.current = { ...source, onCopy };
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [menuSource, setMenuSource] = useState<typeof source | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0, width: 230 });
  const sameSource = (value: typeof source) => value.scope === current.current.scope && value.label === current.current.label
    && value.raw === current.current.raw && value.encoding === current.current.encoding && value.aliases === current.current.aliases;
  const menuOpen = menuSource !== null && sameSource(menuSource);
  const closeMenu = (restoreFocus = false) => {
    setMenuSource(null);
    if (restoreFocus && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  };
  useLayoutEffect(() => { setMenuSource(null); }, [scope, label, raw, encoding, aliases]);
  useLayoutEffect(() => {
    if (!menuOpen || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect(), width = Math.min(230, window.innerWidth - 20);
    const height = menu.current.getBoundingClientRect().height;
    setMenuPosition({ width, left: Math.max(10, Math.min(window.innerWidth - width - 10, rect.left)),
      top: rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 4 : Math.max(10, rect.top - height - 4) });
    (menu.current.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? menu.current).focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) closeMenu();
    };
    const blur = () => closeMenu();
    document.addEventListener("pointerdown", outside, true); document.addEventListener("focusin", outside, true);
    window.addEventListener("blur", blur); window.addEventListener("resize", blur);
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) closeMenu(); };
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside, true);
      window.removeEventListener("blur", blur); window.removeEventListener("resize", blur); document.removeEventListener("scroll", scroll, true);
    };
  }, [menuOpen]);
  useEffect(() => setFoldedSearch(null), [search, revealRevision]);
  const terms = [label, ...Object.values(values), alias, "颜色 Hex RGBA 原值 透明度", display.sourceLabel].filter(Boolean).join(" ");
  const searching = search.trim() && terms.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) ? search : null;
  const open = searching ? foldedSearch !== searching : expanded;
  const copyLabel = (valueFormat: ColorDisplayFormat) => `${label}${valueFormat === "raw" ? "" : " "}${COLOR_FORMAT_LABELS[valueFormat]}`;
  const copyValue = (valueFormat: ColorDisplayFormat) => {
    if (sameSource(source) && values[valueFormat]) current.current.onCopy?.(copyLabel(valueFormat), values[valueFormat]);
  };
  const copy = (valueFormat: ColorDisplayFormat) => onCopy && values[valueFormat] ? <button type="button"
    aria-label={`复制${copyLabel(valueFormat)}`} title={`复制 ${values[valueFormat]}${valueFormat === "hex" && !display.exactHex ? "（透明度近似）" : ""}`}
    onClick={() => copyValue(valueFormat)}>复制 {COLOR_FORMAT_LABELS[valueFormat]}</button> : null;
  return <div className="inspector-color-property" data-color-label={label} data-color-valid={Boolean(color)}
    data-inspector-value={raw ?? undefined} data-inspector-terms={terms}>
    <dt>{label}</dt><dd>
      <div className="inspector-color-heading">
        {color && <button ref={trigger} type="button" className="inspector-color-swatch inspector-color-menu-trigger" aria-label={`${label}色块，透明度保留；打开复制菜单`}
          aria-haspopup="menu" aria-expanded={menuOpen} title={`${values.rgba} · 点击复制颜色`} onClick={() => setMenuSource(menuOpen ? null : source)}>
          <span style={{ backgroundColor: values.rgba }} />
        </button>}
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
      {!color && raw && onCopy && <button ref={trigger} className="inspector-color-menu-entry" type="button" aria-label={`${label}原值复制菜单`}
        aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuSource(menuOpen ? null : source)}>原值菜单</button>}
    </dd>
    {menuOpen && createPortal(<div ref={menu} className="inspector-color-copy-menu" role="menu" tabIndex={-1} aria-label={`${label}颜色复制`}
      style={menuPosition} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          if (["Escape", "Enter", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) event.preventDefault();
          return;
        }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && buttons.length) {
          event.preventDefault(); event.stopPropagation(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
          buttons[next].focus();
        }
      }}>
      <p>{label} · {display.sourceLabel}</p>
      {alias && <p>{alias}</p>}
      {color && <p>透明度 {Math.round(color.alpha * 10000) / 100}%{!display.exactHex && " · Hex 透明度近似"}</p>}
      {(color ? ["hex", "rgba", "raw"] as const : ["raw"] as const).map(valueFormat => <button key={valueFormat} type="button" role="menuitem" disabled={!onCopy}
        title={values[valueFormat]} onClick={() => { copyValue(valueFormat); closeMenu(true); }}>
        <span>复制 {COLOR_FORMAT_LABELS[valueFormat]}{valueFormat === "hex" && !display.exactHex ? " ≈" : ""}</span><code>{values[valueFormat]}</code>
      </button>)}
    </div>, document.body)}
  </div>;
}
