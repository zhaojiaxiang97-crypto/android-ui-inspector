import type { InspectionPort } from "../../platform/desktop-services";
import type { InspectionPreview, LayerCaptureMode, UiSnapshot } from "../../../shared/types";
import { rememberCaptureFailures, type CaptureFailureRecord } from "../../../shared/capture-feedback";

export type CapturePresentation = {
  begin(serial: string): void;
  preview(event: InspectionPreview): void;
  complete(snapshot: UiSnapshot): void;
  discard(reason: "cancel" | "failure"): void;
  open(snapshot: UiSnapshot, selectedNodeId?: string | null, capturedAt?: string | null): void;
  clear(): void;
};
export type InspectionSessionState = {
  inspectionLoading: boolean;
  inspectionStage: string;
  inspectionElapsed: number;
  inspectionError: string | null;
  captureFailures: CaptureFailureRecord[];
  qmlLiveRequestId: string | null;
  viewLiveRequestId: string | null;
};
type CaptureRequest = { id: string; previewShown: boolean; startedAt: number };

/** One capture owner, independent of group-image and node-refresh requests. */
export function createInspectionSession(api: InspectionPort, presentation: CapturePresentation, retained?: Pick<InspectionSessionState, "captureFailures" | "inspectionStage" | "inspectionElapsed">) {
  let active: CaptureRequest | null = null;
  let connected = false;
  let subscriptions: (() => void)[] = [];
  const listeners = new Set<() => void>();
  let state: InspectionSessionState = {
    inspectionLoading: false, inspectionStage: "连接 Debug App", inspectionElapsed: 0,
    inspectionError: null, captureFailures: [], qmlLiveRequestId: null, viewLiveRequestId: null, ...retained,
  };
  const publish = (patch: Partial<InspectionSessionState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const isCurrent = (request: CaptureRequest) => active === request;
  function cancelInspection(onlyRequestId?: string) {
    if (!connected) return;
    const request = active;
    if (onlyRequestId && request?.id !== onlyRequestId) return;
    active = null; // Revoke ownership before transport cancellation can settle.
    if (request?.previewShown) presentation.discard("cancel");
    if (request) void api.cancelInspection(request.id);
    publish({ inspectionLoading: false, ...(request ? { inspectionError: "已取消采集，可以重新开始。" } : {}) });
  }
  const preview = (event: InspectionPreview) => {
    const request = active;
    if (!connected || !request || request.id !== event.requestId) return;
    if (event.phase === "tree" ? !event.snapshot.root : !request.previewShown) return;
    if (event.phase === "tree") request.previewShown = true;
    presentation.preview(event);
  };
  async function inspectDevice(serial: string, priorityViewRef?: string | null, diagnostic?: { expectedPackage: string; requestId: string }, layerCapture?: LayerCaptureMode): Promise<UiSnapshot | null> {
    if (!connected) return null;
    if (diagnostic && active) throw new Error("已有采集正在运行。");
    const previous = active;
    const request: CaptureRequest = { id: diagnostic?.requestId ?? crypto.randomUUID(), previewShown: false, startedAt: performance.now() };
    active = request;
    if (previous) void api.cancelInspection(previous.id);
    publish({ inspectionLoading: true, inspectionStage: "连接 Debug App", inspectionElapsed: 0,
      inspectionError: null, qmlLiveRequestId: null, viewLiveRequestId: null });
    presentation.begin(serial);
    try {
      const result = await api.inspectDevice(serial, request.id, priorityViewRef, diagnostic ? true : undefined,
        diagnostic ? { expectedPackage: diagnostic.expectedPackage } : undefined, layerCapture);
      if (!isCurrent(request)) return null;
      presentation.complete(result);
      publish({ captureFailures: rememberCaptureFailures(state.captureFailures, result, request.id),
        qmlLiveRequestId: result.inspectionSource === "debug-qml" && result.root?.attributes?.["qml-process-id"] ? request.id : null,
        viewLiveRequestId: (result.inspectionSource === "debug-view" || result.inspectionSource === "debug-hybrid")
          && result.root?.attributes?.["debug-process-id"] && result.root.attributes["debug-window-name"] ? request.id : null,
        ...(result.error ? { inspectionError: result.error } : {}),
      });
      return result;
    } catch (error) {
      if (!isCurrent(request)) return null;
      const message = typeof error === "string" ? error : error instanceof Error ? error.message : "读取 UI hierarchy 失败，请确认设备仍保持连接。";
      if (request.previewShown) presentation.discard("failure");
      publish({ inspectionError: message, captureFailures: rememberCaptureFailures(state.captureFailures,
        { serial, root: null, nodeCount: 0, xmlSize: 0, rawXml: null, screenshotDataUrl: null, warning: null, error: message }, request.id) });
      if (diagnostic) throw error;
      return null;
    } finally {
      if (isCurrent(request)) { active = null; publish({ inspectionLoading: false }); }
    }
  }
  function dispose() {
    if (!connected) return;
    connected = false;
    for (const unsubscribe of subscriptions) unsubscribe();
    subscriptions = [];
    const request = active; active = null;
    if (request) void api.cancelInspection(request.id);
    publish({ inspectionLoading: false });
  }
  return {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    isConnected: () => connected,
    isCapturing: () => active !== null,
    currentRequestId: () => active?.id ?? null,
    connect() {
      if (connected) return dispose;
      connected = true;
      subscriptions.push(api.onInspectionProgress(event => {
        if (connected && active?.id === event.requestId) publish({ inspectionStage: event.stage });
      }), api.onInspectionPreview(preview));
      return dispose;
    },
    dispose, preview, inspectDevice, cancelInspection,
    invalidateLiveRequests() {
      if (!connected) return;
      const request = active; active = null;
      if (request) void api.cancelInspection(request.id);
      // A policy change revokes live work, not the document already on screen.
      publish({ inspectionLoading: false, qmlLiveRequestId: null, viewLiveRequestId: null });
    },
    clearInspection() {
      if (!connected) return;
      cancelInspection();
      publish({ qmlLiveRequestId: null, viewLiveRequestId: null, inspectionError: null });
      presentation.clear();
    },
    showSnapshot(snapshot: UiSnapshot, selectedNodeId?: string | null, capturedAt: string | null = null) {
      if (!connected) return;
      cancelInspection();
      publish({ qmlLiveRequestId: null, viewLiveRequestId: null, inspectionError: snapshot.error });
      presentation.open(snapshot, selectedNodeId, capturedAt);
    },
    tick() { if (active) publish({ inspectionElapsed: Math.floor((performance.now() - active.startedAt) / 1000) }); },
  };
}
export type InspectionSession = ReturnType<typeof createInspectionSession>;
