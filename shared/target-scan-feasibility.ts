import { z } from "zod";
import { helperTargetProbeReply } from "./helper-target-probe";

// Accept the authentic, strictly validated read-only reply. Never retain target text, IDs,
// package, screenshot or token in the numerical analysis returned to callers.
const probeEnvelope = z.object({
  nodeCount: z.number().int().positive().max(5000),
  helperDeadlineMs: z.number().int().positive().max(7000),
  reply: helperTargetProbeReply,
}).passthrough();

export function assessTargetScanProbe(input: unknown) {
  const { nodeCount, helperDeadlineMs, reply } = probeEnvelope.parse(input);
  const scan = reply.scanDiagnostics;
  if (!scan) return {
    status: reply.status, nodeCount, helperDeadlineMs, analyzed: false as const,
    reason: "no_scan_diagnostics" as const,
  };
  const scannedDurationMs = reply.finishedAtMs - scan.scanStartedAtMs;
  const budgetAfterScanStartedMs = Math.max(0, helperDeadlineMs - (scan.scanStartedAtMs - reply.startedAtMs));
  const otherObservedMs = Math.max(0, scannedDurationMs - scan.childReadTotalMs);
  const remainingSnapshotNodes = Math.max(0, nodeCount - scan.nodesVisited);
  const sameTopologyAssumed = scan.nodesVisited <= nodeCount;
  const meanChildReadMs = scan.childReadsCompleted ? scan.childReadTotalMs / scan.childReadsCompleted : null;
  // Illustrative only: an unvisited node needs at least one traversal edge in an unchanged
  // single-window tree. Real pages can mutate, and skipped/extra windows invalidate the model.
  const estimatedTotalScanMs = sameTopologyAssumed && meanChildReadMs !== null
    ? otherObservedMs + (scan.childReadsCompleted + remainingSnapshotNodes) * meanChildReadMs : null;
  const requiredMeanChildReadMs = sameTopologyAssumed && scan.childReadsCompleted + remainingSnapshotNodes > 0
    ? Math.max(0, budgetAfterScanStartedMs - otherObservedMs) / (scan.childReadsCompleted + remainingSnapshotNodes) : null;
  const modeledReductionFraction = meanChildReadMs !== null && meanChildReadMs > 0 && requiredMeanChildReadMs !== null
    ? Math.max(0, 1 - requiredMeanChildReadMs / meanChildReadMs) : null;
  return {
    analyzed: true as const, status: reply.status, nodeCount, helperDeadlineMs,
    nodesVisited: scan.nodesVisited, childReadsStarted: scan.childReadsStarted,
    childReadsCompleted: scan.childReadsCompleted, childReadTotalMs: scan.childReadTotalMs,
    childReadMaxMs: scan.childReadMaxMs, scannedDurationMs, budgetAfterScanStartedMs,
    otherObservedMs, remainingSnapshotNodes,
    completeTreeChecked: reply.status === "completed" && scan.nodesVisited === nodeCount,
    meanChildReadMs, estimatedTotalScanMs, requiredMeanChildReadMs, modeledReductionFraction,
    estimateExceedsBudget: estimatedTotalScanMs === null ? null : estimatedTotalScanMs > budgetAfterScanStartedMs,
    estimateAssumptions: "同一窗口、快照树拓扑未变化、剩余子读取平均成本与已完成读取相同；预测不构成安全证明",
  };
}
