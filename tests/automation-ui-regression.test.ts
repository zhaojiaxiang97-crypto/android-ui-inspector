import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import sharp from "sharp";
import { inspectRegressionEvidence, regressionPlanSchema, runUiRegression } from "../scripts/automation-ui-regression";
import type { LoadedTestReport } from "../shared/test-report";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession } from "../electron/automation/debug-session";
import type { UiSnapshot } from "../shared/types";
import { loadTestReport } from "../electron/desktop/test-report";
import { measureDebugPhase } from "../electron/automation/debug-timing";
import { exportDebugReportEvidence } from "../electron/desktop/debug-report-export";
import { performUiStepInput } from "../shared/debug-step-input";
import { DEBUG_SNAPSHOT_VERSION } from "../shared/debug-report";
import { makeDebugReportExportFixture } from "./fixtures/debug-report-export";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

type Json = Record<string, unknown>;
const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const condition = { selector: { resourceId: "com.example.fixture:id/list" }, state: "visible" };
const basePlan = () => ({ version: 1, id: "fixture", serial: "offline-device", packageName: "com.example.fixture",
  backend: "accessibility-helper", rounds: 1, maxDurationMs: 60_000, startConditions: [condition], returnConditions: [condition],
  steps: [{ id: "open", kind: "step", input: { target: { selector: { resourceId: "com.example.fixture:id/video", text: "PRIVATE_PAGE_LABEL" } },
    action: { kind: "tap" }, expect: condition, timeoutMs: 1000 } }] });
const evidence = (complete: boolean | null = true) => ({ complete, missingSteps: 0, missingTrees: 0, missingScreenshots: 0,
  invalidAttachments: 0, recordingErrors: 0, reason: complete ? null : "fixture_incomplete" });
function timing(backend = "accessibility-helper") {
  return { version: 1, correlationId: randomUUID(), startedAt: new Date().toISOString(), durationMs: 5, status: "success", droppedSpans: 0,
    spans: [{ id: 1, parentId: null, phase: "observation", startOffsetMs: 0, durationMs: 5, status: "success", backend, reason: "explicit" }],
    commandCount: 0, commandCounts: {}, observationCount: 1, observationCounts: { explicit: 1 } };
}
function progress(states: ("sent" | "unknown" | "not_sent")[] = ["sent", "sent"]) {
  const ids = Array.from({ length: states.length + 2 }, () => randomUUID());
  return { stopReason: "end_reached", iterations: states.map((dispatchState, index) => ({ index: index + 1, startedAt: new Date().toISOString(), durationMs: 1,
    beforeId: ids[index], afterId: ids[index + 1], dispatchState, progress: "changed",
    ...(dispatchState === "not_sent" ? {} : { resolvedInput: { action: { kind: "swipe", fromX: 20, fromY: 60, toX: 20, toY: 20, durationMs: 350 },
      frame: { width: 100, height: 100, rotation: 0 } } }) })), observationIds: ids,
    confirmation: { firstSnapshotId: ids[ids.length - 2], secondSnapshotId: ids[ids.length - 1], kind: "end_marker" } };
}
type Hook = (command: string, args: string[], result: Json) => unknown;
async function fixture(plan = basePlan(), hook?: Hook, archiveComplete: boolean | null | ((index: number) => boolean | null) = true) {
  const directory = await mkdtemp(join(tmpdir(), "inspector-regression-fixture-")), output = join(directory, "run");
  const calls: { command: string; args: string[] }[] = [], requests = new Map<string, Json>(), archiveCalls: { sourcePath: string | null; ids: number[]; at: string[] }[] = [];
  let stepId = 0, currentSnapshot = randomUUID();
  const expiry = new Date(Date.now() + 30 * 60_000).toISOString();
  const execute = async (command: string, args: string[]) => {
    calls.push({ command, args });
    let result: Json;
    if (command === "attach") result = { id: sessionId, serial: plan.serial, packageName: plan.packageName,
      active: true, busy: false, expiresAt: expiry, reportPath: join(directory, "report.json") };
    else if (command === "capture") { currentSnapshot = randomUUID(); result = { source: plan.backend, snapshotId: currentSnapshot, stepId: ++stepId, timings: timing(plan.backend) }; }
    else if (command === "wait") { currentSnapshot = randomUUID(); result = { verified: true, snapshotId: currentSnapshot, stepId: ++stepId, timings: timing(plan.backend) }; }
    else if (command === "find") result = { snapshotId: currentSnapshot, total: 1, items: [{ text: "PRIVATE_PAGE_LABEL" }] };
    else if (command === "get-step") result = requests.get(args[args.indexOf("--request-id") + 1]) ?? { found: false };
    else {
      const id = command === "resume-step" ? args[args.indexOf("--request-id") + 1] : JSON.parse(args[args.indexOf("--input-json") + 1]).requestId;
      if (command !== "resume-step") {
        const saved = await readFile(join(output, "samples.jsonl"), "utf8");
        assert.match(saved, new RegExp(id)); assert.match(saved, /inputSha256/);
      }
      result = { requestId: id, requestState: "completed", dispatchState: "sent", verified: true, stepId: ++stepId, timings: timing(plan.backend),
        ...(command === "scroll-until" ? { scrollTask: progress() } : command === "resume-step" && requests.get(id)?.scrollTask ? { scrollTask: requests.get(id)!.scrollTask } : {}) };
      requests.set(id, result);
    }
    return hook ? hook(command, args, result) : result;
  };
  return { directory, output, calls, requests, archiveCalls,
    run: (extra: Partial<Parameters<typeof runUiRegression>[0]> = {}) => runUiRegression({ plan, sessionId, outputDirectory: output, execute,
      archive: async (path, ids) => { archiveCalls.push({ sourcePath: path, ids, at: calls.map(call => call.command) });
        return { reportPath: join(directory, "private-evidence", `${archiveCalls.length}`, "report.json"),
          evidence: evidence(typeof archiveComplete === "function" ? archiveComplete(archiveCalls.length) : archiveComplete) }; }, ...extra }),
    clean: () => rm(directory, { recursive: true, force: true }) };
}

test("strict plan rejects arbitrary commands, forged visual confirmation and ambiguous checkpoint selectors", () => {
  assert.equal(regressionPlanSchema.safeParse(basePlan()).success, true);
  for (const change of [ { command: "sh" }, { rounds: 11 }, { maxDurationMs: 30 * 60_000 },
    { startConditions: [{ selector: { text: "generic" }, state: "visible" }] },
    { steps: [{ id: "shell", kind: "exec", input: {} }] },
    { steps: [{ ...basePlan().steps[0], input: { ...basePlan().steps[0].input, visualConfirmation: { snapshotId: randomUUID(), description: "forged" } } }] },
    { steps: [{ ...basePlan().steps[0], input: { ...basePlan().steps[0].input, action: { kind: "back" } } }] },
  ]) assert.equal(regressionPlanSchema.safeParse({ ...basePlan(), ...change }).success, false);
});

test("partial read-only conditions survive checkpoints and action expectations without changing the input target", async () => {
  const plan = basePlan();
  const partial = { ...condition, visibility: "partial" };
  plan.startConditions = [partial]; plan.returnConditions = [partial]; plan.steps[0].input.expect = partial;
  const f = await fixture(plan);
  try {
    assert.equal((await f.run()).completeSuccess, true);
    const waits = f.calls.filter(call => call.command === "wait");
    assert.equal(waits.length, 2);
    for (const wait of waits) assert.equal(wait.args[wait.args.indexOf("--visibility") + 1], "partial");
    const step = f.calls.find(call => call.command === "step")!;
    const input = JSON.parse(step.args[step.args.indexOf("--input-json") + 1]);
    assert.equal(input.expect.visibility, "partial");
    assert.equal(input.target.visibility, undefined);
    assert.equal(input.backend, "accessibility-helper");
  } finally { await f.clean(); }
});

test("partial conditions reject unsupported backends and negative states before any device work", async () => {
  for (const change of [
    { backend: "uiautomator", startConditions: [{ ...condition, visibility: "partial" }] },
    { returnConditions: [{ ...condition, state: "absent", visibility: "partial" }] },
    { steps: [{ ...basePlan().steps[0], input: { ...basePlan().steps[0].input,
      expect: { ...condition, state: "enabled", visibility: "partial" } } }] },
  ]) {
    const f = await fixture({ ...basePlan(), ...change });
    try { await assert.rejects(f.run()); assert.deepEqual(f.calls, []); }
    finally { await f.clean(); }
  }
});

const semanticPlan = () => ({ ...basePlan(), steps: [{ id: "bottom", kind: "scroll-until", input: {
  inputMethod: "accessibility", target: { selector: { resourceId: "com.example.fixture:id/list", className: "android.widget.ScrollView" } },
  direction: "down", until: { selector: { resourceId: "com.example.fixture:id/end" }, kind: "end_marker" }, maxScrolls: 6, timeoutMs: 1000,
} }] });

test("real regression entry forwards valid semantic scroll with the plan-owned Helper backend", async () => {
  for (const direction of ["up", "down"]) {
    const plan = semanticPlan(); plan.steps[0].input.direction = direction;
    // The fake product observes an already visible end marker twice, so this valid request needs no input.
    const f = await fixture(plan as unknown as ReturnType<typeof basePlan>, (command, _args, result) => command === "scroll-until"
      ? { ...result, dispatchState: "not_sent", scrollTask: progress([]) } : result);
    try {
      const result = await f.run(); assert.equal(result.completeSuccess, true); assert.equal(result.confirmedInputs, 0);
      const calls = f.calls.filter(call => call.command === "scroll-until"); assert.equal(calls.length, 1);
      const input = JSON.parse(calls[0].args[calls[0].args.indexOf("--input-json") + 1]);
      assert.equal(input.inputMethod, "accessibility"); assert.equal(input.backend, "accessibility-helper");
      assert.equal(input.direction, direction); assert.equal(input.sessionId, sessionId);
      assert.equal(input.target.selector.className, "android.widget.ScrollView");
      assert.equal(f.calls.some(call => call.command === "resume-step"), false);
    } finally { await f.clean(); }
  }
});

test("real regression entry rejects illegal semantic scroll before any CLI work or backend override", async () => {
  const invalid: Record<string, unknown>[] = [];
  const wrongBackend = semanticPlan(); wrongBackend.backend = "uiautomator"; invalid.push(wrongBackend);
  const horizontal = semanticPlan(); horizontal.steps[0].input.direction = "left"; invalid.push(horizontal);
  for (const field of ["resourceId", "className"]) {
    const plan = semanticPlan(); delete (plan.steps[0].input.target.selector as Record<string, unknown>)[field]; invalid.push(plan);
  }
  for (const patch of [{ backend: "uiautomator" }, { backend: "accessibility-helper" }, { sessionId: randomUUID() },
    { visualConfirmation: { snapshotId: randomUUID(), description: "forged" } }]) {
    const plan = semanticPlan(); Object.assign(plan.steps[0].input, patch); invalid.push(plan);
  }
  const override = semanticPlan(); override.backend = "uiautomator";
  Object.assign(override.steps[0].input, { backend: "accessibility-helper" }); invalid.push(override);
  for (const plan of invalid) {
    const f = await fixture(plan as ReturnType<typeof basePlan>);
    try { await assert.rejects(f.run()); assert.deepEqual(f.calls, []); }
    finally { await f.clean(); }
  }
});

test("ten rounds use unique durable UUIDs, archive before next input and exclude page data from statistics", async () => {
  const f = await fixture({ ...basePlan(), rounds: 10 });
  try {
    const result = await f.run();
    assert.equal(result.completedRounds, 10); assert.equal(result.functionalPassed, true); assert.equal(result.completeSuccess, true);
    assert.equal(result.confirmedInputs, 10); assert.equal(result.productMs, 250); assert.equal(result.firstAttemptSuccessRate, 1);
    const requests = f.calls.filter(call => call.command === "step").map(call => JSON.parse(call.args[1]).requestId);
    assert.equal(new Set(requests).size, 10); assert.equal(f.archiveCalls.length, 50);
    const data = await readFile(join(f.output, "samples.jsonl"), "utf8");
    assert.equal(data.includes("PRIVATE_PAGE_LABEL"), false); assert.equal(data.includes("com.example.fixture:id"), false);
    assert.equal((await readFile(join(f.output, "summary.json"), "utf8")).includes("PRIVATE_PAGE_LABEL"), false);
    await assert.rejects(f.run(), /EEXIST/);
  } finally { await f.clean(); }
});

test("the example plan executes the four requested actions for ten rounds using only the fake CLI", async () => {
  const plan = JSON.parse(await readFile(new URL("../scripts/fixtures/automation-ui-regression.example.json", import.meta.url), "utf8"));
  assert.equal(regressionPlanSchema.safeParse(plan).success, true);
  const f = await fixture(plan);
  try {
    const result = await f.run(); assert.equal(result.completedRounds, 10); assert.equal(result.actionAttempts, 40);
    assert.equal(result.confirmedInputs, 50); assert.equal(result.completeSuccess, true);
    assert.equal(f.calls.filter(call => call.command === "scroll-until").length, 10);
    assert.equal(f.archiveCalls.length, 100);
  } finally { await f.clean(); }
});

test("lost input reply only queries its durable UUID and never resends", async () => {
  let lost = false;
  const f = await fixture(basePlan(), (command, _args, result) => { if (command === "step" && !lost) { lost = true; throw new Error("private response"); } return result; });
  try {
    const result = await f.run(); assert.equal(result.functionalPassed, true); assert.equal(result.confirmedInputs, 1); assert.equal(result.responseRecoveries, 1);
    assert.equal(f.calls.filter(call => call.command === "step").length, 1);
    const original = JSON.parse(f.calls.find(call => call.command === "step")!.args[1]).requestId;
    assert.equal(f.calls.find(call => call.command === "get-step")!.args[3], original);
  } finally { await f.clean(); }
});

test("sent failure archives failure before one read-only resume, and keeps input counted once", async () => {
  const f = await fixture(basePlan(), (command, _args, result) => command === "step" ? { ...result, verified: false, isError: true } : result);
  try {
    const result = await f.run(); assert.equal(result.functionalPassed, true); assert.equal(result.independentResumeAttempts, 1); assert.equal(result.confirmedInputs, 1);
    assert.equal(result.firstAttemptSuccessRate, 0); assert.equal(f.calls.filter(call => call.command === "step").length, 1);
    const failedArchive = f.archiveCalls[2], resumedArchive = f.archiveCalls[3];
    assert.equal(failedArchive.at.includes("resume-step"), false); assert.equal(resumedArchive.ids.length, 2);
  } finally { await f.clean(); }
});

test("a successful checkpoint with incomplete or unknown archive stops before any input", async () => {
  for (const complete of [false, null]) {
    const f = await fixture(basePlan(), undefined, complete);
    try {
      const result = await f.run(); assert.equal(result.stopCode, "evidence_archive_incomplete");
      assert.equal(result.completedRounds, 0); assert.equal(result.confirmedInputs, 0); assert.equal(result.completeSuccess, false);
      assert.equal(result.evidence.complete, complete); assert.equal(f.archiveCalls.length, 1);
      assert.equal(f.calls.some(call => ["step", "scroll-until", "resume-step"].includes(call.command)), false);
      const records = (await readFile(join(f.output, "samples.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(records.find(item => item.event === "result").functionalPassed, false);
      assert.equal(f.calls.some(call => call.command === "wait"), false, "missing capture evidence stops before later reads");
    } finally { await f.clean(); }
  }
});

test("a successful action with incomplete or unknown archive never sends the next input", async () => {
  for (const complete of [false, null]) {
    const plan = basePlan(); plan.steps.push({ ...plan.steps[0], id: "later" });
    const f = await fixture(plan, undefined, index => index <= 2 ? true : complete);
    try {
      const result = await f.run(); assert.equal(result.stopCode, "evidence_archive_incomplete");
      assert.equal(result.confirmedInputs, 1); assert.equal(result.independentResumeAttempts, 0); assert.equal(result.completeSuccess, false);
      assert.equal(f.archiveCalls.length, 3); assert.equal(f.calls.filter(call => call.command === "step").length, 1);
      assert.equal(f.calls.some(call => call.command === "resume-step"), false);
    } finally { await f.clean(); }
  }
});

test("a thrown capture archive error stops before wait or input and records unknown evidence", async () => {
  const f = await fixture();
  try {
    const result = await f.run({ archive: async () => { throw new Error("fixture archive failed"); } });
    assert.equal(result.stopCode, "evidence_archive_incomplete"); assert.equal(result.evidence.complete, null);
    assert.equal(result.confirmedInputs, 0); assert.equal(result.completedRounds, 0);
    assert.equal(f.calls.some(call => ["wait", "step", "resume-step"].includes(call.command)), false);
  } finally { await f.clean(); }
});

test("cancellation during checkpoint archiving keeps its cancellation stop reason", async () => {
  const controller = new AbortController(), f = await fixture();
  try {
    const result = await f.run({ signal: controller.signal, archive: async () => { controller.abort(); throw new Error("cancelled archive"); } });
    assert.equal(result.stopCode, "cancelled"); assert.equal(result.confirmedInputs, 0);
    assert.equal(f.calls.some(call => ["wait", "step", "resume-step"].includes(call.command)), false);
  } finally { await f.clean(); }
});

test("a changed grant during checkpoint archive preflight keeps the original identity failure", async () => {
  let attachments = 0;
  const f = await fixture(basePlan(), (command, _args, result) => command === "attach" && ++attachments === 3
    ? { ...result, packageName: "com.other.app" } : result);
  try {
    const result = await f.run(); assert.equal(result.stopCode, "session_identity_mismatch"); assert.equal(result.confirmedInputs, 0);
    assert.equal(f.archiveCalls.length, 0);
    assert.equal(f.calls.some(call => ["wait", "step", "resume-step"].includes(call.command)), false);
  } finally { await f.clean(); }
});

test("an incomplete failed-attempt archive allows one same-request read-only resume but blocks later input after recovery", async () => {
  for (const complete of [false, null]) {
    const plan = basePlan(); plan.steps.push({ ...plan.steps[0], id: "later" });
    const f = await fixture(plan, (command, _args, result) => command === "step" ? { ...result, verified: false, isError: true } : result,
      index => index === 3 ? complete : true);
    try {
      const result = await f.run(); assert.equal(result.stopCode, "evidence_archive_incomplete");
      assert.equal(result.independentResumeAttempts, 1); assert.equal(result.confirmedInputs, 1); assert.equal(result.completeSuccess, false);
      const input = f.calls.filter(call => call.command === "step"), resumes = f.calls.filter(call => call.command === "resume-step");
      assert.equal(input.length, 1); assert.equal(resumes.length, 1);
      assert.equal(JSON.parse(input[0].args[1]).requestId, resumes[0].args[3]);
      assert.equal(f.archiveCalls.length, 4); assert.equal(f.archiveCalls[2].at.includes("resume-step"), false);
      const records = (await readFile(join(f.output, "samples.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const action = records.find(item => item.event === "result" && item.step === "open");
      assert.equal(action.independentResumePassed, true); assert.equal(action.functionalPassed, true);
      assert.equal(action.archives[1].evidence.complete, true); assert.equal(action.archives[0].evidence.complete, complete);
    } finally { await f.clean(); }
  }
});

test("incomplete archives never replace an original product failure or add another input", async () => {
  for (const failure of ["resume_failed", "expectation_not_met_timeout", "dispatch_unknown"]) {
    const plan = basePlan(); plan.steps.push({ ...plan.steps[0], id: "later" });
    const f = await fixture(plan, (command, _args, result) => ["step", "resume-step"].includes(command)
      ? { ...result, verified: false, isError: true, dispatchState: failure === "dispatch_unknown" ? "unknown" : "sent", error: { code: failure } } : result,
    index => index <= 2 ? true : false);
    try {
      const result = await f.run(); assert.equal(result.stopCode, failure); assert.equal(result.completeSuccess, false);
      assert.equal(result.evidence.complete, false); assert.equal(f.calls.filter(call => call.command === "step").length, 1);
      assert.equal(f.calls.filter(call => call.command === "resume-step").length, failure === "resume_failed" ? 1 : 0);
    } finally { await f.clean(); }
  }
});

test("a verified-observation expectation timeout stops instead of adding a read-only resume", async () => {
  const plan = basePlan(); plan.steps.push({ ...plan.steps[0], id: "later" });
  const f = await fixture(plan, (command, _args, result) => command === "step" ? { ...result, verified: false, isError: true,
    error: { code: "expectation_not_met_timeout", phase: "verify", category: "timeout", message: "Fixture unmet expectation" } } : result);
  try {
    const result = await f.run(); assert.equal(result.stopCode, "expectation_not_met_timeout"); assert.equal(result.functionalPassed, false);
    assert.equal(result.confirmedInputs, 1); assert.equal(result.independentResumeAttempts, 0); assert.equal(f.archiveCalls.length, 3);
    assert.equal(f.calls.some(call => call.command === "resume-step"), false); assert.equal(f.calls.filter(call => call.command === "step").length, 1);
  } finally { await f.clean(); }
});

test("unknown dispatch stops without resume, replay, or next action", async () => {
  const plan = basePlan(); plan.steps.push({ ...plan.steps[0], id: "later" });
  const f = await fixture(plan, (command, _args, result) => command === "step" ? { ...result, verified: false, dispatchState: "unknown" } : result);
  try {
    const result = await f.run(); assert.equal(result.stopCode, "dispatch_unknown"); assert.equal(result.uncertainInputs, 1);
    assert.equal(result.confirmedInputs, 0); assert.equal(result.functionalPassed, false); assert.equal(result.humanInterventionRequired, true);
    assert.deepEqual(f.calls.filter(call => ["step", "resume-step"].includes(call.command)).map(call => call.command), ["step"]);
  } finally { await f.clean(); }
});

test("not_sent failure stops and cannot choose a replacement target", async () => {
  const f = await fixture(basePlan(), (command, _args, result) => command === "step" ? { ...result, verified: false, isError: true, dispatchState: "not_sent" } : result);
  try { const result = await f.run(); assert.equal(result.stopCode, "input_not_sent"); assert.equal(result.notSentInputs, 1);
    assert.equal(f.calls.some(call => call.command === "resume-step"), false); }
  finally { await f.clean(); }
});

test("Helper automatic retries are separate from independent resume attempts", async () => {
  const f = await fixture(basePlan(), (command, _args, result) => command === "step" ? { ...result,
    observationFailures: [{ attempt: 1, elapsedMs: 3, willRetry: true, error: { helperDiagnostics: { version: 1, reasons: [{ code: "child_unavailable", count: 1 }] } } }] } : result);
  try { const result = await f.run(); assert.equal(result.helperAutoRecoveryReads, 1); assert.equal(result.independentResumeAttempts, 0);
    assert.equal(result.firstAttemptSuccessRate, 0); assert.equal(result.confirmedInputs, 1); }
  finally { await f.clean(); }
});

test("scroll-until counts each iteration once, including after read-only resume", async () => {
  const plan = basePlan() as Record<string, unknown>;
  plan.steps = [{ id: "bottom", kind: "scroll-until", input: { target: { selector: { resourceId: "com.example.fixture:id/list" } },
    direction: "down", until: { selector: { resourceId: "com.example.fixture:id/end" }, kind: "end_marker" }, maxScrolls: 3, timeoutMs: 1000 } }];
  const f = await fixture(plan as ReturnType<typeof basePlan>, (command, _args, result) => command === "scroll-until" ? { ...result, verified: false, isError: true } : result);
  try { const result = await f.run(); assert.equal(result.functionalPassed, true); assert.equal(result.confirmedInputs, 2);
    assert.equal(result.independentResumeAttempts, 1); assert.equal(f.calls.filter(call => call.command === "scroll-until").length, 1); }
  finally { await f.clean(); }
});

test("missing action timings never become zero or complete success", async () => {
  const f = await fixture(basePlan(), (command, _args, result) => { if (command === "step") delete result.timings; return result; });
  try { const result = await f.run(); assert.equal(result.functionalPassed, true); assert.equal(result.completeSuccess, false);
    assert.equal(result.productMs, null); assert.equal(result.measuredProductMs, 20); assert.equal(result.evidence.complete, true); }
  finally { await f.clean(); }
});

test("missing action stepId is unknown timing and never a measured zero", async () => {
  const f = await fixture(basePlan(), (command, _args, result) => { if (command === "step") { delete result.stepId; delete result.timings; } return result; });
  try { const result = await f.run(); assert.equal(result.productMs, null); assert.equal(result.productTimingsComplete, false); assert.equal(result.completeSuccess, false);
    const samples = (await readFile(join(f.output, "samples.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(samples.find(item => item.event === "result" && item.step === "open").productMs, null); }
  finally { await f.clean(); }
});

test("missing request result or an unfinished ledger never causes replay or resume", async () => {
  for (const state of ["running", "interrupted", "missing"] as const) {
    const f = await fixture(basePlan(), (command, _args, result) => command === "step"
      ? state === "missing" ? { found: false } : { ...result, requestState: state, verified: false } : result);
    try { const result = await f.run(); assert.equal(result.functionalPassed, false); assert.equal(result.completeSuccess, false);
      assert.equal(f.calls.filter(call => call.command === "step").length, 1); assert.equal(f.calls.some(call => call.command === "resume-step"), false); }
    finally { await f.clean(); }
  }
});

test("lost resume reply only queries the same UUID and does not add another input", async () => {
  const f = await fixture(basePlan(), (command, _args, result) => {
    if (command === "step") return { ...result, isError: true, verified: false };
    if (command === "resume-step") throw new Error("lost private reply");
    return result;
  });
  try { const result = await f.run(); assert.equal(result.functionalPassed, true); assert.equal(result.confirmedInputs, 1);
    assert.equal(result.independentResumeAttempts, 1); assert.equal(result.responseRecoveries, 1);
    assert.equal(f.calls.filter(call => call.command === "resume-step").length, 1); assert.equal(f.calls.filter(call => call.command === "step").length, 1); }
  finally { await f.clean(); }
});

test("invalid resume/get replies cannot erase known input counts or count another UUID", async () => {
  for (const malformed of ["other_uuid", "lost_then_missing", "reduced_history"] as const) {
    const f = await fixture(basePlan(), (command, _args, result) => {
      if (command === "step") return { ...result, isError: true, verified: false };
      if (command === "resume-step") {
        if (malformed === "lost_then_missing") throw new Error("private lost response");
        return malformed === "other_uuid" ? { ...result, requestId: randomUUID(), dispatchState: "unknown" }
          : { ...result, dispatchState: "not_sent" };
      }
      if (command === "get-step" && malformed === "lost_then_missing") return { found: false };
      return result;
    });
    try {
      const result = await f.run(); assert.equal(result.functionalPassed, false); assert.equal(result.confirmedInputs, 1);
      assert.equal(result.uncertainInputs, 0); assert.equal(result.notSentInputs, 0); assert.equal(result.inputCountKnown, true);
      assert.equal(f.calls.filter(call => call.command === "step").length, 1); assert.equal(result.independentResumeAttempts, 1);
    } finally { await f.clean(); }
  }
});

test("expired/short grant, changed identity, blocked checkpoint and wrong backend prevent all inputs", async () => {
  for (const hook of [
    (command: string, _args: string[], result: Json) => command === "attach" ? { ...result, expiresAt: new Date(Date.now() + 1000).toISOString() } : result,
    (command: string, _args: string[], result: Json) => command === "attach" ? { ...result, serial: "another" } : result,
    (command: string, _args: string[], result: Json) => command === "wait" ? { ...result, isError: true, verified: false } : result,
    (command: string, _args: string[], result: Json) => command === "capture" ? { ...result, source: "uiautomator" } : result,
    (command: string, _args: string[], result: Json) => command === "find" ? { ...result, total: 2 } : result,
  ]) {
    const f = await fixture(basePlan(), hook);
    try { const result = await f.run(); assert.equal(result.functionalPassed, false); assert.equal(result.completeSuccess, false);
      assert.equal(f.calls.some(call => call.command === "step"), false); }
    finally { await f.clean(); }
  }
});

test("failed initial checkpoint refreshes a previously null report path and archives its known steps without input", async () => {
  let captured = false;
  const f = await fixture(basePlan(), (command, _args, result) => {
    if (command === "attach" && !captured) return { ...result, reportPath: null };
    if (command === "capture") captured = true;
    if (command === "wait") return { ...result, isError: true, verified: false };
    return result;
  });
  try {
    const result = await f.run(); assert.equal(result.stopCode, "checkpoint_not_verified"); assert.equal(result.confirmedInputs, 0);
    assert.equal(f.archiveCalls.length, 2); assert.deepEqual(f.archiveCalls.map(item => item.ids), [[1], [2]]);
    assert.equal(f.archiveCalls[0].sourcePath, join(f.directory, "report.json")); assert.equal(result.productReportPath, f.archiveCalls[0].sourcePath);
    assert.deepEqual(f.calls.map(call => call.command), ["attach", "attach", "capture", "attach", "wait", "attach"]);
    const records = (await readFile(join(f.output, "samples.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.find(item => item.event === "result").archives.length, 2);
  } finally { await f.clean(); }
});

test("checkpoint archive failure preserves the original stop code and records unknown evidence", async () => {
  let archiveAttempts = 0;
  const f = await fixture(basePlan(), (command, _args, result) => command === "wait" ? { ...result, isError: true, verified: false } : result);
  try {
    const result = await f.run({ archive: async () => {
      if (++archiveAttempts === 1) return { reportPath: join(f.directory, "capture.json"), evidence: evidence(true) };
      throw new Error("Fixture archive failure");
    } });
    assert.equal(result.stopCode, "checkpoint_not_verified"); assert.equal(result.confirmedInputs, 0); assert.equal(archiveAttempts, 2);
    assert.equal(result.evidence.complete, null); assert.equal(f.calls.filter(call => call.command === "attach").length, 4);
    const records = (await readFile(join(f.output, "samples.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.find(item => item.event === "result").archives[1].evidence.reason, "archive_failed");
  } finally { await f.clean(); }
});

test("a failed checkpoint with no known step ids or cancellation does not refresh or force an archive", async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const f = await fixture(basePlan(), (command, _args, result) => {
      if (!cancelled && (command === "capture" || command === "wait")) delete result.stepId;
      if (command === "wait") {
        if (cancelled) controller.abort();
        return { ...result, isError: true, verified: false };
      }
      return result;
    });
    try {
      const result = await f.run({ signal: controller.signal });
      assert.equal(result.stopCode, cancelled ? "cancelled" : "checkpoint_not_verified"); assert.equal(result.confirmedInputs, 0);
      assert.equal(f.archiveCalls.length, cancelled ? 1 : 0); assert.equal(f.calls.filter(call => call.command === "attach").length, cancelled ? 3 : 2);
      assert.equal(f.calls.some(call => ["step", "scroll-until", "resume-step"].includes(call.command)), false);
    } finally { await f.clean(); }
  }
});

test("cancellation stops the current request and subsequent steps without replay", async () => {
  const controller = new AbortController(), plan = basePlan(); plan.steps.push({ ...plan.steps[0], id: "later" });
  const f = await fixture(plan, (command, _args, result) => { if (command === "step") { controller.abort(); throw new Error("cancelled"); } return result; });
  try { const result = await f.run({ signal: controller.signal }); assert.equal(result.stopCode, "cancelled");
    assert.equal(f.calls.filter(call => call.command === "step").length, 1); assert.equal(f.calls.some(call => call.command === "get-step"), false); }
  finally { await f.clean(); }
});

test("the total time budget prevents the next input even if a prior action has returned success", async () => {
  let clock = Date.now(); const plan = basePlan(); plan.steps.push({ ...plan.steps[0], id: "later" });
  const f = await fixture(plan, (command, _args, result) => { if (command === "step") clock += plan.maxDurationMs + 1; return result; });
  try { const result = await f.run({ now: () => clock }); assert.equal(result.stopCode, "duration_limit");
    assert.equal(f.calls.filter(call => call.command === "step").length, 1); assert.equal(result.functionalPassed, false); }
  finally { await f.clean(); }
});

test("evidence inspection treats trimmed or unloadable attachments as incomplete, and unavailable report as unknown", async () => {
  const id = randomUUID(), loaded = { debug: { session: { id: sessionId, serial: "offline-device", packageName: "com.example.fixture" },
    steps: [{ step: { id: 1, verified: true }, before: { snapshotId: id }, after: { snapshotId: id } }],
    snapshots: [{ evidence: { snapshotId: id, tree: null, screenshot: null }, snapshot: null, treeError: "private page", screenshotArtifactId: null }] }, images: [] } as unknown as LoadedTestReport;
  const identity = { sessionId, serial: "offline-device", packageName: "com.example.fixture" };
  const result = await inspectRegressionEvidence("/fixture/report.json", [1, 2], identity, async () => loaded);
  assert.equal(result.complete, false); assert.equal(result.missingSteps, 1); assert.equal(result.missingTrees, 1); assert.equal(result.missingScreenshots, 1);
  assert.equal(JSON.stringify(result).includes("private page"), false);
  const unknown = await inspectRegressionEvidence(null, [1], identity, async () => loaded); assert.equal(unknown.complete, null);
  loaded.debug!.steps = [{ step: { id: 1, action: "perform_ui_step", verified: false }, before: { snapshotId: null }, after: { snapshotId: null } }] as unknown as NonNullable<LoadedTestReport["debug"]>["steps"];
  const missing = await inspectRegressionEvidence("/fixture/report.json", [1], identity, async () => loaded);
  assert.equal(missing.complete, false); assert.equal(missing.missingTrees, 0); assert.equal(missing.missingScreenshots, 0);
  assert.equal(missing.absentObservations, 2); assert.equal(missing.reason, "observation_not_produced");
});

test("existing product exporter creates private per-step evidence that reimports independently of the live report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inspector-regression-product-fixture-"));
  const packageName = "com.example.fixture", root = makeNode("0"), video = makeNode("0/0");
  root.package = video.package = packageName; root.resourceId = condition.selector.resourceId;
  video.resourceId = `${packageName}:id/video`; video.text = "PRIVATE_PAGE_LABEL";
  root.bounds = { left: 0, top: 0, right: 100, bottom: 200, raw: "[0,0][100,200]" };
  video.bounds = { left: 10, top: 20, right: 80, bottom: 70, raw: "[10,20][80,70]" };
  root.visibleToUser = video.visibleToUser = root.enabled = video.enabled = true;
  root.clickable = false; video.clickable = true; root.children = [video];
  const frame = { width: 100, height: 200, rotation: 0 as const };
  const png = await sharp({ create: { width: 100, height: 200, channels: 4, background: "#f0f0f0" } }).png().toBuffer();
  const snapshot: UiSnapshot = { serial: "offline-device", root, nodeCount: 2, xmlSize: 0, rawXml: null,
    screenshotDataUrl: `data:image/png;base64,${png.toString("base64")}`, error: null, warning: null, captureMode: "fast", inspectionSource: "uiautomator",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } };
  let inputs = 0, latestSnapshotId = "";
  const session = new DebugSession({ serial: snapshot.serial, packageName, directory: join(directory, "product"), snapshotPath: join(directory, "current.json"),
    onEvent: () => {}, observe: async () => measureDebugPhase("observation", async () => ({ snapshot,
      target: { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "fixture" } }), { backend: "uiautomator" }),
    input: async (_serial, _target, _action, _frame, _signal, onEvidence) => { inputs++; onEvidence?.({ classification: "accepted", spawned: true, closed: true,
      exitCode: 0, signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }); } });
  const plan = { ...basePlan(), backend: "uiautomator" };
  try {
    const result = await runUiRegression({ plan, sessionId: session.state.id, outputDirectory: join(directory, "run"), execute: async (command, args) => {
      if (command === "attach") return session.request({ name: "get_debug_session", input: {} });
      if (command === "find") return { snapshotId: latestSnapshotId, total: 1, items: [] };
      const input = command === "step" ? JSON.parse(args[1]) : command === "capture" ? { sessionId: session.state.id, mode: "fast", backend: "uiautomator" }
        : { sessionId: session.state.id, selector: condition.selector, state: condition.state, timeoutMs: 1000 };
      const response = await session.request({ name: command === "step" ? "perform_ui_step" : command === "capture" ? "capture_ui" : "wait_for_ui", input });
      assert.equal(response.recordingErrors, undefined, JSON.stringify(response.recordingErrors));
      if (typeof response.snapshotId === "string") latestSnapshotId = response.snapshotId;
      return response;
    } });
    assert.equal(result.functionalPassed, true, JSON.stringify(result));
    await loadTestReport(result.productReportPath!);
    assert.equal(result.completeSuccess, true, JSON.stringify(result)); assert.equal(inputs, 1);
    const samples = (await readFile(join(directory, "run/samples.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const archived = samples.filter(item => item.event === "archive"); assert.equal(archived.length, 5);
    session.stop("Fixture complete"); await session.settled();
    await rm(join(directory, "product"), { recursive: true, force: true });
    for (const archive of archived) {
      const loaded = await loadTestReport(archive.reportPath);
      assert.ok(loaded.debug!.steps.length); assert.ok(loaded.images.every(image => image.dataUrl && !image.error));
    }
  } finally { session.stop(); await session.settled(); await rm(directory, { recursive: true, force: true }); }
});

async function recoveryReport(kind: "tap" | "back" = "tap", failureCode: "capture_failed" | "helper-incomplete" = "capture_failed") {
  const f = await makeDebugReportExportFixture();
  const packageName = "com.example.fixture", serial = "offline-device", frame = { width: 100, height: 200, rotation: 0 as const };
  Object.assign(f.report.session, { id: sessionId, packageName, serial, totalSteps: 4, droppedSteps: 2 });
  const snapshots = f.report.snapshots.map((_, index) => {
    const snapshot = helperEvidenceSnapshot({ packageName, serial, ...frame, startedAt: 100 + index * 400, text: index ? "END" : "START" });
    Object.assign(snapshot.root!.attributes!, { "debug-observation-component": `${packageName}/.Main`,
      "debug-observation-window-id": "task-window", "debug-observation-activity-record-id": "activity-1" });
    if (index) {
      snapshot.helperObservation!.windowsBefore.push({ id: "8", type: "system", layer: 2, focused: false, active: false,
        packageName: "com.android.systemui", rootAvailable: true, bounds: { x: 0, y: 0, width: 100, height: 20 } });
      snapshot.helperObservation!.windowsAfter = structuredClone(snapshot.helperObservation!.windowsBefore);
    }
    return snapshot;
  });
  const image = await sharp({ create: { width: 100, height: 200, channels: 4, background: "#335577" } }).png().toBuffer();
  const ids = f.report.snapshots.map(item => item.snapshotId), original = f.report.steps[2];
  original.step = { id: 3, time: f.report.session.startedAt, action: "perform_ui_step", status: "failed", message: "采集失败",
    input: performUiStepInput.parse({ sessionId, requestId: randomUUID(), backend: "accessibility-helper", action: { kind },
      ...(kind === "tap" ? { target: { selector: { text: "START" } } } : {}),
      expect: { selector: { text: "END" }, state: "visible", visibility: "partial" }, timeoutMs: 1000 }),
    beforeId: ids[0], dispatchState: "sent", verified: false,
    error: { category: "capture", code: failureCode, phase: "capture", message: "fixture capture failed",
      ...(failureCode === "helper-incomplete" ? { helperDiagnostics: { version: 1 as const,
        reasons: [{ code: "window_inventory_changed" as const, count: 1 }, { code: "focus_invalid" as const, count: 1 }] } } : {}) },
    resolvedInput: kind === "tap" ? { action: { kind, x: 50, y: 100 }, frame, targetNodeId: "0" } : { action: { kind }, frame },
    inputEvidence: { classification: "accepted", spawned: true, closed: true, exitCode: 0, signal: null, durationMs: 1,
      stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false } };
  original.finishedAt = "2026-10-12T09:00:00.500Z"; original.verified = false;
  original.before = { snapshotId: ids[0], freshness: "current", reason: null };
  original.after = { snapshotId: null, freshness: "missing", reason: "操作后没有接受到新观察" };
  const observation = (index: number) => ({ snapshotId: ids[index], capturedAt: f.report.snapshots[index].capturedAt,
    component: `${packageName}/.Main`, windowId: "task-window", activityRecordId: "activity-1" });
  const resumed = { step: { id: 4, time: "2026-10-12T09:00:01.000Z", action: "resume_ui_step" as const,
    input: { sessionId, requestId: original.step.input.requestId, timeoutMs: 1000 }, status: "done" as const, message: "只读恢复确认",
    afterId: ids[2], dispatchState: "sent" as const, verified: true,
    assertionConfirmation: { first: observation(1), second: observation(2) } },
    finishedAt: f.report.session.updatedAt, durationMs: 2000, verified: true,
    before: { snapshotId: null, freshness: "missing" as const, reason: "没有接受到该阶段的观察" },
    after: { snapshotId: ids[2], freshness: "current" as const, reason: null } };
  f.report.steps = [original, resumed];
  const save = () => {
    for (const [index, evidence] of f.report.snapshots.entries()) {
      evidence.source = "accessibility-helper";
      evidence.tree = f.artifact(Buffer.from(JSON.stringify({ schemaVersion: DEBUG_SNAPSHOT_VERSION,
        content: "tree-properties-without-layer-bitmaps", snapshotId: evidence.snapshotId, capturedAt: evidence.capturedAt, snapshot: snapshots[index] })), "json");
      evidence.screenshot = f.artifact(image, "png");
    }
    f.save();
  };
  const identity = { sessionId, packageName, serial };
  save();
  return { ...f, original, resumed, snapshots, ids, identity, save, saveManifest: f.save,
    inspect: (stepIds = [3, 4], expectedVerifiedId: number | undefined = 4) => inspectRegressionEvidence(f.file, stepIds, identity, loadTestReport, expectedVerifiedId) };
}

test("absent observation slots remain explicit while a bound partial tap/back recovery proves its complete chain", async () => {
  for (const failureCode of ["capture_failed", "helper-incomplete"] as const) for (const kind of ["tap", "back"] as const) {
    const f = await recoveryReport(kind, failureCode);
    try {
      const failed = await inspectRegressionEvidence(f.file, [3], f.identity, loadTestReport);
      assert.equal(failed.complete, false); assert.equal(failed.absentObservations, 1);
      assert.equal(failed.missingTrees, 0); assert.equal(failed.missingScreenshots, 0);
      assert.ok(failed.recoverableFailure); assert.equal(failed.reason, "observation_not_produced");
      const recovered = await f.inspect();
      assert.equal(recovered.complete, true); assert.equal(recovered.absentObservations, 2);
      assert.equal(recovered.missingTrees, 0); assert.equal(recovered.missingScreenshots, 0);
      assert.equal(recovered.recoveryChain!.originalFingerprint, failed.recoverableFailure!.originalFingerprint);
      assert.equal(recovered.recoveryChain!.resumeStepId, 4);
      const raw = JSON.parse(await readFile(f.file, "utf8"));
      assert.equal(raw.steps[0].step.status, "failed"); assert.equal(raw.steps[0].verified, false);
      assert.equal(raw.steps[0].step.error.code, failureCode);
      assert.equal(raw.steps[0].after.snapshotId, null, "recovery does not rewrite the failed observation");
    } finally { f.cleanup(); }
  }
});

test("recovery chains reject absent original input, referenced attachment loss, uncertain dispatch and forged bindings", async () => {
  type F = Awaited<ReturnType<typeof recoveryReport>>;
  const changes: Array<[string, (f: F) => void]> = [
    ["before tree missing", f => { f.report.snapshots[0].tree = null; }],
    ["before PNG missing", f => { f.report.snapshots[0].screenshot = null; }],
    ["first proof PNG missing", f => { f.report.snapshots[1].screenshot = null; }],
    ["second proof tree missing", f => { f.report.snapshots[2].tree = null; }],
    ["original step missing", f => { f.report.steps = [f.resumed]; f.report.session.droppedSteps = 3; }],
    ["original before reference missing", f => { delete f.original.step.beforeId;
      f.original.before = { snapshotId: null, freshness: "missing", reason: "no before" }; }],
    ["wrong UUID", f => { f.resumed.step.input.requestId = randomUUID(); }],
    ["wrong session", f => { f.resumed.step.input.sessionId = randomUUID(); }],
    ["wrong step", f => { f.resumed.step.id = 5; }],
    ["unknown input", f => { f.original.step.dispatchState = "unknown"; f.resumed.step.dispatchState = "unknown" as "sent"; }],
    ["uncertain receipt", f => { f.original.step.inputEvidence!.classification = "unconfirmed-exit"; }],
    ["missing receipt", f => { delete f.original.step.inputEvidence; }],
    ["missing resolved input", f => { delete f.original.step.resolvedInput; }],
    ["resume precedes original finish", f => { f.resumed.step.time = "2026-10-12T09:00:00.100Z"; }],
    ["stale proof", f => { f.resumed.step.assertionConfirmation.first.capturedAt = f.report.session.startedAt; }],
    ["wrong proof identity", f => { f.resumed.step.assertionConfirmation.first.windowId = "other-window"; }],
    ["another failure", f => { f.original.step.error!.code = "verify_failed"; }],
    ["nonpartial", f => { delete (f.original.step.input.expect as Json).visibility; }],
    ["wrong backend", f => { f.original.step.input.backend = "uiautomator"; }],
    ["later input in recovery", f => { Object.assign(f.resumed.step, { inputEvidence: f.original.step.inputEvidence }); }],
  ];
  for (const failureCode of ["capture_failed", "helper-incomplete"] as const) for (const [label, change] of changes) {
    const f = await recoveryReport("tap", failureCode);
    try { change(f); f.saveManifest(); const result = await f.inspect();
      assert.notEqual(result.complete, true, label); assert.equal(result.recoveryChain, undefined, label);
      if (label === "before PNG missing") { assert.equal(result.missingScreenshots, 1); assert.equal(result.absentObservations, 2); }
    } finally { f.cleanup(); }
  }
});

test("helper-incomplete recovery requires a nonempty closed diagnostic and never admits other failure categories or sources", async () => {
  type F = Awaited<ReturnType<typeof recoveryReport>>;
  const changes: Array<[string, (f: F) => void]> = [
    ["missing diagnostics", f => { delete f.original.step.error!.helperDiagnostics; }],
    ["empty diagnostics", f => { f.original.step.error!.helperDiagnostics!.reasons = []; }],
    ["unknown diagnostic version", f => { Object.assign(f.original.step.error!.helperDiagnostics!, { version: 2 }); }],
    ["unknown diagnostic code", f => { Object.assign(f.original.step.error!.helperDiagnostics!.reasons[0], { code: "untrusted" }); }],
    ["duplicate diagnostic", f => { f.original.step.error!.helperDiagnostics!.reasons.push(f.original.step.error!.helperDiagnostics!.reasons[0]); }],
    ["invalid diagnostic count", f => { f.original.step.error!.helperDiagnostics!.reasons[0].count = 0; }],
    ["unknown diagnostic field", f => { Object.assign(f.original.step.error!.helperDiagnostics!, { arbitrary: "untrusted" }); }],
    ["wrong category", f => { f.original.step.error!.category = "input"; }],
    ["wrong phase", f => { f.original.step.error!.phase = "verify"; }],
    ...["helper-session", "helper-cleanup", "helper-evidence", "helper-invalid", "helper-capture-failed"].map(code =>
      [code, (f: F) => { f.original.step.error!.code = code; }] as [string, (f: F) => void]),
  ];
  for (const [label, change] of changes) {
    const f = await recoveryReport("tap", "helper-incomplete");
    try {
      change(f); f.saveManifest();
      const failed = await inspectRegressionEvidence(f.file, [3], f.identity, loadTestReport), recovered = await f.inspect();
      assert.equal(failed.recoverableFailure, undefined, label);
      assert.notEqual(recovered.complete, true, label); assert.equal(recovered.recoveryChain, undefined, label);
    } finally { f.cleanup(); }
  }
  const f = await recoveryReport("tap", "helper-incomplete");
  try {
    // A rejected failed-frame candidate is never evidence; the later independent complete frames can still prove recovery.
    f.original.step.error!.helperRecoveryDiagnostics = { version: 1, candidate: "inventory_after_invalid", executor: "candidate_unavailable" };
    f.saveManifest();
    assert.equal((await f.inspect()).complete, true);
  } finally { f.cleanup(); }
});

test("no expected successful resume or different requested steps cannot authorize a chain", async () => {
  const f = await recoveryReport();
  try {
    for (const [ids, verified] of [[[3, 4], undefined], [[3, 4], 3], [[4], 4], [[3, 4, 5], 4]] as const) {
      const result = await inspectRegressionEvidence(f.file, [...ids], f.identity, loadTestReport, verified);
      assert.notEqual(result.complete, true); assert.equal(result.recoveryChain, undefined);
    }
  } finally { f.cleanup(); }
});

test("recovery first frame must be new on the Helper clock and after its input receipt, while navigation may change windows", async () => {
  for (const failureCode of ["capture_failed", "helper-incomplete"] as const)
  for (const variant of ["fresh", "same capture", "overlapping capture", "pre-input capture", "receipt boundary", "new window", "wrong service"] as const) {
    const f = await recoveryReport("back", failureCode);
    try {
      const before = f.snapshots[0].helperObservation!, first = f.snapshots[1].helperObservation!;
      const requestId = randomUUID();
      f.original.step.inputEvidence = { classification: "accepted", transport: "accessibility-helper",
        spawned: false, closed: false, exitCode: null, signal: null, durationMs: 1,
        stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
        helperInput: { dispatchState: "sent", requestId, receipt: { version: 1, sessionId, requestId,
          serviceInstanceId: before.serviceInstanceId, captureId: before.captureId, packageName: before.packageName,
          windowId: before.windowId, display: before.displayAfter, method: "global-back", status: "completed", dispatchState: "sent",
          startedAtMs: 110, finishedAtMs: variant === "receipt boundary" ? first.timing.startedAtMs : 400 } } };
      if (variant === "same capture") first.captureId = before.captureId;
      if (variant === "overlapping capture" || variant === "pre-input capture")
        first.timing = helperEvidenceSnapshot({ startedAt: variant === "overlapping capture" ? 103 : 200 }).helperObservation!.timing;
      if (variant === "new window") for (const snapshot of f.snapshots.slice(1)) {
        snapshot.helperObservation!.windowId = "9";
        for (const windows of [snapshot.helperObservation!.windowsBefore, snapshot.helperObservation!.windowsAfter]) windows[0].id = "9";
        snapshot.root!.attributes!["window-id"] = "9";
        snapshot.rawXml = snapshot.rawXml!.replace('window-id="7"', 'window-id="9"');
      }
      if (variant === "wrong service") {
        const differentService = randomUUID();
        for (const snapshot of f.snapshots.slice(1)) snapshot.helperObservation!.serviceInstanceId = differentService;
      }
      f.save();
      // The ordinary loader verifies the two confirming frames; the recovery chain also checks their link to the original input.
      const verified = (await loadTestReport(f.file)).debug!.steps.find(entry => entry.step.id === 4)!.verified;
      if (variant === "wrong service") assert.notEqual(verified, true, variant); else assert.equal(verified, true, variant);
      const result = await f.inspect(), valid = ["fresh", "receipt boundary", "new window"].includes(variant);
      assert.equal(result.complete, valid, variant);
      assert.equal(Boolean(result.recoveryChain), valid, variant);
      assert.equal(result.missingTrees, 0); assert.equal(result.missingScreenshots, 0);
    } finally { f.cleanup(); }
  }
});

test("runner continues only after a complete same-request exported recovery chain and counts the first input once", async () => {
  for (const failureCode of ["capture_failed", "helper-incomplete"] as const)
  for (const mutation of ["none", "changed original", "different expectation", "changed before", "lost PNG"] as const) {
    const report = await recoveryReport("tap", failureCode);
    const plan = basePlan(), action = report.original.step.input;
    plan.steps[0].input = { target: action.target, action: action.action, expect: action.expect, timeoutMs: action.timeoutMs } as typeof plan.steps[0]["input"];
    plan.steps.push({ ...plan.steps[0], id: "later" });
    let inputCalls = 0;
    const f = await fixture(plan, (command, _args, result) => command === "step" && ++inputCalls === 1
      ? { ...result, verified: false, isError: true, error: { code: failureCode } } : result);
    let actionArchives = 0;
    try {
      const result = await f.run({ archive: async (_path, ids, _parent, identity, _signal, verifiedId) => {
        if (ids[0] !== 3) return { reportPath: "/fixture/report.json", evidence: evidence() };
        actionArchives++;
        report.original.step.input = JSON.parse(f.calls.find(call => call.command === "step")!.args[1]);
        report.resumed.step.input.requestId = report.original.step.input.requestId;
        if (actionArchives === 2 && mutation === "changed original") report.original.step.error!.message = "different original failure";
        if (mutation === "different expectation") (report.original.step.input.expect as Json).selector = { resourceId: "com.example.fixture:id/result" };
        if (actionArchives === 2 && mutation === "changed before") report.snapshots[0].root!.attributes!.fixture = "replaced captured tree";
        report.save();
        if (actionArchives === 2 && mutation === "lost PNG") { report.report.snapshots[0].screenshot = null; report.saveManifest(); }
        const exported = await exportDebugReportEvidence(report.source(), { ...report.request(), stepIds: ids, includeLogs: false },
          report.parent, { appVersion: "fixture" });
        assert.equal(exported.error, null, mutation);
        const path = join(exported.directory!, "report.json");
        return { reportPath: path, evidence: await inspectRegressionEvidence(path, ids, identity, loadTestReport, verifiedId) };
      } });
      assert.equal(result.completeSuccess, mutation === "none", mutation);
      assert.equal(f.calls.filter(call => call.command === "resume-step").length, 1);
      assert.equal(f.calls.filter(call => call.command === "step").length, mutation === "none" ? 2 : 1);
      assert.equal(result.confirmedInputs, mutation === "none" ? 2 : 1);
      const log = (await readFile(join(f.output, "samples.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const first = log.find(item => item.event === "result" && item.step === "open");
      assert.equal(first.archives[0].evidence.complete, false, "historical failure stays unchanged");
      if (mutation === "none") {
        assert.equal(result.evidence.complete, true); assert.equal(result.evidence.absentObservations, 3);
        assert.equal(result.evidence.missingTrees, 0); assert.equal(result.evidence.missingScreenshots, 0);
        assert.equal(first.archives[1].evidence.complete, true);
      } else assert.equal(result.stopCode, "evidence_archive_incomplete");
    } finally { await f.clean(); report.cleanup(); }
  }
});
