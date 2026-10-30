import { useRef, type RefObject } from "react";
import { clampFloatingInspectorRect } from "../../shared/workspace-layout";
import "../styles/workspace-layout.css";

export function FloatingInspectorResize({ panelRef, onSave }: {
  panelRef: RefObject<HTMLElement | null>;
  onSave: () => void;
}) {
  const drag = useRef<{ pointer: number; x: number; y: number; width: number; height: number } | null>(null);
  const resize = (width: number, height: number) => {
    const panel = panelRef.current, workspace = panel?.parentElement;
    if (!panel || !workspace) return;
    const shown = clampFloatingInspectorRect({ left: panel.offsetLeft, top: panel.offsetTop, width, height }, {
      width: workspace.clientWidth,
      height: Number.parseFloat(panel.style.getPropertyValue("--inspector-viewport-height")) || workspace.clientHeight,
      minTop: Number.parseFloat(panel.style.getPropertyValue("--inspector-min-top")) || 12,
    });
    panel.style.width = `${shown.width}px`; panel.style.height = `${shown.height}px`;
    panel.style.left = `${shown.left}px`; panel.style.right = "auto";
    panel.style.setProperty("--inspector-top", `${shown.top}px`);
  };
  return <button type="button" className="inspector-resize-handle" aria-label="调整属性浮窗大小"
    title="拖动调整大小 · 方向键微调 · Home恢复默认尺寸"
    onPointerDown={event => {
      const panel = panelRef.current;
      if (event.button !== 0 || !panel) return;
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
      drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, width: panel.offsetWidth, height: panel.offsetHeight };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (start?.pointer === event.pointerId) resize(start.width + event.clientX - start.x, start.height + event.clientY - start.y);
    }}
    onPointerUp={event => {
      if (drag.current?.pointer !== event.pointerId) return;
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      onSave();
    }}
    onPointerCancel={() => { if (drag.current) { drag.current = null; onSave(); } }}
    onLostPointerCapture={() => { if (drag.current) { drag.current = null; onSave(); } }}
    onKeyDown={event => {
      const panel = panelRef.current;
      if (!panel || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Home") { panel.style.removeProperty("width"); panel.style.removeProperty("height"); resize(panel.offsetWidth, panel.offsetHeight); }
      else {
        const step = event.shiftKey ? 40 : 10;
        resize(panel.offsetWidth + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
          panel.offsetHeight + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0));
      }
      onSave();
    }}>
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 13 8-8M9 13l4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
  </button>;
}
