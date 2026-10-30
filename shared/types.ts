export type DeviceInfo = {
  serial: string;
  state: string;
  model: string | null;
  androidVersion: string | null;
  product: string | null;
  transportId: string | null;
};

export type AdbProbeResult = {
  adbPath: string | null;
  adbVersion: string | null;
  devices: DeviceInfo[];
  error: string | null;
};

export type WindowMode = "home" | "workspace";

export type AppMenuAction =
  | { type: "device"; serial: string }
  | { type: "double-click"; action: TreeDoubleClickAction }
  | { type: "capture" | "cancel" | "refresh" | "home" | "search" | "expand-all" | "collapse-all" | "save" | "history" | "open-snapshot" | "export-snapshot" | "export-json" | "export-xml" | "export-png" | "preferences" | "mcp-share" | "mcp-stop" | "mcp-config" | "debug-start" | "test-report" | "focus-branch" | "focus-layer" | "exit-focus" | "expand-selected" | "collapse-selected" | "hide-selected" | "restore-layers" };

export type TreeDoubleClickAction = "toggle" | "focus-branch" | "expand";
export type LayerFocus = { node: UiNode; kind: "branch" | "layer" };
export type LayerCopyAction = "copy-text" | "copy-resource-id" | "copy-class-name" | "copy-hierarchy-path";
export type LayerLocalAction = "restore-selected" | "locate-hidden-ancestor" | "expand-branch" | "collapse-children";
export type LayerImageAction = "preview-image-own" | "preview-image-branch" | "copy-image-own" | "copy-image-branch" | "save-image-own" | "save-image-branch";
export type LayerImageScopeOption = { scope: "own" | "branch"; available: boolean; label: string; detail: string };
export type LayerRefreshAction = "refresh-node" | "refresh-branch";
export type LayerRefreshScopeOption = { scope: "node" | "branch"; available: boolean; detail: string };
export type LayerMenuMode = "flat" | "layers3d";
export type LayerMenuAction = "hide" | "restore" | "focus" | "focus-branch" | "exit-focus" | "expand" | "collapse" | LayerLocalAction | LayerCopyAction | LayerImageAction | LayerRefreshAction | null;
export type LayerMenuOptions = {
  canFocus: boolean; expandable: boolean; expanded: boolean; copyActions?: LayerCopyAction[];
  canRestoreSelected?: boolean; hasChildren?: boolean; hiddenAncestorLabel?: string; imageScopes?: LayerImageScopeOption[];
  mode?: LayerMenuMode; refreshScopes?: LayerRefreshScopeOption[];
};

export type AppMenuState = {
  devices: Array<Pick<DeviceInfo, "serial" | "model" | "state">>;
  selectedSerial: string;
  loading: boolean;
  capturing: boolean;
  inspecting: boolean;
  hasSnapshot: boolean;
  filtered: boolean;
  canCapture?: boolean;
  canSelectDevice?: boolean;
  hasRawXml?: boolean;
  hasScreenshot?: boolean;
  historyLoading?: boolean;
  openingSnapshot?: boolean;
  mcpSharing?: boolean;
  canFocus?: boolean;
  canHideLayer?: boolean;
  hasHiddenLayers?: boolean;
  hasLayerFocus?: boolean;
  selectedExpandable?: boolean;
  selectedExpanded?: boolean;
  doubleClickAction?: TreeDoubleClickAction;
};

export type McpShareResult = { shared: boolean; snapshotId: string | null; error: string | null };

export const mcpStopReasons = {
  explicit: "界面请求停止自动调试",
  "snapshot-change": "工作台切换快照，停止自动调试",
  history: "查看历史快照，停止自动调试",
  home: "返回设备列表，停止自动调试",
  "device-change": "切换设备，停止自动调试",
} as const;
export type McpStopSource = keyof typeof mcpStopReasons;

export type DebugInputEvidence = {
  classification: "accepted" | "permission-denied" | "device-unavailable" | "invalid-command" | "command-failed"
    | "unexpected-output" | "cancelled" | "timeout" | "output-limit" | "spawn-failed" | "unconfirmed-exit";
  spawned: boolean;
  closed: boolean;
  exitCode: number | null;
  signal: string | null;
  errorCode?: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type DebugInputAction =
  | { kind: "tap"; x: number; y: number }
  | { kind: "swipe"; fromX: number; fromY: number; toX: number; toY: number; durationMs: number }
  | { kind: "back" };

export type DebugStepError = {
  category: string;
  code: string;
  phase: "capture" | "locate" | "input" | "verify" | "recording";
  message: string;
};

export type DebugStep = {
  id: number;
  time: string;
  action: string;
  input: Record<string, unknown>;
  status: "running" | "done" | "failed";
  message: string;
  beforeId?: string;
  afterId?: string;
  dispatchState?: "not_sent" | "unknown" | "sent";
  inputEvidence?: DebugInputEvidence;
  resolvedInput?: { action: DebugInputAction; frame: DisplayFrame; targetNodeId?: string; anchorNodeId?: string;
    scrollRegion?: { viewport: Pick<UiBounds, "left" | "top" | "right" | "bottom">;
      confirmationBounds: Pick<UiBounds, "left" | "top" | "right" | "bottom">;
      excludedNavigationBounds: Pick<UiBounds, "left" | "top" | "right" | "bottom">[] };
    visualConfirmation?: { referenceSnapshotId: string; currentSnapshotId: string; description: string;
      region: { left: number; top: number; width: number; height: number }; sha256: string; overlapNodeIds: string[] } };
  error?: DebugStepError;
  recordingErrors?: DebugStepError[];
  // Absent in legacy reports; missing measurements must not be displayed as zero.
  timings?: import("./debug-timing").DebugTimings;
  scrollTask?: import("./debug-scroll").DebugScrollProgress;
  verified?: boolean | null;
  taskCheck?: import("./debug-task").DebugTaskCheckResult;
};
export type DebugSessionState = {
  id: string;
  serial: string;
  packageName: string;
  active: boolean;
  busy: boolean;
  expiresAt: string;
  steps: DebugStep[];
  evidencePath: string | null;
  reportPath?: string | null;
  task?: import("./debug-task").DebugTaskRecord | null;
  stopReason?: string | null;
  startedAt?: string;
  revision?: number;
  androidLogsEnabled?: boolean;
  progress?: import("./debug-progress").DebugSessionProgressState;
};
export type DebugSessionStartOptions = { androidLogs?: boolean };
export type DebugSessionEvent = {
  state: DebugSessionState;
  snapshot?: UiSnapshot;
  selectedNodeId?: string | null;
};

export type UiBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  raw: string;
};

export type PixelSize = { width: number; height: number };
export type QmlGroupImage = { dataUrl: string; size: PixelSize; capturedAt: string };
export type SnapshotGroupImage = { nodeId: string; image: QmlGroupImage };
export type DisplayRotation = 0 | 1 | 2 | 3;
export type HierarchyDumpMode = "full" | "compressed";
export type FastCaptureBackend = "uiautomator" | "accessibility-helper";
export type InspectionSource = FastCaptureBackend | "debug-view" | "debug-qml" | "debug-hybrid";
export type DisplayFrame = PixelSize & { rotation: DisplayRotation };
export type CaptureGeometry = {
  hierarchyRotation: DisplayRotation | null;
  beforeScreenshot: DisplayFrame | null;
  afterScreenshot: DisplayFrame | null;
  screenshotSize: PixelSize;
};

export type UiNode = {
  id: string;
  index: number | null;
  className: string | null;
  package: string | null;
  text: string | null;
  resourceId: string | null;
  contentDesc: string | null;
  bounds: UiBounds | null;
  clickable: boolean;
  enabled: boolean;
  focusable: boolean;
  focused: boolean;
  scrollable: boolean;
  selected: boolean;
  visibleToUser: boolean;
  // Explicit source evidence; legacy nodes and missing/invalid flags remain unknown.
  visibilityEvidence?: "visible" | "hidden" | "unknown";
  // Native transparent bitmap, or self-contained SVG rebuilt from measured QML style.
  layerImageDataUrl?: string;
  layerImageSize?: PixelSize;
  // Verified view-local image placement; never used for folded subtree composition.
  layerCapturePlacement?: import("./capture-transform").LayerCapturePlacement;
  // Only set after checking the full bitmap; absent means not measured.
  layerImageEmpty?: boolean;
  layerImageStatus?: "captured" | "style" | "unavailable" | "ambiguous" | "hidden" | "failed" | "deferred";
  // Explicit values from the SDK; absent means no registered business information.
  debugMetadata?: import("./debug-metadata").DebugMetadata;
  // Source-specific attributes not promoted to typed properties.
  attributes?: Record<string, string>;
  children: UiNode[];
};

export type ViewRefreshResult = { nodes: UiNode[]; failures: { id: string; message: string }[]; branch?: UiNode; timings?: Record<string, number> };
export type LayerCaptureMode = "on-demand" | "full";
export type LayerImageCaptureResult = { updates: LayerImageUpdate[]; failures: { id: string; message: string }[]; timings?: Record<string, number> };
export type ViewStyleResult = { ref: string; capturedAtMillis: number; backgroundType: string | null; backgroundColor: string | null; textColor: string | null; textSizePx: number | null };

export type FocusUnavailableReason = "null-focus" | "non-primary-display" | "missing-primary-display" | "missing-focus-field" | "ambiguous-focus-field" | "unrecognized-focus-format";

export type ReadinessObservation = {
  kind: "foreground" | "focus-candidate" | "focus-confirm-before" | "focus-confirm-after" | "poll-wait" | "budget-stop";
  result: "returned" | "match" | "changed" | "unavailable" | "error" | "waited" | "insufficient-budget";
  startedMs: number;
  endedMs: number;
  remainingMs: number;
  component: string | null;
  windowId: string | null;
  // Optional for older diagnostics; never raw system output or exception text.
  focusReason?: FocusUnavailableReason;
};

export type CaptureReadiness = {
  budgetMs: number;
  elapsedMs: number;
  phase: "foreground" | "debug-check" | "focus-before" | "tree" | "focus-after" | "ready";
  // First completed strict permission/Activity/focus confirmation, not window creation time.
  firstFocusedWindowMs: number | null;
  focus: { component: string; activityRecordId: string | null; windowId: string } | null;
  treeReadCount: number;
  treeReads: { startedMs: number; endedMs: number }[];
  rejection: string | null;
  // Optional for old snapshots. First observation + newest 63; gaps are explicit.
  observations?: { totalCount: number; droppedCount: number; entries: ReadinessObservation[] };
};

export type CaptureAttempt = {
  attempt: number;
  startedMs: number;
  durationMs: number;
  error: string | null;
  warning: string | null;
  processId: string | null;
  timings: Record<string, number>;
  sdkFailure: Record<string, string>;
  sdkTasks?: Record<string, string>;
  sdkGeometry?: Record<string, string>;
  viewHierarchy?: Record<string, string>;
  readiness?: CaptureReadiness;
};
export type CaptureRequestDiagnostics = {
  totalDurationMs: number;
  totalAttempts: number;
  droppedAttempts: number;
  attempts: CaptureAttempt[];
};

export type UiSnapshot = {
  serial: string;
  root: UiNode | null;
  nodeCount: number;
  xmlSize: number;
  rawXml: string | null;
  screenshotDataUrl: string | null;
  error: string | null;
  warning: string | null;
  // Optional for snapshots created before Debug-only inspection was added.
  inspectionSource?: InspectionSource;
  // Optional for snapshots created before full hierarchy capture was added.
  hierarchyDumpMode?: HierarchyDumpMode;
  // Optional so snapshots saved before display checks remain readable.
  captureGeometry?: CaptureGeometry;
  helperObservation?: import("./helper-observation").HelperObservationEvidence;
  captureTimings?: Record<string, number>;
  captureDurationMs?: number;
  // Bounded request-level diagnostics; never authorizes images or automation.
  captureRequestDiagnostics?: CaptureRequestDiagnostics;
  captureReadiness?: CaptureReadiness;
  // Fast automation observes accessibility semantics, not independent render layers.
  captureMode?: "fast" | "deep";
  // Standard Debug capture can defer independent images until a branch is viewed.
  layerCapture?: LayerCaptureMode;
  // Already captured native subtree images; opening a saved snapshot never fetches them.
  layerGroupImages?: SnapshotGroupImage[];
};

export type InspectionProgress = { requestId: string; stage: string; elapsedMs: number };
export type LayerImageUpdate = Pick<UiNode, "id" | "layerImageDataUrl" | "layerImageSize" | "layerImageEmpty" | "layerImageStatus" | "layerCapturePlacement"> & {
  // Baseline geometry detects atomic branch replacements; changed geometry needs a full tree preview.
  bounds?: UiNode["bounds"];
  imageSource?: string;
  imageCaptureSource?: string;
  imageCaptureError?: string;
  skipDraw?: string;
};
export type InspectionPreview = { requestId: string } & (
  | { phase: "tree"; snapshot: UiSnapshot }
  | { phase: "layers"; updates: LayerImageUpdate[] }
  | { phase: "screen"; screen: Pick<UiSnapshot, "screenshotDataUrl" | "captureGeometry"> }
);

export type ExportFormat = "snapshot" | "json" | "xml" | "png";

export type ExportSnapshotRequest = {
  format: ExportFormat;
  data: string;
  defaultFileName: string;
};

export type ExportSnapshotResult = {
  canceled: boolean;
  filePath: string | null;
  error: string | null;
};

export type NodeImageOutputRequest = {
  action: "save" | "copy";
  dataUrl: string;
  size: PixelSize | null;
  defaultFileName: string;
};

export type StoredSnapshot = {
  id: string;
  capturedAt: string;
  savedAt: string;
  snapshot: UiSnapshot;
};

export type SnapshotStoreResult = {
  snapshots: StoredSnapshot[];
  error: string | null;
};

export type SaveSnapshotRequest = {
  capturedAt: string;
  snapshot: UiSnapshot;
};
