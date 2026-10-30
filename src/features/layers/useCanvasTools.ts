import { useLayoutEffect, useRef, useState } from "react";
import type { UiNode } from "../../../shared/types";
import type { CanvasSurface, CanvasViewMode } from "./useCanvasView";
import type { CanvasQuickSelect } from "./useCanvasQuickSelect";
import type { useLayerMeasurement } from "./useLayerMeasurement";
export type CanvasMeasurement = ReturnType<typeof useLayerMeasurement>;
type Tool = "zoom" | "settings" | "help";

/** Coordinates popovers, quick selection and measurement as exclusive commands. */
export function useCanvasTools({ surface, context, viewMode, ready, quick, measurement, onCancelGesture }: {
  surface: Pick<CanvasSurface, "frameRef">;
  context: { root: UiNode; src: string; sessionKey?: string | number };
  viewMode: CanvasViewMode;
  ready: { toolsSuspended: boolean; navigationDisabled: boolean; enabled: boolean };
  quick: Pick<CanvasQuickSelect, "active" | "close" | "open">; measurement: CanvasMeasurement; onCancelGesture: () => void;
}) {
  const { frameRef } = surface;
  const { root, src, sessionKey } = context;
  const { toolsSuspended, navigationDisabled, enabled } = ready;
  const measurementToolRef = useRef<HTMLButtonElement>(null);
  const [activeTool, setActiveTool] = useState<Tool | null>(null);
  const activeToolRef = useRef(activeTool); activeToolRef.current = activeTool;
  const measurementRef = useRef(measurement); measurementRef.current = measurement;
  function toolOpen(tool: Tool, open: boolean) {
    if (open && !toolsSuspended && !document.querySelector("dialog[open]")) {
      onCancelGesture(); quick.close(); setActiveTool(tool);
    } else setActiveTool(current => current === tool ? null : current);
  }
  useLayoutEffect(() => { setActiveTool(null); }, [root, src, sessionKey]);
  useLayoutEffect(() => { if (viewMode !== "layers3d") setActiveTool(current => current === "settings" ? null : current); }, [viewMode]);
  useLayoutEffect(() => { if (toolsSuspended || navigationDisabled || !enabled) setActiveTool(null); }, [toolsSuspended, navigationDisabled, enabled]);
  useLayoutEffect(() => {
    if (navigationDisabled && measurement.state.picking) measurement.clearPinnedMeasurement();
    if (navigationDisabled) measurement.setTemporaryMeasurement(false);
  }, [navigationDisabled, Boolean(measurement.state.picking)]);
  function beginMeasurement(endpoint?: "anchor" | "target") {
    if (navigationDisabled) return false;
    quick.close(); onCancelGesture();
    const started = Boolean(measurementRef.current.beginMeasurement(endpoint));
    if (started) frameRef.current?.focus({ preventScroll: true });
    return started;
  }
  function startMeasurementMode() {
    if (navigationDisabled) return false;
    quick.close(); onCancelGesture();
    const started = Boolean(measurementRef.current.startMeasurementMode());
    if (started) frameRef.current?.focus({ preventScroll: true });
    return started;
  }
  function endMeasurement() {
    measurementRef.current.clearPinnedMeasurement();
    measurementToolRef.current?.focus({ preventScroll: true });
  }

  function toggleQuickSelect() {
    if (quick.active) quick.close(true);
    else {
      if (measurement.state.mode !== "fixed") measurement.clearPinnedMeasurement();
      onCancelGesture(); quick.open(); frameRef.current?.focus({ preventScroll: true });
    }
  }
  return { activeTool, isOpen: () => Boolean(activeToolRef.current), toolOpen, measurementToolRef,
    beginMeasurement, startMeasurementMode, endMeasurement, toggleQuickSelect };
}
export type CanvasTools = ReturnType<typeof useCanvasTools>;
