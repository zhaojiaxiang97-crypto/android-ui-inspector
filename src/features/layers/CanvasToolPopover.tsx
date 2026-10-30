import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// All three canvas tools share the same portal boundary and dismissal rules.
export function CanvasToolPopover({ className, bodyClassName, label, bodyLabel = label, summary, summaryClassName, title = label, open, disabled = false, onOpenChange, children }: {
  className: string; bodyClassName: string; label: string; bodyLabel?: string; summary: ReactNode; summaryClassName?: string; title?: string;
  open: boolean; disabled?: boolean; onOpenChange: (open: boolean) => void; children: ReactNode;
}) {
  const id = useId(), details = useRef<HTMLDetailsElement>(null), popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8, maxHeight: 400 });
  const changeRef = useRef(onOpenChange);
  changeRef.current = onOpenChange;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = details.current, body = popup.current;
      if (!trigger || !body) return;
      const rect = trigger.getBoundingClientRect();
      const toolbar = trigger.closest(".screenshot-view-toolbar")?.getBoundingClientRect();
      const header = trigger.closest(".inspection-header")?.getBoundingClientRect();
      const top = Math.max(8, Math.min(Math.max(rect.bottom, toolbar?.bottom ?? 0, header?.bottom ?? 0) + 8, innerHeight - 80));
      setPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - body.offsetWidth - 8)), top, maxHeight: Math.max(64, innerHeight - top - 8) });
    };
    place();
    (popup.current?.querySelector<HTMLElement>("input, select, button") ?? popup.current)?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !details.current?.contains(event.target) && !popup.current?.contains(event.target)) changeRef.current(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector("dialog[open]")) return;
      // A numeric draft consumes the first Escape before this tool closes.
      if (event.target instanceof HTMLElement && popup.current?.contains(event.target) && event.target.dataset.canvasDraft === "true") return;
      event.preventDefault(); event.stopPropagation();
      changeRef.current(false);
      details.current?.querySelector("summary")?.focus({ preventScroll: true });
    };
    const blur = () => { if (popup.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur(); changeRef.current(false); };
    const modal = () => { if (document.querySelector("dialog[open]")) changeRef.current(false); };
    const observer = new MutationObserver(modal);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    modal();
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    return () => { observer.disconnect(); window.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", key, true); window.removeEventListener("blur", blur); };
  }, [open]);
  useLayoutEffect(() => { if (disabled && open) changeRef.current(false); }, [disabled, open]);

  return <details ref={details} className={className} open={open}>
    <summary className={summaryClassName} aria-label={label} aria-controls={id} aria-expanded={open} aria-disabled={disabled} title={title}
      onClick={event => { event.preventDefault(); if (!disabled && !document.querySelector("dialog[open]")) onOpenChange(!open); }}>{summary}</summary>
    {open && createPortal(<div ref={popup} id={id} className={`${bodyClassName} canvas-tool-popup`} role="group" aria-label={bodyLabel} tabIndex={-1} style={position}>{children}</div>, document.body)}
  </details>;
}
