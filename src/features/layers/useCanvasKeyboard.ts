import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { LayerMenuAction, UiNode } from "../../../shared/types";
import { orbitFromKeys } from "../../../shared/orbit-camera";
import { dismissVisibleContextHint } from "../../components/ContextHint";
import { ZOOM_STEP, type CanvasSurface, type CanvasView } from "./useCanvasView";
import type { CanvasInteraction } from "./useCanvasInteraction";
import type { CanvasQuickSelect } from "./useCanvasQuickSelect";
import type { CanvasTools, CanvasMeasurement } from "./useCanvasTools";

/** Capture Escape before workspace actions; then handle focused-canvas shortcuts. */
export function useCanvasKeyboard({ surface, view, interaction, quick, tools, measurement, content, onLayerAction }: {
  surface: Pick<CanvasSurface, "frameRef" | "layerSceneRef">;
  view: Pick<CanvasView, "viewMode" | "zoom" | "resetView" | "changeZoom" | "fitView" | "cameraControl" | "exit3d">;
  interaction: Pick<CanvasInteraction, "isActive" | "setSpace" | "setShift" | "cancel" | "clearHover" | "openLayerMenu">;
  quick: Pick<CanvasQuickSelect, "active" | "isOpen" | "close">;
  tools: Pick<CanvasTools, "isOpen" | "startMeasurementMode">; measurement: CanvasMeasurement;
  content: { selectedNode: UiNode | null; focusedNode: UiNode | null; navigationDisabled: boolean; enabled: boolean };
  onLayerAction: (action: LayerMenuAction, node?: UiNode | null) => void;
}) {
  const { frameRef, layerSceneRef } = surface;
  const { selectedNode, focusedNode, navigationDisabled, enabled } = content;
  const { viewMode, zoom, resetView, changeZoom, fitView, cameraControl } = view;
  const activeQuick = quick.active;
  const measurementRef = useRef(measurement); measurementRef.current = measurement;
  // Clear a pinned pair before the workspace's existing Escape-to-exit actions.
  const releaseMeasurement = (event: globalThis.KeyboardEvent) => {
    // Capture listeners run before a candidate input can handle its IME keys.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.target instanceof HTMLElement && event.target.closest(".inspector-group-popup")) return;
    if (tools.isOpen()) return;
    if (document.querySelector("dialog[open]") || dismissVisibleContextHint(event)) return;
    if (event.key === "Escape" && !event.defaultPrevented && quick.isOpen()) {
      event.preventDefault(); event.stopPropagation(); quick.close(true); return;
    }
    if (event.key !== "Escape" || event.defaultPrevented
      || (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true], details[open]"))) return;
    if (measurementRef.current.clearPinnedMeasurement()) { event.preventDefault(); event.stopPropagation(); }
  };
  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.target instanceof HTMLElement && event.target.closest(".inspector-group-popup")) return;
    if (tools.isOpen()) return;
    if (document.querySelector("dialog[open]") || dismissVisibleContextHint(event)) return;
    const editing = event.target instanceof HTMLElement && Boolean(event.target.closest("input, textarea, select, [contenteditable=true]"));
    const screenshotFocused = Boolean(frameRef.current && event.target instanceof Node && frameRef.current.contains(event.target));
    if (event.target instanceof HTMLElement && event.target.closest(".quick-select-panel")) return;
    if (event.key === "Alt" && selectedNode && !editing && !event.repeat && !event.defaultPrevented
      && !event.ctrlKey && !event.metaKey && !event.shiftKey && !navigationDisabled && !activeQuick && !interaction.isActive()) {
      if (measurementRef.current.setTemporaryMeasurement(true)) event.preventDefault();
    }
    if (event.code === "Space" && screenshotFocused && !editing && !event.defaultPrevented) {
      event.preventDefault();
      interaction.setSpace(true);
    }
    if (event.key === "Shift" && screenshotFocused && !editing) { interaction.setShift(true); }
    if (event.key === "Escape" && viewMode === "layers3d" && !event.defaultPrevented
      && !(event.target instanceof HTMLElement && event.target.closest("input, textarea, select, details[open]"))) {
      if (focusedNode) { event.preventDefault(); onLayerAction("exit-focus"); }
      else view.exit3d();
    }
    if (viewMode === "layers3d" && screenshotFocused) {
      if (event.key === "Home") {
        event.preventDefault();
        resetView();
        return;
      }
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        layerSceneRef.current?.interruptMotion();
        cameraControl.commit(orbitFromKeys(cameraControl.read(), event.key as "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"));
        return;
      }
    }
    if (!enabled || !screenshotFocused || editing || event.defaultPrevented) return;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      changeZoom(zoom + ZOOM_STEP);
    } else if (event.key === "-") {
      event.preventDefault();
      changeZoom(zoom - ZOOM_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      fitView();
    }
  };
  const onWindowKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Alt") measurementRef.current.setTemporaryMeasurement(false);
    if (event.code === "Space") interaction.setSpace(false);
    if (event.key === "Shift") interaction.setShift(false);
  };
  const onWindowBlur = () => {
    measurementRef.current.setTemporaryMeasurement(false);
    quick.close();
    interaction.cancel();
    interaction.clearHover();
    interaction.setSpace(false);
    interaction.setShift(false);
  };
  const handlers = useRef({ releaseMeasurement, onWindowKeyDown, onWindowKeyUp, onWindowBlur });
  handlers.current = { releaseMeasurement, onWindowKeyDown, onWindowKeyUp, onWindowBlur };
  useEffect(() => {
    const release = (event: KeyboardEvent) => handlers.current.releaseMeasurement(event);
    const down = (event: KeyboardEvent) => handlers.current.onWindowKeyDown(event);
    const up = (event: KeyboardEvent) => handlers.current.onWindowKeyUp(event);
    const blur = () => handlers.current.onWindowBlur();
    window.addEventListener("keydown", release, true);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", release, true);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const handleMeasurementShortcut = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
    if (document.querySelector("dialog[open]") || dismissVisibleContextHint(event)) return false;
    if (event.defaultPrevented || navigationDisabled || (event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true], details[open]")) return false;
    const handled = event.key === "Escape" ? measurementRef.current.clearPinnedMeasurement()
      : event.key.toLowerCase() === "m" && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
        ? activeQuick ? tools.startMeasurementMode() : measurementRef.current.toggleMeasurementPin() || tools.startMeasurementMode() : false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
    return Boolean(handled);
  };

  function onKeyDown(event: ReactKeyboardEvent) {
    if (handleMeasurementShortcut(event)) return;
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.defaultPrevented || (event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true], .quick-select-panel, .measurement-card")) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault(); interaction.openLayerMenu();
    }
  }
  return { onKeyDown, handleMeasurementShortcut };
}
