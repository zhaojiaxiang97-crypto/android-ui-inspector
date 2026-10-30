import type { DebugInputEvidence, DebugStep } from "./types";

export type DebugScrollStopReason = "running" | "target_found" | "end_reached" | "empty" | "no_progress"
  | "scroll_limit" | "timeout" | "cancelled" | "container_missing" | "interrupted";

export type DebugScrollIteration = {
  index: number;
  startedAt: string;
  durationMs: number;
  beforeId?: string;
  afterId?: string;
  dispatchState: "not_sent" | "unknown" | "sent";
  resolvedInput?: DebugStep["resolvedInput"];
  inputEvidence?: DebugInputEvidence;
  progress: "changed" | "unchanged" | "unknown";
  error?: string;
};

export type DebugScrollProgress = {
  stopReason: DebugScrollStopReason;
  iterations: DebugScrollIteration[];
  observationIds: string[];
  scope?: { windowId: string; component: string; activityRecordId?: string;
    frame: { width: number; height: number; rotation: 0 | 1 | 2 | 3 } };
  confirmation?: { firstSnapshotId: string; secondSnapshotId: string; kind: "target" | "end_marker" | "empty" };
};

/** A later unsent gesture must not erase earlier input; uncertainty remains explicit. */
export function scrollDispatchState(progress: DebugScrollProgress): "not_sent" | "unknown" | "sent" {
  if (progress.iterations.some(item => item.dispatchState === "unknown")) return "unknown";
  return progress.iterations.some(item => item.dispatchState === "sent") ? "sent" : "not_sent";
}
