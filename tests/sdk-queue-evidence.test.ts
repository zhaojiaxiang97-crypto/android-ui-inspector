import assert from "node:assert/strict";
import { test } from "node:test";
import { queueDeviceBounds, validateQueueEvidence } from "../scripts/diagnostics/sdk/sdk-queue-evidence";
import { bindQueueNotice, type QueueEvent } from "../scripts/diagnostics/sdk/sdk-queue-observer";
const identity = { apkSha256: "a".repeat(64), sdkVersion: `sdk-source-v1:${"b".repeat(64)}`, pid: 42,
  startTicks: "12345", processInstance: "22222222-2222-2222-2222-222222222222", requestId: "11111111-1111-1111-1111-111111111111" };
const state = (patch: Partial<QueueEvent> = {}): QueueEvent => ({ event: "tree-queue", protocol: "tree-queue-v1",
  phase: "state", kind: "classic", pid: 42, processInstance: identity.processInstance, requestId: identity.requestId,
  postedMs: 100000, enteredMs: -1, endedMs: -1, settledMs: -1, observedMs: 100620, ...patch });
const before = state(), after = state({ observedMs: 100700 });
const final = state({ observedMs: 103100, enteredMs: 100800, endedMs: 100900, settledMs: 103000 });
const notice = bindQueueNotice(before, identity, 10), sample = { resumeVerified: true, forwardRemoved: true, frames: 1 };
test("SDK elapsedRealtime states conservatively bracket sample and final settled state certifies coverage", () => {
  assert.deepEqual(queueDeviceBounds(before, after), { startedDeviceMs: 100620, resumedDeviceMs: 100701, roundingUpperMs: 1 });
  assert.equal(validateQueueEvidence(identity, notice, before, after, final, identity, sample).status, "queue-covered");
  const timedOut = state({ observedMs: 103100, settledMs: 103000 });
  assert.equal(validateQueueEvidence(identity, notice, before, after, timedOut, identity, sample).status, "queue-covered");
});
test("rounding overlap, entered task, failed resume or missing cleanup cannot certify coverage", () => {
  const overlap = state({ observedMs: 103100, enteredMs: 100701, endedMs: 100900, settledMs: 103000 });
  assert.equal(validateQueueEvidence(identity, notice, before, after, overlap, identity, sample).status, "queue-uncovered");
  const enteredAfter = state({ observedMs: 100850, enteredMs: 100800 });
  assert.equal(validateQueueEvidence(identity, notice, before, enteredAfter, final, identity, sample).status, "queue-uncovered");
  for (const patch of [{ resumeVerified: false }, { forwardRemoved: false }, { frames: 33 }, { frames: 0 }])
    assert.equal(validateQueueEvidence(identity, notice, before, after, final, identity, { ...sample, ...patch }).status, "queue-uncovered");
});
test("wrong process/build/request and backwards or changed lifecycle are refused", () => {
  assert.throws(() => validateQueueEvidence({ ...identity, sdkVersion: "tree-queue-v1" }, notice, before, after, final, identity, sample), /SDK source/);
  assert.throws(() => queueDeviceBounds(before, state({ pid: 99 })), /bracket/);
  assert.throws(() => queueDeviceBounds(before, state({ observedMs: 100600 })), /bracket/);
  assert.throws(() => validateQueueEvidence(identity, notice, before, after, state(), identity, sample), /Final/);
  assert.throws(() => validateQueueEvidence(identity, notice, before, after, { ...final, pid: 99 }, identity, sample), /identity/);
  assert.equal(validateQueueEvidence(identity, notice, before, after, final, { ...identity, startTicks: "12346" }, sample).status, "queue-uncovered");
  assert.equal(validateQueueEvidence(identity, notice, before, after, final, { ...identity, sdkVersion: "foreign" }, sample).status, "queue-uncovered");
  const enteredAfter = state({ observedMs: 100850, enteredMs: 100800 });
  assert.throws(() => validateQueueEvidence(identity, notice, before, enteredAfter, { ...final, enteredMs: 100801 }, identity, sample), /lifecycle/);
});
test("runtime extra fields cannot overwrite conservative time bounds", () => {
  const forged = { ...sample, startedDeviceMs: 100650, resumedDeviceMs: 100650, identity };
  const result = validateQueueEvidence(identity, notice, before, after, final, identity, forged);
  assert.equal(result.resumedDeviceMs, 100701); assert.equal(result.startedDeviceMs, 100620);
});
