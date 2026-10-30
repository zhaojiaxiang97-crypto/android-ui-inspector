import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { clampFloatingInspectorRect, type WorkspaceLayout } from "../../../shared/workspace-layout";

type InspectorLayout = WorkspaceLayout["inspector"];

export function useFloatingInspectorLayout({ panelRef, floating, visible, collapsed, layout, onSave, onFloatingChange }: {
  panelRef: RefObject<HTMLElement | null>;
  floating: boolean;
  visible: boolean;
  collapsed: boolean;
  layout?: InspectorLayout;
  onSave?: (value: InspectorLayout) => boolean;
  onFloatingChange: (value: boolean) => void;
}) {
  const current = useRef({ layout, onSave, floating, collapsed });
  current.current = { layout, onSave, floating, collapsed };
  const expandedHeight = useRef(400);
  const [failedLayout, setFailedLayout] = useState<InspectorLayout | null>(null);

  useLayoutEffect(() => {
    if (layout) onFloatingChange(layout.floating);
  }, [layout?.floating, onFloatingChange]);

  useLayoutEffect(() => {
    const panel = panelRef.current, workspace = panel?.parentElement;
    if (!layout || !panel || !workspace) return;
    if (!floating) {
      for (const property of ["left", "right", "width", "height", "--inspector-top"]) panel.style.removeProperty(property);
      return;
    }
    if (!visible || !layout.rect) return;
    let frame: number | null = null;
    const apply = () => {
      frame = null;
      const rect = current.current.layout?.rect;
      if (!rect || !current.current.floating || panel.hidden) return;
      const height = Number.parseFloat(panel.style.getPropertyValue("--inspector-viewport-height")) || workspace.clientHeight;
      const minTop = Number.parseFloat(panel.style.getPropertyValue("--inspector-min-top")) || 12;
      if (workspace.clientWidth <= 0 || height <= 0) return;
      const shown = clampFloatingInspectorRect(rect, { width: workspace.clientWidth, height, minTop });
      if (collapsed) {
        panel.style.removeProperty("height");
        shown.top = Math.max(minTop, Math.min(rect.top, height - panel.offsetHeight - 16));
      }
      const styles = { left: `${shown.left}px`, right: "auto", width: `${shown.width}px`, height: `${shown.height}px`, "--inspector-top": `${shown.top}px` };
      for (const [name, value] of Object.entries(styles)) if (!(collapsed && name === "height") && panel.style.getPropertyValue(name) !== value) panel.style.setProperty(name, value);
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(apply); };
    const observer = new ResizeObserver(schedule);
    observer.observe(workspace);
    apply();
    return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
  }, [panelRef, floating, visible, collapsed, layout?.rect]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel && visible && !collapsed && panel.offsetHeight > 0) expandedHeight.current = panel.offsetHeight;
  }, [panelRef, floating, visible, collapsed, layout?.rect]);

  const persistInspectorLayout = useCallback((nextFloating = current.current.floating) => {
    const panel = panelRef.current, { layout: previous, onSave: save } = current.current;
    if (!previous || !save || !panel) return false;
    const rect = nextFloating && panel.offsetWidth > 0 ? {
      left: panel.offsetLeft, top: panel.offsetTop, width: Math.min(1280, Math.max(176, panel.offsetWidth)),
      height: Math.min(1600, Math.max(160, current.current.collapsed ? previous.rect?.height ?? expandedHeight.current : panel.offsetHeight)),
    } : previous.rect;
    const next = { floating: nextFloating, rect };
    if (JSON.stringify(next) === JSON.stringify(previous)) return true;
    const saved = save(next);
    setFailedLayout(saved ? null : next);
    return saved;
  }, [panelRef]);

  return { persistInspectorLayout, layoutSaveError: Boolean(failedLayout && JSON.stringify(failedLayout) === JSON.stringify(layout)) };
}
