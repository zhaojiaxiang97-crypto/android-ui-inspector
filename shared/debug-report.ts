import type { DebugStep, UiSnapshot } from "./types";
import type { DebugTaskRecord } from "./debug-task";

export const DEBUG_REPORT_VERSION = "inspector-debug-report-2" as const;
export const LEGACY_DEBUG_REPORT_VERSION = "inspector-debug-report-1" as const;
export const DEBUG_SNAPSHOT_VERSION = "inspector-debug-snapshot-1" as const;

export type DebugReportFile = { path: string; sha256: string; size: number };
export const DEBUG_LOG_LIMITS = { maxLines: 200, maxBytes: 128 * 1024, maxSources: 2 } as const;
export type DebugLogEvidence = {
  source: "session" | "android";
  sessionId: string;
  stepId: number;
  packageName: string;
  startedAt: string;
  finishedAt: string;
  status: "available" | "empty" | "unavailable" | "cancelled";
  attribution: "confirmed" | "missing";
  reason: string | null;
  truncated: boolean;
  lineCount: number;
  file: DebugReportFile | null;
  androidScope: { pid: number; processStartTicks: string; deviceStartedAt: number; deviceFinishedAt: number } | null;
  // Added only after local attachment verification; never trusted from report.json.
  text?: string;
  loadError?: string | null;
};
export type DebugLogCapture = { evidence: DebugLogEvidence; text: string | null };
export type DebugSnapshotReference = {
  snapshotId: string | null;
  freshness: "current" | "previous" | "missing";
  reason: string | null;
};
export type DebugSnapshotEvidence = {
  snapshotId: string;
  capturedAt: string;
  source: string;
  tree: DebugReportFile | null;
  screenshot: DebugReportFile | null;
  warnings: string[];
};
export type DebugReportStep = {
  step: DebugStep;
  finishedAt: string;
  durationMs: number;
  verified: boolean | null;
  before: DebugSnapshotReference;
  after: DebugSnapshotReference;
  logs?: DebugLogEvidence[];
};
export type DebugSessionReport = {
  schemaVersion: typeof DEBUG_REPORT_VERSION | typeof LEGACY_DEBUG_REPORT_VERSION;
  session: {
    id: string;
    serial: string;
    packageName: string;
    startedAt: string;
    updatedAt: string;
    active: boolean;
    stopReason: string | null;
    totalSteps: number;
    droppedSteps: number;
    progress?: import("./debug-progress").DebugSessionProgressState;
    androidLogsEnabled?: boolean;
  };
  limits: {
    maxSteps: number; maxSnapshots: number; maxImages: number; maxBytes: number;
    maxTreeBytes: number; maxImageBytes: number;
  };
  storage: { bytes: number };
  steps: DebugReportStep[];
  snapshots: DebugSnapshotEvidence[];
  task?: DebugTaskRecord | null;
};

// Saved tree/properties and screen image are separate. Independent layer bitmaps
// are deliberately omitted, and this document cannot authorize device input.
export type DebugSnapshotDocument = {
  schemaVersion: typeof DEBUG_SNAPSHOT_VERSION;
  snapshotId: string;
  capturedAt: string;
  content: "tree-properties-without-layer-bitmaps";
  snapshot: UiSnapshot;
};
