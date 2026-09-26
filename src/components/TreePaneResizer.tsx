import { useEffect, useRef } from "react";

export function TreePaneResizer() {
  const handleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; width: number } | null>(null);

  function resize(width: number) {
    const handle = handleRef.current, grid = handle?.parentElement;
    if (!handle || !grid) return;
    const max = Math.max(240, Math.min(720, grid.clientWidth - 360));
    const next = Math.round(Math.max(240, Math.min(width, max)));
    grid.style.setProperty("--tree-pane-width", `${next}px`);
    handle.setAttribute("aria-valuenow", String(next));
    handle.setAttribute("aria-valuemax", String(max));
  }

  function endDrag() {
    const drag = dragRef.current, handle = handleRef.current;
    dragRef.current = null;
    handle?.parentElement?.classList.remove("is-resizing-tree");
    if (drag && handle?.hasPointerCapture(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
  }

  useEffect(() => {
    const handle = handleRef.current!, grid = handle.parentElement!;
    const observer = new ResizeObserver(() => resize(Number(handle.getAttribute("aria-valuenow"))));
    observer.observe(grid);
    window.addEventListener("blur", endDrag);
    return () => { observer.disconnect(); window.removeEventListener("blur", endDrag); endDrag(); };
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
    onDoubleClick={() => resize(306)}
    onKeyDown={event => {
      const step = event.shiftKey ? 40 : 10;
      const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (!direction && event.key !== "Home") return;
      event.preventDefault(); event.stopPropagation();
      resize(event.key === "Home" ? 306 : Number(event.currentTarget.getAttribute("aria-valuenow")) + direction * step);
    }} />;
}
