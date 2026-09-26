import type { AdbProbeResult, AppMenuAction, AppMenuState, DebugSessionEvent, DebugSessionState, ExportSnapshotRequest, ExportSnapshotResult, InspectionProgress, LayerMenuAction, McpShareResult, SaveSnapshotRequest, SnapshotStoreResult, UiSnapshot } from "../shared/types";

declare global {
  interface Window {
    electronApi: {
      readonly runtime: { readonly sandboxed: boolean; readonly contextIsolated: boolean; readonly fixtureMode?: boolean; readonly nativeMenu?: boolean };
      updateAppMenu?: (state: AppMenuState) => Promise<void>;
      onAppMenuAction?: (callback: (action: AppMenuAction) => void) => () => void;
      probeAdb: () => Promise<AdbProbeResult>;
      inspectDevice: (serial: string, requestId: string) => Promise<UiSnapshot>;
      cancelInspection: (requestId: string) => Promise<void>;
      showLayerMenu: (canHide: boolean, canRestore: boolean, canExitFocus: boolean) => Promise<LayerMenuAction>;
      onInspectionProgress: (callback: (progress: InspectionProgress) => void) => () => void;
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
