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

export type AppMenuAction =
  | { type: "device"; serial: string }
  | { type: "capture" | "cancel" | "refresh" | "home" | "search" | "expand-all" | "collapse-all" | "save" | "mcp-share" | "mcp-stop" | "mcp-config" | "debug-start" };

export type LayerMenuAction = "hide" | "restore" | "focus" | "exit-focus" | null;

export type AppMenuState = {
  devices: Array<Pick<DeviceInfo, "serial" | "model" | "state">>;
  selectedSerial: string;
  loading: boolean;
  capturing: boolean;
  inspecting: boolean;
  hasSnapshot: boolean;
  filtered: boolean;
  mcpSharing?: boolean;
};

export type McpShareResult = { shared: boolean; snapshotId: string | null; error: string | null };

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
};
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
export type DisplayRotation = 0 | 1 | 2 | 3;
export type HierarchyDumpMode = "full" | "compressed";
export type InspectionSource = "uiautomator" | "debug-view" | "debug-qml";
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
  // Native transparent bitmap, or self-contained SVG rebuilt from measured QML style.
  layerImageDataUrl?: string;
  layerImageSize?: PixelSize;
  // Only set after checking the full bitmap; absent means not measured.
  layerImageEmpty?: boolean;
  layerImageStatus?: "captured" | "style" | "unavailable" | "ambiguous" | "hidden" | "failed";
  // Source-specific attributes not promoted to typed properties.
  attributes?: Record<string, string>;
  children: UiNode[];
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
  captureTimings?: Record<string, number>;
  captureDurationMs?: number;
  // Fast automation observes accessibility semantics, not independent render layers.
  captureMode?: "fast" | "deep";
};

export type InspectionProgress = { requestId: string; stage: string; elapsedMs: number };

export type ExportFormat = "json" | "xml" | "png";

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
