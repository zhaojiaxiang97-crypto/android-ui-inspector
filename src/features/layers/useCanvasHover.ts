import { useCallback, useState } from "react";
import type { PixelSize, UiNode } from "../../../shared/types";
import { clientToScreen, findNodeAtPoint } from "../../../shared/screen-coordinates";
import { useFlatNodeHover } from "./CanvasHoverOverlay";
import type { CanvasSurface, CanvasViewMode } from "./useCanvasView";

export function useCanvasHover({ root, size, enabled, viewMode, surface }: {
  root: UiNode; size: PixelSize | null; enabled: boolean; viewMode: CanvasViewMode; surface: Pick<CanvasSurface, "imageRef" | "layerSceneRef">;
}) {
  const { imageRef, layerSceneRef } = surface;
  const [nodeId, setNodeId] = useState<string | null>(null);
  const { hoverFlatNode, clearCanvasHover } = useFlatNodeHover({ root, imageRef, size, active: enabled && viewMode === "flat" });
  const clear = useCallback(() => { clearCanvasHover(); setNodeId(null); }, [clearCanvasHover]);
  function move(clientX: number, clientY: number) {
    if (viewMode === "layers3d") {
      layerSceneRef.current?.hover(clientX, clientY);
      setNodeId(layerSceneRef.current?.pick(clientX, clientY)?.id ?? null);
    } else {
      hoverFlatNode(clientX, clientY);
      const image = imageRef.current, point = image && size ? clientToScreen(clientX, clientY, image.getBoundingClientRect(), size) : null;
      setNodeId(point && size ? findNodeAtPoint(root, point.x, point.y, size)?.id ?? null : null);
    }
  }
  return { nodeId, clear, move };
}
export type CanvasHover = ReturnType<typeof useCanvasHover>;
