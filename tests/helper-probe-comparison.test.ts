import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { compareHelperProbes } from "../scripts/helper-probe-comparison";

function fixture() {
  let index = 0;
  return { version: 1, serial: "test-device", packageName: "com.example.sample",
    fixtureSha256: "c".repeat(64), sampleApkSha256: "d".repeat(64),
    blocks: ["a", "b", "a"].map((hash, block) => ({ apkSha256: hash.repeat(64),
      samples: Array.from({ length: 3 }, () => ({
        serial: "test-device", capturedAt: new Date(1700000000000 + ++index * 1000).toISOString(),
        nodeCount: 308, observationMs: 2000, probeWallMs: block === 1 ? 800 : 700, helperDeadlineMs: 1000,
        reply: { version: 1, sessionId: randomUUID(), requestId: randomUUID(), serviceInstanceId: randomUUID(), captureId: randomUUID(),
          packageName: "com.example.sample", windowId: "7", display: { width: 1080, height: 2400, rotation: 0 },
          readOnly: true, dispatchState: "not_sent", status: "completed", startedAtMs: 100, mainStartedAtMs: 101,
          finishedAtMs: block === 1 ? 800 : 700, preflightStage: "final_checks", preflightStageStartedAtMs: 650,
          scanDiagnostics: { version: 1, operation: "node", scanStartedAtMs: 102, operationStartedAtMs: 600,
            nodesVisited: 308, childReadsStarted: 307, childReadsCompleted: 307, childReadTotalMs: 450, childReadMaxMs: 20 } },
      })) })) };
}

test("A/B/A compares complete independent rounds without claiming an optimization", () => {
  const result = compareHelperProbes(fixture());
  assert.equal(result.baselineDriftPercent, 0);
  assert.ok(result.candidateWallDifferencePercent > 14);
  assert.ok(result.completedPreflightDifferencePercent! > 16);
  assert.deepEqual(result.groups.map(g => g.completed), [3, 3, 3]);
});

test("deadline-censored samples stay in counts and cannot produce scan speed claims", () => {
  const input = fixture();
  Object.assign(input.blocks[1].samples[0].reply, { status: "timeout", errorCode: "timeout", finishedAtMs: 1100 });
  const result = compareHelperProbes(input);
  assert.equal(result.groups[1].timeout, 1);
  assert.equal(result.groups[1].completedPreflightMedianMs, null);
  assert.equal(result.completedPreflightDifferencePercent, null);
  assert.match(result.conclusion, /实际完成耗时未知/);
});

test("rejects mismatched populations, recycled evidence and non-read-only receipts", () => {
  const changes: Array<(input: ReturnType<typeof fixture>) => void> = [
    i => { i.blocks[2].apkSha256 = "e".repeat(64); },
    i => { i.blocks[1].samples.pop(); },
    i => { i.blocks[1].samples[0].nodeCount = 758; },
    i => { i.blocks[1].samples[0].serial = "other"; },
    i => { i.blocks[1].samples[0].reply.packageName = "com.other.sample"; },
    i => { i.blocks[1].samples[0].reply.display.rotation = 1; },
    i => { i.blocks[1].samples[0].reply.requestId = i.blocks[0].samples[0].reply.requestId; },
    i => { i.blocks[1].samples[0].reply.captureId = i.blocks[0].samples[0].reply.captureId; },
    i => { i.blocks[1].samples[0].capturedAt = i.blocks[0].samples[0].capturedAt; },
    i => { i.blocks[1].samples[0].reply.dispatchState = "sent"; },
    i => { i.blocks[1].samples[0].reply.readOnly = false; },
    i => { Object.assign(i.blocks[1].samples[0].reply, { status: "rejected", errorCode: "target_mismatch" }); },
  ];
  for (const change of changes) { const input = fixture(); change(input); assert.throws(() => compareHelperProbes(input)); }
});
