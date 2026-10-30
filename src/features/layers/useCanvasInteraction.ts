import { useLayoutEffect, useRef, useState, type PointerEvent, type MouseEvent } from "react";
import type { PixelSize, UiNode, LayerFocus, TreeDoubleClickAction } from "../../../shared/types";
import { clientToScreen, findNodeAtPoint } from "../../../shared/screen-coordinates";
import { flattenNodes } from "../../../shared/tree-utils";
import { orbitFromDrag } from "../../../shared/orbit-camera";
import { quickSelectModifier, type QuickSelectResult } from "./quick-select";
import type { CanvasHover } from "./useCanvasHover";
import type { CanvasSurface, CanvasView } from "./useCanvasView";
import type { CanvasQuickSelect } from "./useCanvasQuickSelect";
import type { CanvasTools, CanvasMeasurement } from "./useCanvasTools";

type Gesture = {
  pointerId: number;
  kind: "pan" | "rotate" | "select";
  startX: number;
  startY: number;
  startPanX: number;
  startPanY: number;
  startAzimuth: number;
  startElevation: number;
  moved: boolean;
  contextClick: boolean;
  pressedNode: UiNode | null;
  quickSelection?: QuickSelectResult | null;
};

const DRAG_THRESHOLD = 4;

/** The only owner of a pressed pointer, its picked frame and double-click history. */
export function useCanvasInteraction({ surface, content, view, quick, tools, measurement, hover, onSelect, onDoubleClick, onOpenLayerMenu }: {
  surface: Pick<CanvasSurface, "frameRef" | "imageRef" | "layerSceneRef">;
  content: { root: UiNode; src: string; sessionKey?: string | number; selectedNode: UiNode | null;
    size: PixelSize | null; enabled: boolean; geometryChecked: boolean; navigationDisabled: boolean;
    toolsSuspended: boolean; layerFocus: LayerFocus | null; doubleClickAction: TreeDoubleClickAction;
    gestureContext: object; canNavigate: boolean };
  hover: Pick<CanvasHover, "clear" | "move">;
  view: Pick<CanvasView, "viewMode" | "cameraControl" | "interrupt">;
  quick: Pick<CanvasQuickSelect, "active" | "close" | "clearResult" | "isCurrent" | "show">;
  tools: Pick<CanvasTools, "isOpen">; measurement: CanvasMeasurement;
  onSelect: (node: UiNode) => void; onDoubleClick: (node: UiNode) => void;
  onOpenLayerMenu: (node: UiNode | null, mode: "flat" | "layers3d") => void;
}) {
  const { frameRef, imageRef, layerSceneRef } = surface;
  const { root, src, sessionKey, selectedNode, size, enabled, geometryChecked, navigationDisabled, toolsSuspended,
    layerFocus, doubleClickAction, gestureContext, canNavigate } = content;
  const { viewMode, cameraControl } = view;
  const activeQuick = quick.active;
  const macPlatform = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const gestureRef = useRef<Gesture | null>(null);
  const ignoredPointerRef = useRef<number | null>(null);
  const layerClickRef = useRef<{ node: UiNode; sameNode: boolean } | null>(null);
  const [gestureActive, setGestureActive] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const [shiftPressed, setShiftPressed] = useState(false);
  const clearCanvasHover = hover.clear;
  const measurementRef = useRef(measurement); measurementRef.current = measurement;
  function openLayerMenu(clientX?: number, clientY?: number) {
    if (navigationDisabled || toolsSuspended || tools.isOpen() || gestureRef.current || measurementRef.current.state.picking || document.querySelector("dialog[open]")) return;
    const pointer = clientX !== undefined && clientY !== undefined;
    if (spacePressed || pointer && shiftPressed) return;
    let node: UiNode | null = null;
    if (pointer) {
      if (!enabled) return;
      if (viewMode === "layers3d") node = layerSceneRef.current?.pick(clientX, clientY) ?? null;
      else {
        const image = imageRef.current;
        if (!geometryChecked || !size || !image?.complete || !image.naturalWidth) return;
        const point = clientToScreen(clientX, clientY, image.getBoundingClientRect(), size);
        node = point ? findNodeAtPoint(root, point.x, point.y, size) : null;
      }
    } else if (selectedNode && flattenNodes(root).get(selectedNode.id) === selectedNode) node = selectedNode;
    quick.close(); clearCanvasHover();
    layerSceneRef.current?.clearHover();
    onOpenLayerMenu(node, viewMode);
  }

  function selectAtPoint(event: PointerEvent<HTMLDivElement>, pressedNode?: UiNode | null) {
    const image = imageRef.current;
    if (event.button !== 0 || !event.isPrimary || navigationDisabled || !enabled || !size) return null;
    if (viewMode === "layers3d") {
      const layer = pressedNode === undefined ? layerSceneRef.current?.pick(event.clientX, event.clientY) : pressedNode;
      if (layer) onSelect(layer);
      // Never fall back to the flattened screen: it still contains hidden layers.
      return layer ?? null;
    }
    if (!image || !image.complete || !image.naturalWidth) return null;
    const point = clientToScreen(event.clientX, event.clientY, image.getBoundingClientRect(), size);
    if (!point) return null;
    const node = findNodeAtPoint(root, point.x, point.y, size);
    if (node) onSelect(node);
    return node;
  }

  function startGesture(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || !event.isPrimary || gestureRef.current) return;
    ignoredPointerRef.current = null;
    const shouldPan = event.button === 1 || (event.button === 0 && spacePressed) || (event.button === 0 && event.shiftKey);
    const shouldRotate = viewMode === "layers3d" && (event.button === 2 || event.button === 0);
    const contextClick = event.button === 2 || (macPlatform && event.button === 0 && event.ctrlKey);
    if (!shouldPan && !shouldRotate && !contextClick && event.button !== 0) return;
    view.interrupt();
    const shortcutQuickSelection = viewMode === "layers3d" && canNavigate && !navigationDisabled && layerFocus?.kind !== "layer"
      && quickSelectModifier(event, navigator.platform);
    const plainQuickSelection = (activeQuick || shortcutQuickSelection) && !shouldPan && event.button === 0 && !contextClick;
    if (plainQuickSelection && measurementRef.current.state.mode !== "fixed") measurementRef.current.clearPinnedMeasurement();
    // Query the frame the user pressed. A later drag still finishes the motion.
    if (!plainQuickSelection) layerSceneRef.current?.interruptMotion();
    event.preventDefault();
    const frame = event.currentTarget;
    frame.focus({ preventScroll: true });
    const currentCamera = cameraControl.read();
    const gesture: Gesture = {
      pointerId: event.pointerId,
      kind: shouldPan ? "pan" : shouldRotate ? "rotate" : "select",
      startX: event.clientX,
      startY: event.clientY,
      startPanX: currentCamera.panX,
      startPanY: currentCamera.panY,
      startAzimuth: currentCamera.azimuth,
      startElevation: currentCamera.elevation,
      moved: false,
      contextClick,
      pressedNode: viewMode === "layers3d" ? layerSceneRef.current?.pick(event.clientX, event.clientY) ?? null : null,
      quickSelection: plainQuickSelection
        ? (activeQuick?.mode === "position" && !shortcutQuickSelection
          ? layerSceneRef.current?.layersAt(event.clientX, event.clientY)
          : layerSceneRef.current?.quickSelectAt(event.clientX, event.clientY)) ?? null : undefined,
    };
    gestureRef.current = gesture;
    setGestureActive(true);
    if (shouldPan) clearCanvasHover();
    if (viewMode === "layers3d" && !shouldPan && !activeQuick) layerSceneRef.current?.hover(event.clientX, event.clientY);
    frame.setPointerCapture(event.pointerId);
  }

  function moveGesture(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      gesture.moved = true;
      if (gesture.quickSelection) layerSceneRef.current?.interruptMotion();
      if (activeQuick) { layerSceneRef.current?.interruptMotion(); quick.clearResult(); }
      event.currentTarget.dataset.gesture = gesture.kind;
      if (viewMode === "layers3d") event.currentTarget.classList.add("is-3d-dragging");
      layerSceneRef.current?.clearHover();
      clearCanvasHover();
    }
    if (gesture.kind === "pan") {
      cameraControl.schedule({ ...cameraControl.read(), panX: gesture.startPanX + dx, panY: gesture.startPanY + dy });
    } else if (gesture.kind === "rotate") {
      cameraControl.schedule(orbitFromDrag({ ...cameraControl.read(), azimuth: gesture.startAzimuth, elevation: gesture.startElevation }, dx, dy));
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (gestureRef.current) {
      moveGesture(event);
      return;
    }
    setShiftPressed(event.shiftKey);
    if (activeQuick) return;
    if (spacePressed || event.shiftKey) { layerSceneRef.current?.clearHover(); clearCanvasHover(); return; }
    hover.move(event.clientX, event.clientY);
  }

  function cancelGesture() {
    clearCanvasHover();
    const gesture = gestureRef.current, frame = frameRef.current;
    gestureRef.current = null;
    setGestureActive(false);
    if (gesture) {
      ignoredPointerRef.current = gesture.pointerId;
      if (frame?.hasPointerCapture(gesture.pointerId)) frame.releasePointerCapture(gesture.pointerId);
      if (gesture.moved) cameraControl.commit(cameraControl.read());
    }
    frame?.classList.remove("is-3d-dragging");
    if (frame) delete frame.dataset.gesture;
    layerSceneRef.current?.clearHover();
  }

  function finishGesture(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    // A quick drag can reach release before Chromium sends another move event.
    if (event.type === "pointerup") moveGesture(event);
    const frame = frameRef.current;
    gestureRef.current = null;
    setGestureActive(false);
    if (frame?.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
    frame?.classList.remove("is-3d-dragging");
    if (frame) delete frame.dataset.gesture;
    if (gesture.moved) cameraControl.commit(cameraControl.read());
    if (event.type !== "pointerup") {
      ignoredPointerRef.current = gesture.pointerId;
      layerClickRef.current = null;
      layerSceneRef.current?.clearHover();
    } else if (gesture.moved && !spacePressed && !event.shiftKey && frame?.contains(document.elementFromPoint(event.clientX, event.clientY))) layerSceneRef.current?.hover(event.clientX, event.clientY);
    return event.type !== "pointerup" || gesture.moved || gesture.kind === "pan";
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) return;
    if (event.pointerId === ignoredPointerRef.current) return;
    const previousClick = layerClickRef.current;
    layerClickRef.current = null;
    const pressedNode = gestureRef.current?.pressedNode;
    const quickSelection = gestureRef.current?.quickSelection;
    const contextClick = gestureRef.current?.contextClick || event.button === 2;
    if (finishGesture(event)) return;
    // Open on release, not contextmenu: Windows emits contextmenu on press,
    // which would otherwise interrupt the existing right-button orbit drag.
    if (contextClick) { if (!event.shiftKey) void openLayerMenu(event.clientX, event.clientY); return; }
    if (quickSelection && quick.isCurrent()) {
      const bounds = frameRef.current!.getBoundingClientRect();
      quick.show(quickSelection, { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      return;
    }
    if (activeQuick) {
      return;
    }
    const node = selectAtPoint(event, pressedNode);
    if (viewMode === "layers3d" && node) layerClickRef.current = { node, sameNode: previousClick?.node.id === node.id };
  }
  function handleDoubleClick(event: MouseEvent<HTMLDivElement>) {
    const click = layerClickRef.current;
    layerClickRef.current = null;
    if (activeQuick || measurement.state.mode !== "off" || viewMode !== "layers3d" || event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || spacePressed) return;
    // Every plane shares one canvas: two clicks must hit the same node,
    // and neither may be a drag, pan, context click or empty-space click.
    if (click?.sameNode) {
      event.preventDefault();
      onDoubleClick(click.node);
    }
  }
  useLayoutEffect(() => {
    cancelGesture(); layerClickRef.current = null;
  }, [root, src, sessionKey, doubleClickAction, viewMode, enabled, gestureContext]);
  useLayoutEffect(() => () => {
    // No React updates on unmount. Release the captured pointer and forget its frame.
    const gesture = gestureRef.current, frame = frameRef.current;
    gestureRef.current = null; layerClickRef.current = null;
    if (gesture && frame?.hasPointerCapture(gesture.pointerId)) frame.releasePointerCapture(gesture.pointerId);
    frame?.classList.remove("is-3d-dragging");
    if (frame) delete frame.dataset.gesture;
    layerSceneRef.current?.clearHover();
  }, []);
  return {
    gestureActive, spacePressed, shiftPressed,
    isActive: () => Boolean(gestureRef.current),
    cancel: () => { cancelGesture(); layerClickRef.current = null; },
    cancelQuickGesture: () => { if (gestureRef.current?.quickSelection) { cancelGesture(); layerClickRef.current = null; } },
    openLayerMenu,
    setSpace: (pressed: boolean) => {
      setSpacePressed(pressed);
      if (pressed) { layerClickRef.current = null; layerSceneRef.current?.clearHover(); clearCanvasHover(); }
    },
    setShift: (pressed: boolean) => {
      setShiftPressed(pressed);
      if (pressed) { layerSceneRef.current?.clearHover(); clearCanvasHover(); }
    },
    clearHover: () => { layerSceneRef.current?.clearHover(); clearCanvasHover(); },
    pointerHandlers: {
      onPointerDown: startGesture, onPointerMove: handlePointerMove, onPointerUp: handlePointerUp, onDoubleClick: handleDoubleClick,
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => { finishGesture(event); clearCanvasHover(); },
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => { finishGesture(event); clearCanvasHover(); },
      onPointerLeave: () => { setShiftPressed(false); layerSceneRef.current?.clearHover(); clearCanvasHover(); },
    },
  };
}
export type CanvasInteraction = ReturnType<typeof useCanvasInteraction>;
