import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeRegressionQuality } from "../shared/regression-quality";

const planSha256 = "a".repeat(64);
function run(id: string, patch: Record<string, unknown> = {}) {
  return {
    version: 1, runId: id, planSha256, backend: "accessibility-helper", requestedRounds: 1, completedRounds: 1,
    startedAt: "2026-10-18T10:00:00.000Z", finishedAt: "2026-10-18T10:01:00.000Z",
    wallMs: 60_000, actionAttempts: 5, firstAttemptSuccessRate: 0.8,
    confirmedInputs: 5, uncertainInputs: 0, notSentInputs: 0, inputCountKnown: true,
    responseRecoveries: 0, helperAutoRecoveryReads: 0, otherAutoRecoveryReads: 0, independentResumeAttempts: 0,
    functionalPassed: true, completeSuccess: true, evidence: { complete: true }, stopCode: null,
    ...patch,
  };
}
const input = (runs: ReturnType<typeof run>[], pendingRuns = 0) =>
  ({ version: 1, candidateId: "frozen-20261018", runs, pendingRuns });

test("formal D24 0/3 without executions is pending, never three failures", () => {
  const result = summarizeRegressionQuality(input([], 3));
  assert.equal(result.plannedRuns, 3);
  assert.equal(result.attemptedRuns, 0);
  assert.equal(result.pendingRuns, 3);
  assert.equal(result.taskSuccessRate, null);
  assert.equal(result.timeoutRate, null);
  assert.equal(result.duplicateBusinessActions, null);
  assert.equal(result.recoveryDurationMs, null);
});

test("success, timeout and unknown are counted separately within one frozen plan", () => {
  const success = run("s1"), timeout = run("s2", { completedRounds: 0, completeSuccess: false,
    functionalPassed: false, stopCode: "duration_limit", wallMs: 80_000, confirmedInputs: 2, actionAttempts: 4, firstAttemptSuccessRate: 0.5 }),
    unknown = run("s3", { completedRounds: 0, completeSuccess: false, functionalPassed: false,
      stopCode: "dispatch_unknown", uncertainInputs: 1, confirmedInputs: 0, actionAttempts: 1, firstAttemptSuccessRate: 0 });
  const result = summarizeRegressionQuality(input([success, timeout, unknown], 1));
  assert.equal(result.attemptedRuns, 3);
  assert.equal(result.pendingRuns, 1);
  assert.equal(result.completeSuccessRuns, 1);
  assert.equal(result.taskSuccessRate, 1 / 3);
  assert.equal(result.timeoutRuns, 1);
  assert.equal(result.unknownDispatchRuns, 1);
  assert.equal(result.unknownDispatchCountLowerBound, 1);
  assert.equal(result.firstSuccessfulRunWallMs, 60_000);
  assert.equal(result.recoveryDurationMs, null);
});

test("unknown dispatch stop without an input receipt stays visible and has no exact rate", () => {
  const result = summarizeRegressionQuality(input([run("missing", { completedRounds: 0,
    functionalPassed: false, completeSuccess: false, stopCode: "dispatch_unknown",
    confirmedInputs: 0, uncertainInputs: 0 })]));
  assert.equal(result.unknownDispatchRuns, 1);
  assert.equal(result.unknownDispatchCountLowerBound, 1);
  assert.equal(result.unknownDispatchRate, null);
});

test("mixing candidate-independent plan versions, duplicate runs or impossible success is rejected", () => {
  const good = run("one");
  assert.throws(() => summarizeRegressionQuality(input([good, run("two", { planSha256: "b".repeat(64) })])));
  assert.throws(() => summarizeRegressionQuality(input([good, good])));
  assert.throws(() => summarizeRegressionQuality(input([run("wrong", { stopCode: "duration_limit" })])));
});
