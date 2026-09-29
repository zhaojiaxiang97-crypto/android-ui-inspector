import type { AdbProbeResult, AppMenuAction, AppMenuState, DebugSessionEvent, DebugSessionState, ExportSnapshotRequest, ExportSnapshotResult, InspectionPreview, InspectionProgress, LayerMenuAction, McpShareResult, QmlGroupImage, SaveSnapshotRequest, SnapshotStoreResult, UiSnapshot, ViewRefreshResult } from "../shared/types";

declare global {
  interface Window {
    electronApi: {
      readonly runtime: { readonly sandboxed: boolean; readonly contextIsolated: boolean; readonly fixtureMode?: boolean; readonly nativeMenu?: boolean };
      updateAppMenu?: (state: AppMenuState) => Promise<void>;
      onAppMenuAction?: (callback: (action: AppMenuAction) => void) => () => void;
      probeAdb: () => Promise<AdbProbeResult>;
      inspectDevice: (serial: string, requestId: string) => Promise<UiSnapshot>;
      captureQmlGroup: (requestId: string, nodeId: string) => Promise<QmlGroupImage | null>;
      refreshViewNode: (requestId: string, nodeId: string, scope?: "node" | "branch") => Promise<ViewRefreshResult>;
      cancelInspection: (requestId: string) => Promise<void>;
      showLayerMenu: (canHide: boolean, canRestore: boolean, canExitFocus: boolean) => Promise<LayerMenuAction>;
      onInspectionProgress: (callback: (progress: InspectionProgress) => void) => () => void;
      onInspectionPreview: (callback: (preview: InspectionPreview) => void) => () => void;
      copyText: (value: string) => Promise<void>;
      shareMcpSnapshot?: (snapshot: UiSnapshot, selectedNodeId: string | null) => Promise<McpShareResult>;
      stopMcpSharing?: () => Promise<void>;
      copyMcpConfig?: () => Promise<void>;
      startDebugSession?: (serial: string) => Promise<DebugSessionState | null>;
      getDebugSession?: () => Promise<DebugSessionState | null>;
      openDebugEvidence?: () => Promise<void>;
      onDebugSession?: (callback: (event: DebugSessionEvent) => void) => () => void;
      exportSnapshot: (request: ExportSnapshotRequest) => Promise<ExportSnapshotResult>;
      loadSnapshots: () => Promise<SnapshotStoreResult>;
      saveSnapshot: (request: SaveSnapshotRequest) => Promise<SnapshotStoreResult>;
      clearSnapshots: () => Promise<SnapshotStoreResult>;
    };
  }
}

export {};
