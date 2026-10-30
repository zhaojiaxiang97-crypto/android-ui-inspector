import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { assessTargetScanProbe } from "../shared/target-scan-feasibility";

function probe(override: Record<string, unknown> = {}) {
  return { nodeCount: 750, helperDeadlineMs: 1000,
    reply: {
      version: 1, sessionId: randomUUID(), requestId: randomUUID(), serviceInstanceId: randomUUID(),
      captureId: randomUUID(), packageName: "com.example.sample", windowId: "7",
      display: { width: 1080, height: 1920, rotation: 0 },
      readOnly: true, dispatchState: "not_sent", status: "timeout", errorCode: "timeout",
      startedAtMs: 1000, finishedAtMs: 2000, mainStartedAtMs: 1015,
      preflightStage: "target_scan", preflightStageStartedAtMs: 1052,
      scanDiagnostics: { version: 1, operation: "child", scanStartedAtMs: 1052, operationStartedAtMs: 1998,
        nodesVisited: 428, childReadsStarted: 428, childReadsCompleted: 427, childReadTotalMs: 794, childReadMaxMs: 75 },
    }, ...override };
}

test("D24 numeric projection identifies cumulative reads without claiming proof or a fix", () => {
  const result = assessTargetScanProbe(probe());
  assert.equal(result.analyzed, true);
  if (!result.analyzed) return;
  assert.equal(result.nodesVisited, 428);
  assert.equal(result.remainingSnapshotNodes, 322);
  assert.equal(result.budgetAfterScanStartedMs, 948);
  assert.equal(result.otherObservedMs, 154);
  assert.equal(result.completeTreeChecked, false);
  assert.equal(result.estimateExceedsBudget, true);
  assert.ok(result.modeledReductionFraction! > 0.4);
  assert.ok(result.estimatedTotalScanMs! > 1500);
  assert.equal("packageName" in result, false);
  assert.equal("requestId" in result, false);
});

test("missing scan data stays explicitly unknown; malformed or dispatched evidence is rejected", () => {
  const raw = probe();
  const { scanDiagnostics: _, ...without } = raw.reply;
  assert.deepEqual(assessTargetScanProbe({ ...raw, reply: { ...without, preflightStage: "window_inventory",
    preflightStageStartedAtMs: 1015 } }), {
    status: "timeout", nodeCount: 750, helperDeadlineMs: 1000,
    analyzed: false, reason: "no_scan_diagnostics",
  });
  for (const changed of [{ dispatchState: "sent" }, { readOnly: false }, { scanDiagnostics: {
    ...raw.reply.scanDiagnostics, childReadsCompleted: 430 } }])
    assert.throws(() => assessTargetScanProbe({ ...raw, reply: { ...raw.reply, ...changed } }));
});

test("changed topology invalidates model and does not invent a full-tree pass", () => {
  const raw = probe({ nodeCount: 200 });
  const result = assessTargetScanProbe(raw);
  assert.equal(result.analyzed, true);
  if (!result.analyzed) return;
  assert.equal(result.estimatedTotalScanMs, null);
  assert.equal(result.estimateExceedsBudget, null);
  assert.equal(result.completeTreeChecked, false);
});
