import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { InspectionModePort } from "../../platform/desktop-services";
import { createInspectionModeSettings } from "./inspection-mode-settings";

export function useInspectionMode(api: InspectionModePort | undefined, onRevision: () => void, busy = false) {
  const current = useRef({ onRevision, busy }); current.current = { onRevision, busy };
  const controller = useMemo(() => createInspectionModeSettings(api, () => current.current.onRevision(), () => current.current.busy), [api]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  useEffect(() => controller.connect(), [controller]);
  return { ...state, busy: state.busy || busy, setMode: controller.setMode, reload: controller.reload };
}
