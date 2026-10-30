import { useLayoutEffect, useState, type RefObject } from "react";
import { unobscuredViewport, type PreviewRect } from "../../../shared/preview-viewport";

export function usePreviewViewport(frameRef: RefObject<HTMLDivElement | null>) {
  const [area, setArea] = useState({ width: 0, height: 0, visible: { left: 0, top: 0, width: 0, height: 0 } as PreviewRect, occluded: false });
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const workspace = frame.parentElement;
    let panel: HTMLElement | null = null, scheduled: number | null = null;
    const update = () => {
      scheduled = null;
      const nextPanel = workspace?.querySelector<HTMLElement>(".measurement-card") ?? workspace?.querySelector<HTMLElement>(".floating-inspector") ?? null;
      if (panel !== nextPanel) {
        if (panel) resize.unobserve(panel);
        panel = nextPanel;
        if (panel) resize.observe(panel);
      }
      const width = frame.clientWidth, height = frame.clientHeight;
      const bounds = frame.getBoundingClientRect();
      const obstruction = panel && !panel.hidden && panel.getClientRects().length ? panel.getBoundingClientRect() : null;
      const visible = unobscuredViewport(width, height, obstruction ? {
        left: obstruction.left - bounds.left - frame.clientLeft, top: obstruction.top - bounds.top - frame.clientTop,
        width: obstruction.width, height: obstruction.height,
      } : null);
      const occluded = visible.width !== width || visible.height !== height;
      setArea(current => current.width === width && current.height === height && current.occluded === occluded
        && Object.keys(visible).every(key => current.visible[key as keyof PreviewRect] === visible[key as keyof PreviewRect])
        ? current : { width, height, visible, occluded });
    };
    const schedule = () => { if (scheduled === null) scheduled = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    resize.observe(frame);
    const mutations = new MutationObserver(records => {
      if (records.some(record => record.target === panel || record.type === "childList" && [...record.addedNodes, ...record.removedNodes]
        .some(node => node instanceof Element && (node.matches(".floating-inspector, .measurement-card") || node.querySelector(".floating-inspector, .measurement-card"))))) schedule();
    });
    if (workspace) mutations.observe(workspace, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "style"] });
    update();
    return () => { resize.disconnect(); mutations.disconnect(); if (scheduled !== null) cancelAnimationFrame(scheduled); };
  }, [frameRef]);
  return area;
}
