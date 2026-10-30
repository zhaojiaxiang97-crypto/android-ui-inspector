import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_INSPECTOR_GROUPS, INSPECTOR_GROUPS, type InspectorGroupId, type InspectorGroupPreference } from "../../shared/inspector-groups";
import "../styles/inspector-group-controls.css";

type Props = {
  preference: InspectorGroupPreference;
  onSave?: (value: InspectorGroupPreference) => boolean;
  onOpenPreferences?: () => void;
  group?: InspectorGroupId;
  scope?: object | string | number;
  disabled?: boolean;
  searching?: boolean;
};
const OPEN_EVENT = "inspector-group-popover-open";
const SEARCH_HINT = "先清除属性搜索，再隐藏分组；恢复显示仍可用。";

export function InspectorGroupControls(props: Props) {
  const { preference, onSave, onOpenPreferences, group, scope, disabled = false, searching = false } = props;
  const id = useId(), opener = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const current = useRef(props); current.current = props;
  const restoreFocus = useRef(false);
  const composing = useRef(false), [reading, setReading] = useState<{ scope: Props["scope"] } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 248, maxHeight: 400 });
  const label = INSPECTOR_GROUPS.find(item => item.id === group)?.label;
  const open = Boolean(reading && reading.scope === scope && !disabled);
  function close(returnFocus = false) {
    setReading(null); composing.current = false;
    restoreFocus.current = returnFocus;
  }
  function focusOpener() {
    if (document.querySelector("dialog[open]")) return;
    const button = opener.current;
    const target = button?.isConnected && !button.disabled && button.getClientRects().length ? button
      : button?.closest(".floating-inspector")?.querySelector<HTMLButtonElement>(".inspector-groups-open");
    target?.focus({ preventScroll: true });
  }
  function sourceCurrent() {
    return open && reading?.scope === current.current.scope && !current.current.disabled;
  }
  function save(value: InspectorGroupPreference, hide = false) {
    const latest = current.current;
    if (!sourceCurrent() || !latest.onSave || (hide && latest.searching)) return;
    const saved = latest.onSave(value);
    setStatus(saved ? "属性分组已保存并生效。" : "已应用到本次窗口，但本机保存失败；重开后可能丢失。");
    if (group) close(true);
  }
  function setVisible(target: InspectorGroupId, visible: boolean) {
    const latest = current.current.preference;
    save({ ...latest, hidden: visible ? latest.hidden.filter(item => item !== target) : [...latest.hidden, target] }, !visible);
  }
  useLayoutEffect(() => {
    if (!open) {
      if (reading) setReading(null);
      if (restoreFocus.current) { restoreFocus.current = false; focusOpener(); }
      return;
    }
    const place = () => {
      const anchor = opener.current?.getBoundingClientRect(), element = popup.current;
      if (!anchor || !element) return;
      const pane = opener.current?.closest(".floating-inspector")?.getBoundingClientRect();
      const width = Math.min(Math.max(224, pane?.width ?? 248), 306, innerWidth - 16);
      const below = innerHeight - anchor.bottom - 12, above = anchor.top - 12;
      const maxHeight = Math.max(0, Math.min(480, Math.max(below, above)));
      const height = Math.min(element.scrollHeight, maxHeight);
      const top = below >= Math.min(240, maxHeight) ? anchor.bottom + 4 : Math.max(8, anchor.top - height - 4);
      setPosition({ left: Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8)), top, width,
        maxHeight: Math.max(0, Math.min(maxHeight, innerHeight - top - 8)) });
    };
    place();
    (popup.current?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)") ?? popup.current)?.focus({ preventScroll: true });
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !opener.current?.contains(event.target) && !popup.current?.contains(event.target)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || composing.current || event.isComposing || event.keyCode === 229 || document.querySelector("dialog[open]")) return;
      event.preventDefault(); event.stopPropagation(); close(true);
    };
    const blur = () => close();
    const another = (event: Event) => { if ((event as CustomEvent).detail !== id) close(); };
    const modal = () => { if (document.querySelector("dialog[open]")) close(); };
    const observer = new MutationObserver(modal);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] }); modal();
    window.addEventListener("pointerdown", outside, true); window.addEventListener("focusin", outside);
    window.addEventListener("keydown", key, true); window.addEventListener("blur", blur); window.addEventListener(OPEN_EVENT, another);
    return () => {
      observer.disconnect(); window.removeEventListener("pointerdown", outside, true); window.removeEventListener("focusin", outside);
      window.removeEventListener("keydown", key, true); window.removeEventListener("blur", blur); window.removeEventListener(OPEN_EVENT, another);
    };
  }, [open]);
  return <>
    <button ref={opener} type="button" className={group ? "inspector-group-manage" : "inspector-groups-open"} data-inspector-group-control="true"
      disabled={disabled} aria-label={group ? `管理${label}分组` : "设置属性分组"} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      title={group ? `管理${label}分组` : `就地显示与隐藏属性分组${preference.hidden.length ? ` · 已隐藏 ${preference.hidden.length} 组` : ""}`}
      onClick={event => {
        event.preventDefault(); event.stopPropagation();
        if (disabled || document.querySelector("dialog[open]")) return;
        if (open) close(true);
        else { window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id })); setStatus(null); setReading({ scope }); }
      }}>{group ? <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="13" cy="8" r="1.3" /></svg>
        : <>分组{preference.hidden.length > 0 && <span className="inspector-group-hidden-count" aria-label={`已隐藏 ${preference.hidden.length} 组`}>{preference.hidden.length}</span>}</>}</button>
    {open && createPortal(<div ref={popup} id={id} className="inspector-group-popup" role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} tabIndex={-1} style={position}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
      <header><h3 id={`${id}-title`}>{group ? `${label}分组` : "属性分组"}</h3><button type="button" className="inspector-group-popup-close" aria-label="关闭属性分组管理" title="关闭 · Esc" onClick={() => close(true)}>×</button></header>
      {group ? <div className="inspector-group-popup-options"><button type="button" className="inspector-group-hide" disabled={!onSave || searching}
        title={searching ? SEARCH_HINT : undefined} aria-describedby={searching ? `${id}-help` : undefined} onClick={() => setVisible(group, false)}>隐藏此组</button></div>
        : <div className="inspector-group-popup-options" role="group" aria-label="属性分组显隐" aria-describedby={`${id}-help`}>
          {INSPECTOR_GROUPS.map(item => {
            const shown = !preference.hidden.includes(item.id), cannotHide = searching && shown;
            return <label key={item.id} title={cannotHide ? SEARCH_HINT : undefined}>
              <input type="checkbox" aria-label={`显示${item.label}`} checked={shown} disabled={!onSave || cannotHide}
                onChange={event => setVisible(item.id, event.currentTarget.checked)} />{item.label}
            </label>;
          })}
        </div>}
      <p id={`${id}-help`} className="inspector-group-popup-hint">{searching ? SEARCH_HINT : group ? "只隐藏这一大组；可从搜索旁的“分组”入口恢复。" : "勾选显示；隐藏不删除属性，搜索仍可查看。"}</p>
      <footer>{!group && <button type="button" className="inspector-group-reset" disabled={!onSave} onClick={() => save(DEFAULT_INSPECTOR_GROUPS)}>恢复默认</button>}
        {onOpenPreferences && <button type="button" className="inspector-group-more" onClick={() => {
          if (!sourceCurrent() || !current.current.onOpenPreferences) return;
          close(); current.current.onOpenPreferences();
        }}>更多设置…</button>}</footer>
      {!group && <p className="inspector-group-popup-status" role="status">{status ?? (!onSave ? "当前窗口不支持修改属性分组设置。" : "恢复默认会显示全部分组，并重置展开与折叠。")}</p>}
    </div>, document.body)}
  </>;
}
