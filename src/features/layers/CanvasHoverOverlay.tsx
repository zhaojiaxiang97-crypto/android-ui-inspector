import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { PixelSize, UiNode } from "../../../shared/types";
import { boundsPercent, clientToScreen, findNodeAtPoint } from "../../../shared/screen-coordinates";
import { nodeDisplayLabel } from "../../../shared/tree-utils";
import { indexTree } from "../../../shared/visible-tree";
import { useNodeHover, useNodeHoverActions } from "../inspection/NodeHoverContext";
import "../../styles/canvas-hover.css";

export function useFlatNodeHover({ root, imageRef, size, active }: {
  root: UiNode; imageRef: RefObject<HTMLImageElement | null>; size: PixelSize | null; active: boolean;
}) {
  const { publishHover, clearHover } = useNodeHoverActions();
  const frame = useRef<number | null>(null);
  const point = useRef<{ x: number; y: number } | null>(null);
  const current = useRef({ root, imageRef, size, active });
  current.current = { root, imageRef, size, active };
  const clear = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    point.current = null;
    clearHover("canvas");
  }, [clearHover]);
  useLayoutEffect(() => {
    if (!active) clear();
    return clear;
  }, [root, size?.width, size?.height, active, clear]);
  const hover = useCallback((x: number, y: number) => {
    if (!current.current.active) return;
    point.current = { x, y };
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const state = current.current, at = point.current, image = state.imageRef.current;
      if (!state.active || !state.size || !image || !at || !image.complete || !image.naturalWidth) return;
      const screen = clientToScreen(at.x, at.y, image.getBoundingClientRect(), state.size);
      const node = screen ? findNodeAtPoint(state.root, screen.x, screen.y, state.size) : null;
      publishHover(node?.id ?? null, "canvas");
    });
  }, [publishHover]);
  return { hoverFlatNode: hover, clearCanvasHover: clear };
}

export function FlatNodeHoverOverlay({ root, size, selectedId }: {
  root: UiNode; size: PixelSize; selectedId: string | null;
}) {
  const { hover } = useNodeHover();
  const nodes = useMemo(() => indexTree(root), [root]);
  const node = hover ? nodes.get(hover.nodeId)?.node : null;
  const bounds = node?.bounds ? boundsPercent(node.bounds, size) : null;
  if (!node || !bounds || node.id === selectedId) return null;
  return <div className="canvas-hover-overlay" style={bounds} data-flat-hovered-id={node.id} aria-hidden="true">
    <span className="canvas-hover-label">指向 · {nodeDisplayLabel(node)}</span>
  </div>;
}
