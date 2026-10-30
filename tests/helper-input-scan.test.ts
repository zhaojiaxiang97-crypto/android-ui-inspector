import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { HelperInputError, readHelperInput } from "../electron/capture/helper-input";
import { helperInputReply, type HelperInputRequest, type HelperInputReply } from "../shared/helper-input";
import { helperFrame, helperPackage, helperServiceId, helperToken } from "./fixtures/helper-protocol";

const request = (): HelperInputRequest => ({ version: 1, sessionId: randomUUID(), requestId: randomUUID(), serviceInstanceId: helperServiceId,
  captureId: randomUUID(), packageName: helperPackage, windowId: "7", display: helperFrame, action: { kind: "tap", x: 1, y: 2 },
  target: { resourceId: `${helperPackage}:id/target`, className: "android.widget.Button", bounds: { left: 0, top: 0, right: 10, bottom: 10 } } });
const reply = (input: HelperInputRequest): HelperInputReply => {
  const { action: _, target: _target, ...identity } = input;
  return { ...identity, status: "timeout", dispatchState: "not_sent", errorCode: "timeout", startedAtMs: 150, finishedAtMs: 160,
    method: "accessibility-click", mainStartedAtMs: 151, preflightStage: "target_scan", preflightStageStartedAtMs: 151 };
};
type ScanDiagnostics = NonNullable<HelperInputReply["scanDiagnostics"]>;
const scan = (patch: Partial<ScanDiagnostics> = {}): ScanDiagnostics => ({ version: 1, operation: "node",
  scanStartedAtMs: 152, operationStartedAtMs: 153, nodesVisited: 10, childReadsStarted: 3, childReadsCompleted: 3,
  childReadTotalMs: 4, childReadMaxMs: 2, ...patch });
const read = (input: HelperInputRequest, value: unknown, status = 200) => readHelperInput(12345, helperToken, input,
  new AbortController().signal, (async () => new Response(JSON.stringify(value), { status })) as typeof fetch);

test("valid node-operation scan snapshots pass end to end and stay optional for legacy receipts", async () => {
  const input = request(), expected = { ...reply(input), scanDiagnostics: scan() };
  assert.equal(helperInputReply.safeParse(expected).success, true);
  assert.deepEqual(await read(input, expected), expected);
  const { mainStartedAtMs: _main, preflightStage: _stage, preflightStageStartedAtMs: _stageTime, ...legacy } = reply(input);
  assert.equal(helperInputReply.safeParse(legacy).success, true, "legacy timeout receipts without diagnostics remain valid");
  assert.deepEqual(await read(input, legacy), legacy);
  const completed = { ...legacy, status: "completed", dispatchState: "sent", errorCode: undefined };
  assert.equal(helperInputReply.safeParse(completed).success, true, "legacy completed receipts remain valid");
  assert.equal(helperInputReply.safeParse({ ...reply(input), scanDiagnostics: undefined }).success, true, "field stays optional");
});

test("valid blocked-child scan snapshots pass with delta one and completed node snapshots may carry reads", () => {
  const blocked = { ...reply(request()), scanDiagnostics: scan({ operation: "child", childReadsStarted: 3, childReadsCompleted: 2 }) };
  assert.equal(helperInputReply.safeParse(blocked).success, true);
  const completed = { ...reply(request()), scanDiagnostics: scan({ nodesVisited: 5000, childReadsStarted: 5000,
    childReadsCompleted: 5000, childReadTotalMs: 7, childReadMaxMs: 7 }) };
  assert.equal(helperInputReply.safeParse(completed).success, true);
});

test("scanDiagnostics requires every key, rejects unknown keys and non-literal versions", () => {
  const base = { ...reply(request()), scanDiagnostics: scan() };
  for (const key of ["version", "operation", "scanStartedAtMs", "operationStartedAtMs", "nodesVisited",
    "childReadsStarted", "childReadsCompleted", "childReadTotalMs", "childReadMaxMs"] as const) {
    const { [key]: _, ...partial } = scan();
    assert.equal(helperInputReply.safeParse({ ...base, scanDiagnostics: partial }).success, false, key);
  }
  for (const diagnostics of [{ ...scan(), extra: "field" }, { ...scan(), version: 2 }, { ...scan(), operation: "other" }])
    assert.equal(helperInputReply.safeParse({ ...base, scanDiagnostics: diagnostics }).success, false);
  assert.equal(helperInputReply.safeParse({ ...base, unexpected: "field" }).success, false, "strict root stays strict");
});

test("scan diagnostics require a main-thread target-scan timeout with confirmed not-sent state", () => {
  const base = { ...reply(request()), scanDiagnostics: scan() };
  for (const patch of [
    { status: "completed", dispatchState: "sent", errorCode: undefined, preflightStage: undefined, preflightStageStartedAtMs: undefined },
    { status: "rejected", errorCode: "incomplete", preflightStage: undefined, preflightStageStartedAtMs: undefined },
    { status: "cancelled", dispatchState: "unknown", errorCode: "cancelled", preflightStage: undefined, preflightStageStartedAtMs: undefined },
    { dispatchState: "unknown", preflightStage: undefined, preflightStageStartedAtMs: undefined },
    { mainStartedAtMs: undefined, preflightStage: undefined, preflightStageStartedAtMs: undefined },
    { preflightStage: undefined, preflightStageStartedAtMs: undefined },
    { preflightStage: "window_inventory" }, { preflightStage: "target_refresh" },
  ]) assert.equal(helperInputReply.safeParse({ ...base, ...patch }).success, false, JSON.stringify(patch));
});

test("out-of-range counters and non-safe timestamps reject", () => {
  const base = { ...reply(request()) };
  for (const patch of [{ nodesVisited: -1 }, { nodesVisited: 5001 }, { nodesVisited: 1.5 },
    { childReadsStarted: -1 }, { childReadsStarted: 5001 }, { childReadsCompleted: -1 }, { childReadsCompleted: 5001 },
    { childReadTotalMs: -1 }, { childReadTotalMs: 7001 }, { childReadMaxMs: -1 }, { childReadMaxMs: 7001 },
    { scanStartedAtMs: -1 }, { scanStartedAtMs: 2 ** 53 }, { scanStartedAtMs: 152.5 },
    { operationStartedAtMs: -1 }, { operationStartedAtMs: 2 ** 53 }, { operationStartedAtMs: 153.5 }])
    assert.equal(helperInputReply.safeParse({ ...base, scanDiagnostics: scan(patch as Partial<ScanDiagnostics>) }).success, false);
});

test("operation must match the started-completed delta exactly", () => {
  const base = { ...reply(request()) };
  for (const patch of [{ operation: "child" }, { childReadsStarted: 4, childReadsCompleted: 2 },
    { childReadsStarted: 3, childReadsCompleted: 1 }, { childReadsStarted: 2, childReadsCompleted: 3 },
    { operation: "node", childReadsStarted: 3, childReadsCompleted: 2 }] satisfies Partial<ScanDiagnostics>[])
    assert.equal(helperInputReply.safeParse({ ...base, scanDiagnostics: scan(patch) }).success, false, JSON.stringify(patch));
  assert.equal(helperInputReply.safeParse({ ...base, scanDiagnostics: scan({ childReadsStarted: 0, childReadsCompleted: 0,
    childReadTotalMs: 0, childReadMaxMs: 0 }) }).success, true, "zero counters with node operation are valid");
});

test("scan timestamps must respect the receipt ordering main, stage, scan, operation, finished", () => {
  const base = { ...reply(request()) };
  for (const patch of [{ operationStartedAtMs: 151 }, { scanStartedAtMs: 161 }, { scanStartedAtMs: 149 },
    { scanStartedAtMs: 154, operationStartedAtMs: 152 }])
    assert.equal(helperInputReply.safeParse({ ...base, mainStartedAtMs: 151, scanDiagnostics: scan(patch) }).success, false,
      JSON.stringify(patch));
  assert.equal(helperInputReply.safeParse({ ...base, mainStartedAtMs: 151, scanDiagnostics: scan() }).success, true);
  const timeout = { ...reply(request()), status: "timeout" as const, dispatchState: "not_sent" as const, errorCode: "timeout",
    mainStartedAtMs: 151, preflightStage: "target_scan" as const, preflightStageStartedAtMs: 155 };
  assert.equal(helperInputReply.safeParse({ ...timeout, scanDiagnostics: scan({ scanStartedAtMs: 156, operationStartedAtMs: 157 }) }).success, true);
  assert.equal(helperInputReply.safeParse({ ...timeout, scanDiagnostics: scan({ scanStartedAtMs: 154, operationStartedAtMs: 157 }) }).success, false,
    "scan cannot start before the preflight stage started");
});

test("durations must obey max<=total, completed>0 for nonzero totals and the receipt time budget", () => {
  const base = { ...reply(request()) };
  for (const patch of [{ childReadMaxMs: 5 }, { childReadTotalMs: 9, childReadMaxMs: 9 },
    { childReadsStarted: 0, childReadsCompleted: 0, childReadTotalMs: 4, childReadMaxMs: 0 },
    { childReadsStarted: 0, childReadsCompleted: 0, childReadTotalMs: 0, childReadMaxMs: 1 }])
    assert.equal(helperInputReply.safeParse({ ...base, scanDiagnostics: scan(patch) }).success, false, JSON.stringify(patch));
  assert.equal(helperInputReply.safeParse({ ...base, scanDiagnostics: scan({ childReadTotalMs: 8, childReadMaxMs: 8 }) }).success, true,
    "total equal to finishedAtMs minus scanStartedAtMs is still in budget");
});

test("valid scanDiagnostics never weaken the method or identity checks of the dispatch path", async () => {
  const input = request();
  for (const method of [undefined, "gesture", "accessibility-scroll", "global-back"])
    await assert.rejects(read(input, { ...reply(input), method, scanDiagnostics: scan() }), (error: unknown) =>
      error instanceof HelperInputError && error.dispatchState === "unknown" && error.requestId === input.requestId);
  await assert.rejects(read(input, { ...reply(input), sessionId: randomUUID(), scanDiagnostics: scan() }), (error: unknown) =>
    error instanceof HelperInputError && error.dispatchState === "unknown" && error.requestId === input.requestId);
});
