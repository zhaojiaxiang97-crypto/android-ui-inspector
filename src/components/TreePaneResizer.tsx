import { useEffect, useLayoutEffect, useRef } from "react";
import { DEFAULT_WORKSPACE_LAYOUT, treePaneWidthBounds } from "../../shared/workspace-layout";

export function TreePaneResizer({ width, onWidthChange }: { width?: number; onWidthChange?: (width: number) => void }) {
  const handleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const preferredWidth = useRef(width !== undefined && Number.isFinite(width) ? width : DEFAULT_WORKSPACE_LAYOUT.treeWidth);
  const onWidthChangeRef = useRef(onWidthChange);
  onWidthChangeRef.current = onWidthChange;

  function resize(width: number) {
    const handle = handleRef.current, grid = handle?.parentElement;
    if (!handle || !grid) return;
    const { min, max } = treePaneWidthBounds(grid.clientWidth, handle.offsetWidth);
    const next = Math.round(Math.max(min, Math.min(width, max)));
    grid.style.setProperty("--tree-pane-width", `${next}px`);
    handle.setAttribute("aria-valuenow", String(next));
    handle.setAttribute("aria-valuemax", String(max));
    handle.setAttribute("aria-valuemin", String(min));
    return next;
  }

  function commitWidth(next: number) {
    preferredWidth.current = next;
    onWidthChangeRef.current?.(next);
  }

  function endDrag() {
    const drag = dragRef.current, handle = handleRef.current;
    dragRef.current = null;
    handle?.parentElement?.classList.remove("is-resizing-tree");
    if (drag && handle?.hasPointerCapture(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
    if (drag && handle) commitWidth(Number(handle.getAttribute("aria-valuenow")));
  }

  useLayoutEffect(() => {
    if (width !== undefined && Number.isFinite(width)) preferredWidth.current = width;
    resize(preferredWidth.current);
  }, [width]);
  useEffect(() => {
    const handle = handleRef.current!, grid = handle.parentElement!;
    const observer = new ResizeObserver(() => resize(dragRef.current ? Number(handle.getAttribute("aria-valuenow")) : preferredWidth.current));
    observer.observe(grid);
    window.addEventListener("blur", endDrag);
    return () => { observer.disconnect(); window.removeEventListener("blur", endDrag); dragRef.current = null; grid.classList.remove("is-resizing-tree"); };
  }, []);

  return <div ref={handleRef} className="tree-pane-resizer" role="separator" tabIndex={0}
    aria-label="调整层级树宽度" aria-orientation="vertical" aria-controls="hierarchy-pane"
    aria-valuemin={240} aria-valuemax={720} aria-valuenow={306}
    title="拖动调整宽度 · 双击复位 · 方向键微调"
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.currentTarget.focus();
      dragRef.current = { pointerId: event.pointerId, x: event.clientX, width: Number(event.currentTarget.getAttribute("aria-valuenow")) };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.parentElement?.classList.add("is-resizing-tree");
    }}
    onPointerMove={event => {
      const drag = dragRef.current;
      if (drag?.pointerId === event.pointerId) resize(drag.width + event.clientX - drag.x);
    }}
    onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
    onDoubleClick={() => { resize(DEFAULT_WORKSPACE_LAYOUT.treeWidth); commitWidth(DEFAULT_WORKSPACE_LAYOUT.treeWidth); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      const step = event.shiftKey ? 40 : 10;
      const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (!direction && event.key !== "Home") return;
      event.preventDefault(); event.stopPropagation();
      const preferred = event.key === "Home" ? DEFAULT_WORKSPACE_LAYOUT.treeWidth : Number(event.currentTarget.getAttribute("aria-valuenow")) + direction * step;
      const next = resize(preferred);
      if (next !== undefined) commitWidth(event.key === "Home" ? preferred : next);
    }} />;
}
