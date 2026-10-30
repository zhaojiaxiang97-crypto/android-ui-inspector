import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { InspectionPort } from "../../platform/desktop-services";
import { createInspectionSession, type CapturePresentation, type InspectionSessionState } from "./inspection-session";

/** React subscription and transport lifetime; the controller owns request identity. */
export function useInspectionSession(api: InspectionPort, presentation: CapturePresentation) {
  const current = useRef(presentation); current.current = presentation;
  const retained = useRef<InspectionSessionState | null>(null);
  const controller = useMemo(() => createInspectionSession(api, {
    begin: serial => current.current.begin(serial), preview: event => current.current.preview(event),
    complete: snapshot => current.current.complete(snapshot), discard: reason => current.current.discard(reason),
    open: (snapshot, nodeId, capturedAt) => current.current.open(snapshot, nodeId, capturedAt), clear: () => current.current.clear(),
  }, retained.current ? { captureFailures: retained.current.captureFailures, inspectionStage: retained.current.inspectionStage,
    inspectionElapsed: retained.current.inspectionElapsed } : undefined), [api]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  retained.current = state;
  useEffect(() => controller.connect(), [controller]);
  useEffect(() => {
    if (!state.inspectionLoading) return;
    const timer = setInterval(controller.tick, 1000);
    return () => clearInterval(timer);
  }, [controller, state.inspectionLoading]);
  return { ...state, controller };
}
