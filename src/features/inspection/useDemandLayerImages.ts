import { useEffect, useMemo, useRef, useState } from "react";
import type { LayerImageCaptureResult, UiSnapshot } from "../../../shared/types";
import type { InspectionPort } from "../../platform/desktop-services";
import { createDemandLayerCapture, type DemandLayerState } from "./demand-layer-capture";

export function useDemandLayerImages(options: {
  api: InspectionPort; snapshot: UiSnapshot | null; requestId: string | null;
  current(): UiSnapshot | null;
  blocked(): boolean;
  apply(source: UiSnapshot, result: LayerImageCaptureResult): void;
}) {
  const current = useRef(options); current.current = options;
  const [state, setState] = useState<DemandLayerState>({ loading: false, nodeId: null, message: null, failed: false });
  const controller = useMemo(() => createDemandLayerCapture({ api: options.api,
    current: () => ({ snapshot: current.current.current(), requestId: current.current.requestId, blocked: current.current.blocked() }),
    apply: (source, result) => current.current.apply(source, result), publish: setState,
  }), [options.api]);
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  useEffect(() => { controller.invalidate(); }, [controller, options.requestId]);
  return { ...state, invalidate: controller.invalidate, isBusy: controller.isBusy,
    available: Boolean(options.snapshot?.layerCapture === "on-demand" && options.requestId && options.api.captureLayerImages),
    request: (nodeId: string, retry = false) => controller.request(options.snapshot, nodeId, retry),
  };
}
