import { useEffect, useLayoutEffect, useRef } from "react";
import { CONTEXT_HINTS, type ContextHintId } from "../../shared/context-hints";
import "../styles/context-hint.css";

type HintEscapeEvent = { key: string; defaultPrevented: boolean; preventDefault: () => void;
  stopPropagation: () => void; stopImmediatePropagation?: () => void };

/** Call before the scene's Escape handlers, including window capture listeners. */
export function dismissVisibleContextHint(event: HintEscapeEvent): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return false;
  const hint = document.querySelector<HTMLElement>('[data-context-hint-visible="true"]');
  const close = hint?.querySelector<HTMLButtonElement>(".context-hint-dismiss");
  if (!hint || !close || hint.inert || hint.getAttribute("aria-hidden") === "true" || !hint.getClientRects().length
    || document.visibilityState === "hidden" || getComputedStyle(hint).visibility === "hidden") return false;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  close.click();
  return true;
}

export function ContextHint({ hint, suspended = false, onShown, onDismiss }: {
  hint: ContextHintId | null; suspended?: boolean;
  onShown: (id: ContextHintId) => void; onDismiss: (id: ContextHintId) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const content = CONTEXT_HINTS.find(item => item.id === hint);

  useLayoutEffect(() => {
    const node = element.current;
    if (!node || !hint) return;
    if (suspended) { delete node.dataset.contextHintVisible; return; }
    let intersecting = false;
    let frame: number | null = null;
    const check = () => {
      frame = null;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const visible = intersecting && node.isConnected && document.visibilityState !== "hidden" && !document.querySelector("dialog[open]")
        && rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      if (visible) { node.dataset.contextHintVisible = "true"; onShown(hint); }
      else delete node.dataset.contextHintVisible;
    };
    const changed = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    };
    const observer = new ResizeObserver(changed);
    // A clipped or offscreen row has not taught the user anything yet.
    const intersection = new IntersectionObserver(entries => {
      intersecting = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= .95);
      changed();
    }, { threshold: [.95] });
    observer.observe(node);
    intersection.observe(node);
    document.addEventListener("visibilitychange", changed);
    changed();
    return () => {
      observer.disconnect(); intersection.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", changed);
      delete node.dataset.contextHintVisible;
    };
  }, [hint, suspended, onShown]);

  useEffect(() => {
    if (!hint || suspended) return;
    const dismiss = (event: KeyboardEvent) => { dismissVisibleContextHint(event); };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [hint, suspended]);

  if (!hint || !content) return null;
  return <div ref={element} className="context-hint" data-context-hint={hint} aria-hidden={suspended || undefined} inert={suspended}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <span className="context-hint-icon" aria-hidden="true">i</span>
    <p role="status">{content.text}</p>
    <button type="button" className="context-hint-dismiss" aria-label="关闭操作提示" title="关闭操作提示 · Esc"
      onClick={() => onDismiss(hint)}>知道了</button>
  </div>;
}
