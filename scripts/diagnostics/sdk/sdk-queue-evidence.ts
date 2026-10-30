import { bindQueueNotice, parseQueueEvent, type QueueEvent } from "./sdk-queue-observer";
import { createQueueStackGate, queueStackEvidenceMatches, type QueueIdentity, type QueueNotice } from "./sdk-queue-stack-policy";

/** SDK elapsedRealtime state reads bracket the pause, without mixing host/device clocks.
 * Before must be read BEFORE suspend and after AFTER verified resume. Flooring makes the
 * pre-read a lower bound; post-read +1ms is a conservative upper bound.
 */
export function queueDeviceBounds(before: QueueEvent, after: QueueEvent) {
  before = parseQueueEvent(JSON.stringify(before)); after = parseQueueEvent(JSON.stringify(after));
  if (before.phase !== "state" || after.phase !== "state" || before.requestId !== after.requestId
    || before.pid !== after.pid || before.processInstance !== after.processInstance || before.kind !== after.kind
    || before.postedMs !== after.postedMs || after.observedMs < before.observedMs
    || before.enteredMs !== -1 || before.settledMs !== -1 || !Number.isSafeInteger(after.observedMs + 1))
    throw Error("Invalid device time bracket");
  return { startedDeviceMs: before.observedMs, resumedDeviceMs: after.observedMs + 1, roundingUpperMs: 1 };
}

/** Only accepts a same-task FINAL settled state and verified post-resume identity/cleanup.
 * This does not execute a device command or turn a single stack into causal/performance proof.
 */
export function validateQueueEvidence(expected: QueueIdentity, notice: QueueNotice, before: QueueEvent,
  after: QueueEvent, final: QueueEvent, verifiedAfter: QueueIdentity,
  sample: { resumeVerified: boolean; forwardRemoved: boolean; frames: number }) {
  createQueueStackGate(expected); createQueueStackGate(verifiedAfter);
  if (!/^sdk-source-v1:[a-f0-9]{64}$/.test(expected.sdkVersion)) throw Error("Verified SDK source identity required");
  before = parseQueueEvent(JSON.stringify(before)); after = parseQueueEvent(JSON.stringify(after));
  const bounds = queueDeviceBounds(before, after);
  final = parseQueueEvent(JSON.stringify(final));
  for (const state of [before, after, final]) bindQueueNotice(state, expected, 0);
  if (final.phase !== "state" || final.kind !== before.kind || final.postedMs !== before.postedMs
    || final.observedMs < after.observedMs || final.settledMs === -1) throw Error("Final queue state unavailable or changed");
  // Lifecycle fields cannot go backwards when a task settles after the post-resume read.
  for (const key of ["enteredMs", "endedMs", "settledMs"] as const)
    if (after[key] !== -1 && final[key] !== after[key]) throw Error("Queue lifecycle changed");
  const covered = queueStackEvidenceMatches(expected, notice,
    { identity: verifiedAfter, postedMs: final.postedMs, enteredMs: final.enteredMs, settledMs: final.settledMs },
    { identity: verifiedAfter, ...bounds, resumeVerified: sample.resumeVerified,
      forwardRemoved: sample.forwardRemoved, frames: sample.frames });
  return { status: covered ? "queue-covered" as const : "queue-uncovered" as const, ...bounds };
}
