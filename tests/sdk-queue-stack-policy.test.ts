import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueueStackGate, queueStackEvidenceMatches } from "../scripts/diagnostics/sdk/sdk-queue-stack-policy";
const identity = { apkSha256: "a".repeat(64), sdkVersion: "test-queue-v1", pid: 42, startTicks: "12345",
  processInstance: "test-instance", requestId: "12345678-1234-1234-1234-123456789abc" };
const notice = () => ({ identity: { ...identity }, postedMs: 100000, observedMs: 100600,
  enteredMs: -1, settledMs: -1, receivedHostMs: 200 });
const final = () => ({ identity: { ...identity }, postedMs: 100000, enteredMs: -1, settledMs: 103000 });
const sample = () => ({ identity: { ...identity }, startedDeviceMs: 100700, resumedDeviceMs: 100710,
  resumeVerified: true, forwardRemoved: true, frames: 12 });

test("queue sampling reserves once, including after a failed attachment", () => {
  const gate = createQueueStackGate(identity);
  assert.equal(gate.reserve(notice(), 210, true), "sample-reserved");
  assert.equal(gate.reserve(notice(), 220, true), "already-attempted");
});
test("merged tree nonce and classic UUID are both accepted without confusing requests", () => {
  const merged = { ...identity, requestId: "0123456789abcdef" };
  const gate = createQueueStackGate(merged);
  assert.equal(gate.reserve(notice(), 210, true), "identity-mismatch");
  assert.equal(gate.reserve({ ...notice(), identity: merged }, 210, true), "sample-reserved");
});
test("wrong process, package, SDK, instance or request never reserves", () => {
  for (const field of Object.keys(identity) as (keyof typeof identity)[]) {
    const n = notice(); (n.identity as Record<string, unknown>)[field] = field === "pid" ? 43 : "wrong";
    const gate = createQueueStackGate(identity);
    assert.equal(gate.reserve(n, 210, true), "identity-mismatch");
    assert.equal(gate.reserve(notice(), 210, true), "sample-reserved");
  }
  assert.throws(() => createQueueStackGate({ ...identity, apkSha256: "" }), /Invalid/);
});
test("cancelled, finished, stale, early and late notices do not authorize a stack", () => {
  const check = (n: ReturnType<typeof notice>, host: number, active = true) => createQueueStackGate(identity).reserve(n, host, active);
  assert.equal(check(notice(), 210, false), "request-ended");
  assert.equal(check({ ...notice(), enteredMs: 100300 }, 210), "task-not-queued");
  assert.equal(check({ ...notice(), settledMs: 100500 }, 210), "task-not-queued");
  assert.equal(check(notice(), 451), "stale-notice");
  assert.equal(check(notice(), 199), "invalid-time");
  assert.equal(check({ ...notice(), observedMs: 100499 }, 210), "too-early");
  assert.equal(check({ ...notice(), observedMs: 102500 }, 210), "too-late");
});
test("post-check binds the sample to the queued interval and successful cleanup", () => {
  assert.equal(queueStackEvidenceMatches(identity, notice(), final(), sample()), true);
  for (const patch of [{ enteredMs: 100705 }, { settledMs: 100710 }, { postedMs: 99999 },
    { identity: { ...identity, pid: 99 } }]) {
    assert.equal(queueStackEvidenceMatches(identity, notice(), { ...final(), ...patch }, sample()), false);
  }
  for (const patch of [{ startedDeviceMs: 100599 }, { resumedDeviceMs: 103000 }, { resumeVerified: false },
    { forwardRemoved: false }, { frames: 0 }, { frames: 33 }, { identity: { ...identity, startTicks: "54321" } }]) {
    assert.equal(queueStackEvidenceMatches(identity, notice(), final(), { ...sample(), ...patch }), false);
  }
});
test("unknown final timing cannot certify coverage and expected identity is copied", () => {
  assert.equal(queueStackEvidenceMatches(identity, notice(), { ...final(), settledMs: -1 }, sample()), false);
  assert.equal(queueStackEvidenceMatches(identity, { ...notice(), enteredMs: 100500 }, final(), sample()), false);
  assert.equal(queueStackEvidenceMatches(identity, { ...notice(), observedMs: 100499 }, final(), sample()), false);
  const expected = { ...identity }, gate = createQueueStackGate(expected); expected.pid = 88;
  assert.equal(gate.reserve(notice(), 210, true), "sample-reserved");
});
