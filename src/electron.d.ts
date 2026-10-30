import type { AdbProbeResult, AppMenuAction, AppMenuState, DebugSessionEvent, DebugSessionState, ExportSnapshotRequest, ExportSnapshotResult, InspectionPreview, InspectionProgress, LayerMenuAction, LayerMenuOptions, McpShareResult, McpStopSource, NodeImageOutputRequest, QmlGroupImage, SaveSnapshotRequest, SnapshotStoreResult, UiSnapshot, ViewRefreshResult, ViewStyleResult } from "../shared/types";
import type { ImportTestReportResult } from "../shared/test-report";
import type { ReadOnlyCaptureScope } from "../shared/inspection-policy";
import type { ImportSnapshotFileResult } from "../shared/snapshot-file";

declare global {
  interface Window {
    electronApi: {
      readonly runtime: { readonly sandboxed: boolean; readonly contextIsolated: boolean; readonly fixtureMode?: boolean; readonly nativeMenu?: boolean; readonly readOnlyDiagnosis?: boolean };
      updateAppMenu?: (state: AppMenuState) => Promise<void>;
      onAppMenuAction?: (callback: (action: AppMenuAction) => void) => () => void;
      probeAdb: () => Promise<AdbProbeResult>;
      inspectDevice: (serial: string, requestId: string, priorityViewRef?: string | null, singleAttempt?: boolean, scope?: ReadOnlyCaptureScope) => Promise<UiSnapshot>;
      captureGroup: (requestId: string, nodeId: string) => Promise<QmlGroupImage | null>;
      refreshViewNode: (requestId: string, nodeId: string, scope?: "node" | "branch" | "list") => Promise<ViewRefreshResult>;
      readViewStyle: (requestId: string, nodeId: string) => Promise<ViewStyleResult>;
      cancelInspection: (requestId: string) => Promise<void>;
      showLayerMenu: (canHide: boolean, canRestore: boolean, canExitFocus: boolean, options?: LayerMenuOptions) => Promise<LayerMenuAction>;
      onInspectionProgress: (callback: (progress: InspectionProgress) => void) => () => void;
      onInspectionPreview: (callback: (preview: InspectionPreview) => void) => () => void;
      copyText: (value: string) => Promise<void>;
      shareMcpSnapshot?: (snapshot: UiSnapshot, selectedNodeId: string | null) => Promise<McpShareResult>;
      stopMcpSharing?: (source?: McpStopSource) => Promise<void>;
      copyMcpConfig?: () => Promise<void>;
      startDebugSession?: (serial: string) => Promise<DebugSessionState | null>;
      getDebugSession?: () => Promise<DebugSessionState | null>;
      openDebugEvidence?: () => Promise<void>;
      onDebugSession?: (callback: (event: DebugSessionEvent) => void) => () => void;
      exportSnapshot: (request: ExportSnapshotRequest) => Promise<ExportSnapshotResult>;
      outputNodeImage?: (request: NodeImageOutputRequest) => Promise<ExportSnapshotResult>;
      importSnapshotFile?: () => Promise<ImportSnapshotFileResult>;
      loadSnapshots: () => Promise<SnapshotStoreResult>;
      importTestReport?: () => Promise<ImportTestReportResult>;
      loadDebugReport?: () => Promise<ImportTestReportResult>;
      saveSnapshot: (request: SaveSnapshotRequest) => Promise<SnapshotStoreResult>;
      clearSnapshots: () => Promise<SnapshotStoreResult>;
    };
  }
}

export {};
