import type { DebugStep, UiSnapshot } from "./types";
import type { DebugTaskRecord } from "./debug-task";

export const DEBUG_REPORT_VERSION = "inspector-debug-report-2" as const;
export const LEGACY_DEBUG_REPORT_VERSION = "inspector-debug-report-1" as const;
export const DEBUG_SNAPSHOT_VERSION = "inspector-debug-snapshot-1" as const;

export type DebugReportFile = { path: string; sha256: string; size: number };
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
