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
async function fixture(plan = basePlan(), hook?: Hook, archiveComplete: boolean | null = true) {
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
        return { reportPath: join(directory, "private-evidence", `${archiveCalls.length}`, "report.json"), evidence: evidence(archiveComplete) }; }, ...extra }),
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

test("ten rounds use unique durable UUIDs, archive before next input and exclude page data from statistics", async () => {
  const f = await fixture({ ...basePlan(), rounds: 10 });
  try {
    const result = await f.run();
    assert.equal(result.completedRounds, 10); assert.equal(result.functionalPassed, true); assert.equal(result.completeSuccess, true);
    assert.equal(result.confirmedInputs, 10); assert.equal(result.productMs, 250); assert.equal(result.firstAttemptSuccessRate, 1);
    const requests = f.calls.filter(call => call.command === "step").map(call => JSON.parse(call.args[1]).requestId);
    assert.equal(new Set(requests).size, 10); assert.equal(f.archiveCalls.length, 30);
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
    assert.equal(f.archiveCalls.length, 60);
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
    const failedArchive = f.archiveCalls[1], resumedArchive = f.archiveCalls[2];
    assert.equal(failedArchive.at.includes("resume-step"), false); assert.equal(resumedArchive.ids.length, 2);
  } finally { await f.clean(); }
});

test("a verified-observation expectation timeout stops instead of adding a read-only resume", async () => {
  const plan = basePlan(); plan.steps.push({ ...plan.steps[0], id: "later" });
  const f = await fixture(plan, (command, _args, result) => command === "step" ? { ...result, verified: false, isError: true,
    error: { code: "expectation_not_met_timeout", phase: "verify", category: "timeout", message: "Fixture unmet expectation" } } : result);
  try {
    const result = await f.run(); assert.equal(result.stopCode, "expectation_not_met_timeout"); assert.equal(result.functionalPassed, false);
    assert.equal(result.confirmedInputs, 1); assert.equal(result.independentResumeAttempts, 0); assert.equal(f.archiveCalls.length, 2);
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

test("missing action timings and missing evidence never become zero or complete success", async () => {
  const f = await fixture(basePlan(), (command, _args, result) => { if (command === "step") delete result.timings; return result; }, false);
  try { const result = await f.run(); assert.equal(result.functionalPassed, true); assert.equal(result.completeSuccess, false);
    assert.equal(result.productMs, null); assert.equal(result.measuredProductMs, 20); assert.equal(result.evidence.complete, false); }
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
  let failedWait = false;
  const f = await fixture(basePlan(), (command, _args, result) => {
    if (command === "attach" && !failedWait) return { ...result, reportPath: null };
    if (command === "wait") { failedWait = true; return { ...result, isError: true, verified: false }; }
    return result;
  });
  try {
    const result = await f.run(); assert.equal(result.stopCode, "checkpoint_not_verified"); assert.equal(result.confirmedInputs, 0);
    assert.equal(f.archiveCalls.length, 1); assert.deepEqual(f.archiveCalls[0].ids, [1, 2]);
    assert.equal(f.archiveCalls[0].sourcePath, join(f.directory, "report.json")); assert.equal(result.productReportPath, f.archiveCalls[0].sourcePath);
    assert.deepEqual(f.calls.map(call => call.command), ["attach", "attach", "capture", "wait", "attach"]);
    const records = (await readFile(join(f.output, "samples.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.find(item => item.event === "result").archives.length, 1);
  } finally { await f.clean(); }
});

test("checkpoint archive failure preserves the original stop code and records unknown evidence", async () => {
  let archiveAttempts = 0;
  const f = await fixture(basePlan(), (command, _args, result) => command === "wait" ? { ...result, isError: true, verified: false } : result);
  try {
    const result = await f.run({ archive: async () => { archiveAttempts++; throw new Error("Fixture archive failure"); } });
    assert.equal(result.stopCode, "checkpoint_not_verified"); assert.equal(result.confirmedInputs, 0); assert.equal(archiveAttempts, 1);
    assert.equal(result.evidence.complete, null); assert.equal(f.calls.filter(call => call.command === "attach").length, 3);
    const records = (await readFile(join(f.output, "samples.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.find(item => item.event === "result").archives[0].evidence.reason, "archive_failed");
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
      assert.equal(f.archiveCalls.length, 0); assert.equal(f.calls.filter(call => call.command === "attach").length, 2);
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
  assert.equal(missing.complete, false); assert.equal(missing.missingTrees, 2); assert.equal(missing.missingScreenshots, 2);
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
    const archived = samples.filter(item => item.event === "archive"); assert.equal(archived.length, 3);
    session.stop("Fixture complete"); await session.settled();
    await rm(join(directory, "product"), { recursive: true, force: true });
    for (const archive of archived) {
      const loaded = await loadTestReport(archive.reportPath);
      assert.ok(loaded.debug!.steps.length); assert.ok(loaded.images.every(image => image.dataUrl && !image.error));
    }
  } finally { session.stop(); await session.settled(); await rm(directory, { recursive: true, force: true }); }
});
