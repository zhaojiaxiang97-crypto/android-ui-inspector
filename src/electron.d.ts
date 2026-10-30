import type { AdbProbeResult, AppMenuAction, AppMenuState, DebugSessionEvent, DebugSessionStartOptions, DebugSessionState, ExportSnapshotRequest, ExportSnapshotResult, InspectionPreview, InspectionProgress, LayerMenuAction, LayerMenuOptions, McpShareResult, McpStopSource, NodeImageOutputRequest, QmlGroupImage, SaveSnapshotRequest, SnapshotStoreResult, UiSnapshot, ViewRefreshResult, ViewStyleResult } from "../shared/types";
import type { DebugReportExportImportResult, DebugReportExportRequest, DebugReportExportResult } from "../shared/debug-report-export";
import type { DebugTaskTemplateSaveInput, DebugTaskTemplatesResult, DebugTaskFragmentSaveInput, DebugTaskFragmentsResult,
  DebugTaskTemplateImportResult, DebugTaskTemplateExportResult } from "../shared/debug-task-templates";
import type { DebugTaskDefinition } from "../shared/debug-task";
import type { ImportTestReportResult } from "../shared/test-report";
import type { ReadOnlyCaptureScope } from "../shared/inspection-policy";
import type { ImportSnapshotFileResult } from "../shared/snapshot-file";
import type { ConnectionDiagnosticRequest, ConnectionDiagnosticReport } from "../shared/connection-diagnostics";
import type { LivePreviewEvent } from "../shared/live-preview";

declare global {
  interface Window {
    electronApi: {
      readonly runtime: { readonly sandboxed: boolean; readonly contextIsolated: boolean; readonly fixtureMode?: boolean; readonly nativeMenu?: boolean; readonly readOnlyDiagnosis?: boolean };
      updateAppMenu?: (state: AppMenuState) => Promise<void>;
      setWindowMode?: (mode: import("../shared/types").WindowMode) => Promise<void>;
      onAppMenuAction?: (callback: (action: AppMenuAction) => void) => () => void;
      probeAdb: () => Promise<AdbProbeResult>;
      diagnoseConnection?: (request: ConnectionDiagnosticRequest) => Promise<ConnectionDiagnosticReport>;
      cancelConnectionDiagnosis?: (requestId: string) => Promise<void>;
      startLivePreview?: (serial: string) => Promise<LivePreviewEvent>;
      pauseLivePreview?: (sessionId: string) => Promise<LivePreviewEvent>;
      resumeLivePreview?: (sessionId: string) => Promise<LivePreviewEvent>;
      stopLivePreview?: (sessionId?: string) => Promise<LivePreviewEvent>;
      getLivePreview?: () => Promise<LivePreviewEvent>;
      onLivePreview?: (callback: (event: LivePreviewEvent) => void) => () => void;
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
      startDebugSession?: (serial: string, options?: DebugSessionStartOptions) => Promise<DebugSessionState | null>;
      getDebugSession?: () => Promise<DebugSessionState | null>;
      loadDebugTaskTemplates?: () => Promise<DebugTaskTemplatesResult>;
      saveDebugTaskTemplate?: (input: DebugTaskTemplateSaveInput) => Promise<DebugTaskTemplatesResult>;
      deleteDebugTaskTemplate?: (id: string) => Promise<DebugTaskTemplatesResult>;
      loadDebugTaskFragments?: () => Promise<DebugTaskFragmentsResult>;
      saveDebugTaskFragment?: (input: DebugTaskFragmentSaveInput) => Promise<DebugTaskFragmentsResult>;
      deleteDebugTaskFragment?: (id: string) => Promise<DebugTaskFragmentsResult>;
      importDebugTaskTemplates?: () => Promise<DebugTaskTemplateImportResult>;
      exportDebugTaskTemplates?: () => Promise<DebugTaskTemplateExportResult>;
      defineDebugTask?: (input: { sessionId: string; definition: DebugTaskDefinition }) => Promise<Record<string, unknown>>;
      checkDebugTask?: (input: { sessionId: string; taskId: string; checkpointId?: string }) => Promise<Record<string, unknown>>;
      openDebugEvidence?: () => Promise<void>;
      onDebugSession?: (callback: (event: DebugSessionEvent) => void) => () => void;
      exportSnapshot: (request: ExportSnapshotRequest) => Promise<ExportSnapshotResult>;
      outputNodeImage?: (request: NodeImageOutputRequest) => Promise<ExportSnapshotResult>;
      importSnapshotFile?: () => Promise<ImportSnapshotFileResult>;
      loadSnapshots: () => Promise<SnapshotStoreResult>;
      importTestReport?: () => Promise<DebugReportExportImportResult>;
      importComparisonReport?: () => Promise<ImportTestReportResult>;
      loadDebugReport?: () => Promise<DebugReportExportImportResult>;
      exportDebugReportEvidence?: (request: DebugReportExportRequest) => Promise<DebugReportExportResult>;
      cancelDebugReportExport?: (requestId: string) => Promise<void>;
      saveSnapshot: (request: SaveSnapshotRequest) => Promise<SnapshotStoreResult>;
      clearSnapshots: () => Promise<SnapshotStoreResult>;
    };
  }
}

export {};
