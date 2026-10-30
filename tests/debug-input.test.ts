import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyDebugInput, DebugInputError, runDebugInputCommand } from "../electron/device/debug-input";
import type { CommandRecord } from "../electron/platform/command-runner";
import type { DebugInputEvidence } from "../shared/types";

function record(extra: Partial<CommandRecord> = {}): CommandRecord {
  return { id: 1, command: ["not-run"], startedAt: new Date().toISOString(), dispatchMono: 1,
    durationMs: 1, status: "completed", spawned: true, closed: true, exitCode: 0, signal: null,
    stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, ...extra };
}

test("exit0 cannot hide input errors, unexpected replies, truncation or unknown termination", () => {
  assert.equal(classifyDebugInput(record()).classification, "accepted");
  for (const stream of ["stdout", "stderr"] as const) {
    for (const [text, classification] of [
      ["java.lang.SecurityException: Injecting input requires INJECT_EVENTS", "permission-denied"],
      ["Permission denied", "permission-denied"], ["error: device offline", "device-unavailable"],
      ["error: closed", "device-unavailable"], ["Unknown command: tap", "invalid-command"],
      ["Usage: input [source]", "invalid-command"], ["warning: injection ignored", "unexpected-output"],
    ]) assert.equal(classifyDebugInput(record({ [stream]: text })).classification, classification);
  }
  for (const key of ["stdoutTruncated", "stderrTruncated"] as const)
    assert.equal(classifyDebugInput(record({ [key]: true })).classification, "unexpected-output");
  assert.equal(classifyDebugInput(record({ exitCode: 7 })).classification, "command-failed");
  assert.equal(classifyDebugInput(record({ closed: false })).classification, "unconfirmed-exit");
  assert.equal(classifyDebugInput(record({ spawned: false, errorCode: "ENOENT" })).classification, "spawn-failed");
  for (const stopReason of ["timeout", "cancelled", "output-limit"] as const)
    assert.equal(classifyDebugInput(record({ stopReason })).classification, stopReason);
});

test("actual owned child replies are bounded and exit0 permission errors are rejected", async () => {
  for (const stream of ["stdout", "stderr"]) {
    let evidence: DebugInputEvidence | undefined;
    await assert.rejects(runDebugInputCommand(process.execPath,
      ["-e", `process.${stream}.write('java.lang.SecurityException: INJECT_EVENTS denied')`], undefined,
      value => { evidence = value; }), (error: unknown) => error instanceof DebugInputError
        && error.evidence.classification === "permission-denied" && /不要自动重试/.test(error.message));
    assert(evidence); assert.equal(evidence.exitCode, 0); assert.equal(evidence.closed, true);
    assert.equal(evidence.spawned, true);
  }
  let bounded: DebugInputEvidence | undefined;
  await assert.rejects(runDebugInputCommand(process.execPath,
    ["-e", "process.stdout.write('x'.repeat(6000));process.stderr.write('original error')"], undefined,
    value => { bounded = value; }), DebugInputError);
  assert(bounded); assert.equal(Buffer.byteLength(bounded.stdout), 4096);
  assert.equal(bounded.stdoutTruncated, true); assert.equal(bounded.stderr, "original error");
  assert.equal(bounded.exitCode, 0); assert.equal(bounded.closed, true);
});

test("quiet accepted input retains its actual receipt; nonzero exit preserves both streams", async () => {
  let accepted: DebugInputEvidence | undefined;
  await runDebugInputCommand(process.execPath, ["-e", "process.exitCode=0"], undefined, value => { accepted = value; });
  assert(accepted); assert.equal(accepted.classification, "accepted"); assert.equal(accepted.exitCode, 0);
  assert.equal(accepted.closed, true); assert.equal(accepted.stdout, ""); assert.equal(accepted.stderr, "");
  await assert.rejects(runDebugInputCommand(process.execPath,
    ["-e", "process.stdout.write('partial');process.stderr.write('failed');process.exitCode=7"], undefined),
    (error: unknown) => error instanceof DebugInputError && error.evidence.exitCode === 7
      && error.evidence.stdout === "partial" && error.evidence.stderr === "failed" && error.evidence.closed);
});

test("cancel before dispatch or missing executable cannot be reported as sent", async () => {
  const controller = new AbortController(); controller.abort(Error("cancelled"));
  for (const [executable, signal, classification] of [
    [process.execPath, controller.signal, "cancelled"], ["/no-such-inspector-input-fixture", undefined, "spawn-failed"],
  ] as const) await assert.rejects(runDebugInputCommand(executable, [], signal), (error: unknown) =>
    error instanceof DebugInputError && !error.evidence.spawned && error.evidence.classification === classification);
});

test("cancelled actual child is joined and partial output is retained without retry", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error("cancel input")), 300);
  try {
    await assert.rejects(runDebugInputCommand(process.execPath,
      ["-e", "process.stdout.write('partial');setInterval(()=>{},100)"], controller.signal), (error: unknown) =>
      error instanceof DebugInputError && error.evidence.classification === "cancelled" && error.evidence.closed
        && error.evidence.exitCode === null && error.evidence.signal === "SIGKILL" && error.evidence.stdout === "partial");
  } finally { clearTimeout(timer); }
});
