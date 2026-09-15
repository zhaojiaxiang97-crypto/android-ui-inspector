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
  // Exact transparent bitmap captured from a debuggable native View.
  layerImageDataUrl?: string;
  layerImageSize?: PixelSize;
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
};

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
