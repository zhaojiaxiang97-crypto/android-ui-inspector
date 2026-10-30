import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/continuous-zoom.css";

export function ContinuousZoom({ value, min, max, disabled, onChange }: {
  value: number; min: number; max: number; disabled: boolean; onChange: (value: number) => void;
}) {
  const id = useId(), details = useRef<HTMLDetailsElement>(null), popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 });
  const close = () => { if (details.current) details.current.open = false; };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = details.current!.getBoundingClientRect(), body = popup.current;
      if (!body) return;
      const toolbar = details.current!.closest(".screenshot-view-toolbar")?.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - body.offsetWidth - 8));
      const top = Math.max(8, Math.min((toolbar?.bottom ?? rect.bottom) + 8, window.innerHeight - body.offsetHeight - 8));
      setPosition({ left, top });
    };
    place();
    popup.current?.querySelector("input")?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !details.current?.contains(event.target) && !popup.current?.contains(event.target)) close();
    };
    const blur = () => { popup.current?.querySelector("input")?.blur(); close(); };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("pointerdown", outside, true); window.removeEventListener("blur", blur); };
  }, [open]);
  useEffect(() => { if (disabled) close(); }, [disabled]);

  return <details ref={details} className="zoom-continuous" onToggle={event => setOpen(event.currentTarget.open)}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === "Escape" && details.current?.open) {
        event.preventDefault(); event.stopPropagation(); close(); details.current.querySelector("summary")?.focus();
      }
    }}>
    <summary className="zoom-continuous-toggle" aria-label="连续缩放" aria-controls={id} aria-expanded={open}
      aria-disabled={disabled} title="展开连续缩放；方向键按 1% 微调" onClick={event => { if (disabled) event.preventDefault(); }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M2 5h12M2 11h12" /><circle cx="6" cy="5" r="2" fill="var(--ref-panel)" /><circle cx="10" cy="11" r="2" fill="var(--ref-panel)" /></svg>
    </summary>
    {open && createPortal(<div ref={popup} id={id} className="zoom-continuous-popup" role="group" aria-label="连续缩放设置" style={position}>
      <label htmlFor={`${id}-range`}>连续缩放 <output>{Math.round(value * 100)}%</output></label>
      <input id={`${id}-range`} type="range" aria-label="截图连续倍率" aria-valuetext={`${Math.round(value * 100)}%`}
        min={min * 100} max={max * 100} step={1} value={value * 100} disabled={disabled}
        onInput={event => onChange(Number(event.currentTarget.value) / 100)} />
      <div className="zoom-continuous-limits"><span>{min * 100}%</span><span>{max * 100}%</span></div>
      <p>拖动调整 · 方向键微调 · Esc 收起</p>
    </div>, document.body)}
  </details>;
}
