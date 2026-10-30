import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { captureSignal } from "../electron/device/runtime";
import { remainingSignalBudget, trackSignalDeadline } from "../electron/device/signal-deadline";

test("nested reads consume the original deadline instead of renewing it", async () => {
  const parent = trackSignalDeadline(new AbortController().signal, performance.now() + 1000);
  const first = captureSignal(parent, 30_000);
  const before = remainingSignalBudget(first)!;
  await delay(25);
  const second = captureSignal(first, 30_000);
  assert.ok(before <= 1000 && before > 0);
  assert.ok(remainingSignalBudget(second)! < before - 15);
  trackSignalDeadline(second, performance.now() + 60_000);
  assert.ok(remainingSignalBudget(second)! <= remainingSignalBudget(parent)! + 1);
  const expired = trackSignalDeadline(new AbortController().signal, performance.now() - 1);
  assert.equal(remainingSignalBudget(expired), 0);
  assert.equal(remainingSignalBudget(new AbortController().signal), undefined);
});

test("tracking preserves native parent cancellation and capture timeouts", async () => {
  const parent = new AbortController();
  const signal = captureSignal(parent.signal, 1000);
  const reason = new Error("user cancellation"); parent.abort(reason);
  assert.equal(signal.reason, reason);
  const timeout = captureSignal(undefined, 10);
  await delay(25);
  assert.equal(timeout.aborted, true);
  assert.equal(timeout.reason.name, "TimeoutError");
});
