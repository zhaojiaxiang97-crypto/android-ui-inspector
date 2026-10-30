import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyDebugInput, DebugInputError, runDebugInputCommand } from "../electron/device/debug-input";
import type { CommandRecord } from "../electron/platform/command-runner";
import type { DebugInputEvidence } from "../shared/types";
import { debugInputEvidenceSchema } from "../shared/debug-scroll-validation";

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

const injectionNonce = "a".repeat(32);
const injectionMarker = `__AUI_INPUT_${injectionNonce}__:22121:1582:1792156358100\n`;
const systemDiagnostic = { status: "rejected" as const, remotePid: 22121, systemServerPid: 1582,
  deviceStartedAt: 1792156358100, deviceFinishedAt: 1792156358200 };
const printReply = (reply: string) => ["-e", `process.stdout.write(${JSON.stringify(reply)})`];

test("a quiet exit0 with correlated system rejection stops before page verification and preserves an uncertain receipt", async () => {
  let checks = 0, callbacks = 0;
  await assert.rejects(runDebugInputCommand(process.execPath, printReply(injectionMarker), undefined, evidence => {
    callbacks++; assert.equal(evidence.classification, "injection-failed"); assert.equal(evidence.stdout, "");
    assert.equal(evidence.exitCode, 0); assert.equal(evidence.spawned, true);
    assert.deepEqual(evidence.systemInjection, systemDiagnostic); assert(debugInputEvidenceSchema.safeParse(evidence).success);
  }, { nonce: injectionNonce, check: async marker => {
    checks++; assert.equal(marker.remotePid, 22121); assert.equal(marker.systemServerPid, 1582); return systemDiagnostic;
  } }), (error: unknown) => error instanceof DebugInputError && /注入失败/.test(error.message) && /不要自动重试/.test(error.message));
  assert.equal(checks, 1); assert.equal(callbacks, 1);
});

test("no matching system failure and unavailable diagnostics remain command acknowledgements only", async () => {
  for (const status of ["not_observed", "unavailable"] as const) {
    let receipt: DebugInputEvidence | undefined;
    await runDebugInputCommand(process.execPath, printReply(injectionMarker), undefined, evidence => { receipt = evidence; },
      { nonce: injectionNonce, check: async () => ({ ...systemDiagnostic, status }) });
    assert.equal(receipt?.classification, "accepted"); assert.equal(receipt?.systemInjection?.status, status);
    assert(debugInputEvidenceSchema.safeParse(receipt).success);
  }
  let receipt: DebugInputEvidence | undefined;
  await runDebugInputCommand(process.execPath, printReply(injectionMarker), undefined, evidence => { receipt = evidence; },
    { nonce: injectionNonce, check: async () => { throw Error("diagnostic transport unavailable"); } });
  assert.equal(receipt?.classification, "accepted"); assert.equal(receipt?.systemInjection?.status, "unavailable");
});

test("missing or malformed input markers cannot become accepted and extra output keeps its error classification", async () => {
  for (const reply of ["", injectionMarker.replace("22121", "021121"), injectionMarker + injectionMarker, injectionMarker + "warning"]) {
    let checks = 0;
    await assert.rejects(runDebugInputCommand(process.execPath, printReply(reply), undefined, undefined,
      { nonce: injectionNonce, check: async () => { checks++; return systemDiagnostic; } }), DebugInputError);
    assert.equal(checks, 0);
  }
  await assert.rejects(runDebugInputCommand(process.execPath, printReply(injectionMarker + "SecurityException: INJECT_EVENTS denied"),
    undefined, undefined, { nonce: injectionNonce, check: async () => systemDiagnostic }),
    (error: unknown) => error instanceof DebugInputError && error.evidence.classification === "permission-denied");
});

test("cancelling the read-only system check cannot publish an accepted input receipt", async () => {
  const controller = new AbortController();
  await assert.rejects(runDebugInputCommand(process.execPath, printReply(injectionMarker), controller.signal, undefined,
    { nonce: injectionNonce, check: async () => { controller.abort(); throw controller.signal.reason; } }),
    (error: unknown) => error instanceof DebugInputError && error.evidence.classification === "cancelled"
      && error.evidence.spawned && error.evidence.systemInjection?.status === "unavailable");
});

test("system evidence refuses invalid process identities and inverted or excessive device-time windows", () => {
  const base = classifyDebugInput(record());
  for (const change of [{ remotePid: 0 }, { systemServerPid: -1 }, { deviceFinishedAt: 1792156358099 },
    { deviceFinishedAt: 1792156378100 }, { status: "success" }, { extra: true }])
    assert.equal(debugInputEvidenceSchema.safeParse({ ...base, systemInjection: { ...systemDiagnostic, ...change } }).success, false);
  assert(debugInputEvidenceSchema.safeParse(base).success, "legacy receipts remain readable");
  assert.equal(debugInputEvidenceSchema.safeParse({ ...base, systemInjection: systemDiagnostic }).success, false);
  assert.equal(debugInputEvidenceSchema.safeParse({ ...base, classification: "injection-failed" }).success, false);
});
