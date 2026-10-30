import type { AdbProbeResult, AppMenuAction, AppMenuState, DebugSessionEvent, DebugSessionStartOptions, DebugSessionState, ExportSnapshotRequest, ExportSnapshotResult, InspectionPreview, InspectionProgress, LayerMenuAction, LayerMenuOptions, McpShareResult, McpStopSource, NodeImageOutputRequest, QmlGroupImage, SaveSnapshotRequest, SnapshotStoreResult, UiSnapshot, ViewRefreshResult, ViewStyleResult } from "./types";
import type { DebugReportExportImportResult, DebugReportExportRequest, DebugReportExportResult } from "./debug-report-export";
import type { DebugTaskTemplateSaveInput, DebugTaskTemplatesResult, DebugTaskFragmentSaveInput, DebugTaskFragmentsResult,
  DebugTaskTemplateImportResult, DebugTaskTemplateExportResult } from "./debug-task-templates";
import type { DebugTaskDefinition } from "./debug-task";
import type { ImportTestReportResult } from "./test-report";
import type { ReadOnlyCaptureScope } from "./inspection-policy";
import type { ImportSnapshotFileResult } from "./snapshot-file";
import type { ConnectionDiagnosticRequest, ConnectionDiagnosticReport } from "./connection-diagnostics";
import type { LivePreviewEvent } from "./live-preview";
import type { InspectionMode, InspectionModeState } from "./inspection-mode";
import type { DebugPlanDefinition, DebugPlanRun } from "./debug-plan";

export type DebugPlanDesktopCommand =
  | { name: "start_debug_plan"; input: { sessionId: string; runId: string; definition: DebugPlanDefinition } }
  | { name: "get_debug_plan" | "cancel_debug_plan"; input: { sessionId: string; runId: string } };
export type DebugPlanDesktopResult = { run: DebugPlanRun; replayed?: boolean } | { found: false; runId: string };

/** Public preload contract. Optional members remain optional for older runtimes and offline fixtures. */
export interface DesktopApi {
  readonly runtime: { readonly sandboxed: boolean; readonly contextIsolated: boolean; readonly fixtureMode?: boolean; readonly nativeMenu?: boolean; readonly readOnlyDiagnosis?: boolean };
  updateAppMenu?: (state: AppMenuState) => Promise<void>;
  setWindowMode?: (mode: import("./types").WindowMode) => Promise<void>;
  onAppMenuAction?: (callback: (action: AppMenuAction) => void) => () => void;
  getInspectionMode?: () => Promise<InspectionModeState>;
  setInspectionMode?: (mode: InspectionMode) => Promise<InspectionModeState>;
  onInspectionMode?: (callback: (state: InspectionModeState) => void) => () => void;
  probeAdb: () => Promise<AdbProbeResult>;
  diagnoseConnection?: (request: ConnectionDiagnosticRequest) => Promise<ConnectionDiagnosticReport>;
  cancelConnectionDiagnosis?: (requestId: string) => Promise<void>;
  startLivePreview?: (serial: string) => Promise<LivePreviewEvent>;
  pauseLivePreview?: (sessionId: string) => Promise<LivePreviewEvent>;
  resumeLivePreview?: (sessionId: string) => Promise<LivePreviewEvent>;
  stopLivePreview?: (sessionId?: string) => Promise<LivePreviewEvent>;
  getLivePreview?: () => Promise<LivePreviewEvent>;
  onLivePreview?: (callback: (event: LivePreviewEvent) => void) => () => void;
  inspectDevice: (serial: string, requestId: string, priorityViewRef?: string | null, singleAttempt?: boolean, scope?: ReadOnlyCaptureScope, layerCapture?: import("./types").LayerCaptureMode) => Promise<UiSnapshot>;
  captureLayerImages?: (requestId: string, nodeIds: string[]) => Promise<import("./types").LayerImageCaptureResult>;
  cancelLayerImages?: (requestId: string) => Promise<void>;
  captureGroup: (requestId: string, nodeId: string) => Promise<QmlGroupImage | null>;
  refreshViewNode: (requestId: string, nodeId: string, scope?: "node" | "branch" | "list") => Promise<ViewRefreshResult>;
  readViewStyle: (requestId: string, nodeId: string) => Promise<ViewStyleResult>;
  readViewFont?: (requestId: string, nodeId: string) => Promise<import("./view-font").ViewFontResult>;
  cancelViewFont?: (requestId: string) => Promise<void>;
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
  debugPlanCommand?: (command: DebugPlanDesktopCommand) => Promise<DebugPlanDesktopResult>;
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
}
