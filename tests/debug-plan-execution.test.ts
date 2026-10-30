import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession } from "../electron/automation/debug-session";
import { captureSignal } from "../electron/device/runtime";
import { remainingSignalBudget } from "../electron/device/signal-deadline";
import { DebugEvidenceWriter } from "../electron/automation/debug-evidence";
import { loadTestReport } from "../electron/desktop/test-report";
import type { DebugInputEvidence, UiSnapshot } from "../shared/types";
import type { DebugPlanRun } from "../shared/debug-plan";
import type { DebugSessionReport } from "../shared/debug-report";

const serial = "plan-test", packageName = "com.example.plan";
const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "window-1", activityRecordId: "activity-1" };
const condition = (text: string) => ({ selector: { text }, state: "visible" });
const receipt: DebugInputEvidence = { classification: "accepted", spawned: true, closed: true, exitCode: 0,
  signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };

function page(text: string): UiSnapshot {
  const root = makeNode("0"), button = makeNode("0/0");
  Object.assign(root, { package: packageName, clickable: false, scrollable: false,
    bounds: { left: 0, top: 0, right: 1080, bottom: 2400, raw: "" }, children: [button] });
  Object.assign(button, { package: packageName, resourceId: `${packageName}:id/play`, text, clickable: true,
    enabled: true, visibleToUser: true, scrollable: false, children: [],
    bounds: { left: 20, top: 100, right: 180, bottom: 160, raw: "" } });
  const frame = { width: 1080, height: 2400, rotation: 0 as const };
  return { serial, root, nodeCount: 2, xmlSize: 0, rawXml: null, error: null, warning: null, screenshotDataUrl: null,
    captureMode: "fast", inspectionSource: "uiautomator", hierarchyDumpMode: "full",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } };
}
const tap = (id = "play") => ({ id, kind: "step", input: { target: { selector: { resourceId: `${packageName}:id/play` } },
  action: { kind: "tap" }, expect: condition("暂停"), timeoutMs: 3000 } });
function plan(steps: unknown[] = [tap()]) {
  return { version: 1, title: "播放并验证", backend: "uiautomator", timeoutMs: 10_000,
    startConditions: [condition("播放")], finalConditions: [condition("暂停")], steps };
}
function harness(overrides: Partial<ConstructorParameters<typeof DebugSession>[0]> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "inspector-plan-"));
  let reads = 0, inputs = 0;
  const session = new DebugSession({ serial, packageName, directory, snapshotPath: join(directory, "current.json"), onEvent: () => {},
    observe: async () => { reads++; return { snapshot: page(inputs ? "暂停" : "播放"), target }; },
    input: async (_s, _t, _a, _f, _signal, onEvidence) => { inputs++; onEvidence?.(receipt); }, ...overrides });
  const runId = randomUUID();
  const start = (definition: unknown = plan(), id: string = runId, signal?: AbortSignal) =>
    session.request({ name: "start_debug_plan", input: { sessionId: session.state.id, runId: id, definition } }, signal);
  const get = async () => (await session.request({ name: "get_debug_plan", input: { sessionId: session.state.id, runId } })).run as DebugPlanRun;
  const cancel = () => session.request({ name: "cancel_debug_plan", input: { sessionId: session.state.id, runId } });
  return { session, directory, runId, start, get, cancel, counts: () => ({ reads, inputs }),
    async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await delay(5); }
  throw new Error("test state did not arrive");
}

function smallEvidenceBudget(session: DebugSession, limits: Partial<DebugSessionReport["limits"]>) {
  // Exercise the production session and writer with a small quota, without large image fixtures.
  const recording = (session as unknown as { recording: { directory: string; evidence: DebugEvidenceWriter } }).recording;
  recording.evidence = new DebugEvidenceWriter(recording.directory, session.state, limits);
}

test("plan start checks, action reads and final checks inherit one total deadline", async () => {
  const budgets: number[] = []; let inputs = 0;
  const h = harness({ observe: async (_s, _p, _m, signal) => {
    budgets.push(remainingSignalBudget(captureSignal(signal, 30_000))!);
    await delay(20);
    return { snapshot: page(inputs ? "暂停" : "播放"), target };
  }, input: async (_s, _t, _a, _f, _signal, onEvidence) => { inputs++; onEvidence?.(receipt); } });
  try {
    const step = tap(); step.input.timeoutMs = 10_000;
    const definition = plan([step]); definition.timeoutMs = 5000;
    await h.start(definition); await h.session.settled();
    const run = await h.get(); assert.equal(run.status, "passed", run.message);
    assert.equal(inputs, 1); assert.ok(budgets.length >= 5);
    assert.ok(budgets.every(value => value > 0 && value <= 5000));
    assert.ok(budgets.every((value, index) => index === 0 || value < budgets[index - 1]));
  } finally { await h.dispose(); }
});

test("a plan continues after old screenshots are evicted while its current action evidence stays complete", async () => {
  const images = await Promise.all(["red", "green", "blue", "orange", "purple", "yellow", "cyan", "magenta", "black", "white", "gray", "brown"].map(async background =>
    `data:image/png;base64,${(await sharp({ create: { width: 1080, height: 2400, channels: 3, background } }).png().toBuffer()).toString("base64")}`));
  let reads = 0, inputs = 0;
  const h = harness({ observe: async () => ({ snapshot: { ...page(inputs ? "暂停" : "播放"), screenshotDataUrl: images[reads++ % images.length] }, target }),
    input: async (_s, _t, _a, _f, _signal, onEvidence) => { inputs++; onEvidence?.(receipt); } });
  try {
    smallEvidenceBudget(h.session, { maxImages: 8 });
    for (let i = 0; i < 2; i++) await h.session.request({ name: "capture_ui", input: { sessionId: h.session.state.id, mode: "fast" } });
    await h.start(plan([tap(), tap("second")])); await h.session.settled();
    const run = await h.get(); assert.equal(run.status, "passed", run.message); assert.equal(inputs, 2);
    const report = JSON.parse(readFileSync(run.reportPath!, "utf8")) as DebugSessionReport;
    assert.ok(report.snapshots.some(item => !item.screenshot && item.warnings.some(warning => warning.includes("截图数量"))));
    assert.ok(h.session.state.steps.every(step => !step.recordingErrors?.length));
    const latestInput = report.steps.filter(item => item.step.action === "perform_ui_step").at(-1)!;
    for (const id of [latestInput.before.snapshotId, latestInput.after.snapshotId]) {
      const snapshot = report.snapshots.find(item => item.snapshotId === id)!;
      assert.ok(snapshot.tree); assert.ok(snapshot.screenshot);
    }
  } finally { await h.dispose(); }
});

test("a plan still stops before its next input when the current action evidence cannot fit", async () => {
  let inputs = 0;
  const h = harness({ observe: async () => {
    const snapshot = page(inputs ? "暂停" : "播放");
    if (inputs) snapshot.root!.attributes = { payload: "x".repeat(180000) };
    return { snapshot, target };
  }, input: async (_s, _t, _a, _f, _signal, onEvidence) => { inputs++; onEvidence?.(receipt); } });
  try {
    smallEvidenceBudget(h.session, { maxBytes: 100000 });
    await h.start(plan([tap(), tap("must-not-run")])); await h.session.settled();
    const run = await h.get(); assert.equal(run.status, "failed"); assert.equal(run.stopCode, "evidence_recording_failed");
    assert.equal(inputs, 1); assert.equal(run.steps[1].status, "pending");
    assert.ok(h.session.state.steps.at(-1)!.recordingErrors?.some(error => error.code === "evidence_capacity_exceeded"));
  } finally { await h.dispose(); }
});

test("a plan accepts once, runs in the desktop session, verifies the final page and retains product evidence", async () => {
  const h = harness();
  try {
    const caller = new AbortController();
    const first = await h.start(plan([tap(), { id: "wait", kind: "wait", condition: condition("暂停"), timeoutMs: 1000 }]), h.runId, caller.signal);
    assert.equal((first.run as DebugPlanRun).status, "running");
    assert.equal(h.session.hasPendingWork, true);
    caller.abort(); // Losing the acceptance reply must not interrupt an accepted background plan.
    await h.session.settled();
    const run = await h.get();
    assert.equal(run.status, "passed"); assert.equal(run.completedSteps, 2); assert.equal(run.currentStepId, null);
    assert.deepEqual(run.steps.map(step => step.status), ["passed", "passed"]);
    assert.equal(run.checkpointStepIds.length, 4); assert.equal(h.counts().inputs, 1);
    assert.ok(run.durationMs! > 0); assert.ok(run.steps[0].durationMs! > 0);
    const journal = JSON.parse(readFileSync(run.ledgerPath, "utf8"));
    assert.equal(journal.run.status, "passed"); assert.equal(journal.run.steps[0].requestId, run.steps[0].requestId);
    const report = await loadTestReport(run.reportPath!);
    assert.equal(report.debug!.steps.filter(record => record.step.action === "perform_ui_step").length, 1);
    const before = h.counts();
    const duplicate = await h.start(plan([tap(), { id: "wait", kind: "wait", condition: condition("暂停"), timeoutMs: 1000 }]), h.runId.toUpperCase());
    assert.equal(duplicate.replayed, true); assert.deepEqual(h.counts(), before);
    await assert.rejects(h.start({ ...plan(), title: "changed" }), /参数不同/);
  } finally { await h.dispose(); }
});

test("an accepted plan owns the gaps between steps, but permits queries and same-run replay", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ observe: async () => { await gate; return { snapshot: page("播放"), target }; } });
  try {
    await h.start();
    const state = await h.session.request({ name: "get_debug_session", input: {} });
    assert.equal(state.busy, true);
    const duplicate = await h.start(); assert.equal(duplicate.replayed, true);
    for (const raw of [
      { name: "capture_ui", input: { sessionId: h.session.state.id } },
      { name: "wait_for_ui", input: { sessionId: h.session.state.id, selector: { text: "播放" } } },
      { name: "define_debug_task", input: { sessionId: h.session.state.id, definition: { goal: "other", finalConditions: [{ id: "one", ...condition("播放") }] } } },
    ]) await assert.rejects(h.session.request(raw), /计划正在执行/);
    await assert.rejects(h.start(plan(), randomUUID()), /正在执行/);
    assert.equal(h.counts().inputs, 0);
    await h.cancel(); release(); await h.session.settled();
    assert.equal((await h.get()).status, "cancelled"); assert.equal(h.session.state.active, true);
  } finally { release(); await h.dispose(); }
});

test("a false stable when skips input while an ambiguous or unstable branch stops without guessing", async () => {
  for (const ambiguous of [false, true]) {
    const h = harness({ observe: async () => {
      const snapshot = page("播放");
      if (ambiguous) { const extra = structuredClone(snapshot.root!.children[0]); extra.id = "0/1";
        snapshot.root!.children.push(extra); snapshot.nodeCount++; snapshot.root!.text = "根页面"; }
      return { snapshot, target };
    } });
    try {
      const definition = { ...plan([{ ...tap(), when: condition(ambiguous ? "播放" : "不存在") }]),
        startConditions: [condition(ambiguous ? "不存在" : "播放")], finalConditions: [condition("播放")] };
      if (ambiguous) {
        // Use a unique stable root condition so ambiguity is specifically detected by the branch checker.
        definition.startConditions = [condition("根页面")];
      }
      await h.start(definition); await h.session.settled();
      const run = await h.get();
      assert.equal(h.counts().inputs, 0);
      if (ambiguous) { assert.equal(run.status, "failed"); assert.equal(run.stopCode, "branch_evidence_insufficient"); }
      else { assert.equal(run.status, "passed"); assert.equal(run.steps[0].status, "skipped"); }
    } finally { await h.dispose(); }
  }
});

test("an unmet start checkpoint saves its observations and sends no input", async () => {
  const h = harness();
  try {
    await h.start({ ...plan(), startConditions: [condition("wrong-page")] }); await h.session.settled();
    const run = await h.get(); assert.equal(run.status, "failed"); assert.equal(run.stopCode, "start_condition_failed");
    assert.equal(run.checkpointStepIds.length, 2); assert.equal(run.steps[0].status, "pending");
    assert.equal(h.counts().inputs, 0); assert.ok(run.reportPath);
  } finally { await h.dispose(); }
});

test("unknown dispatch stops the plan without a second input, retry or read-only resume", async () => {
  let inputs = 0;
  const h = harness({ input: async () => { inputs++; throw new Error("input result lost"); } });
  try {
    await h.start(plan([tap(), tap("second")])); await h.session.settled();
    const run = await h.get(); assert.equal(run.status, "failed"); assert.equal(run.stopCode, "dispatch_unknown");
    assert.equal(inputs, 1); assert.equal(run.steps[1].status, "pending");
    assert.equal(h.session.state.steps.some(step => step.action === "resume_ui_step"), false);
    const result = await h.session.request({ name: "get_ui_step", input: { sessionId: h.session.state.id, requestId: run.steps[0].requestId } });
    assert.equal(result.dispatchState, "unknown");
  } finally { await h.dispose(); }
});

test("cancel waits for an in-flight input to settle, keeps the grant and never advances to another step", async () => {
  let inputs = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ input: async () => { inputs++; await gate; } });
  try {
    await h.start(plan([tap(), tap("second")])); await until(() => inputs === 1);
    await h.cancel(); assert.equal(h.session.hasPendingWork, true);
    await assert.rejects(h.start(plan(), randomUUID()), /正在执行/);
    release(); await h.session.settled();
    const run = await h.get(); assert.equal(run.status, "cancelled"); assert.equal(run.stopCode, "cancelled");
    assert.equal(h.session.state.active, true); assert.equal(inputs, 1); assert.equal(run.steps[1].status, "pending");
  } finally { release(); await h.dispose(); }
});

test("session stop also joins accepted background work before the grant can be replaced", async () => {
  const h = harness();
  try {
    await h.start(); h.session.stop("test revoke"); await h.session.settled();
    const run = await h.get(); assert.equal(run.status, "cancelled"); assert.equal(run.stopCode, "session_ended");
    assert.equal(h.counts().inputs, 0); assert.equal(h.session.hasPendingWork, false);
    const duplicate = await h.start(); assert.equal(duplicate.replayed, true); assert.equal(h.counts().inputs, 0);
  } finally { await h.dispose(); }
});

test("missing durable plan state blocks subsequent input and cannot be rewritten into success", async () => {
  let inputs = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ observe: async () => ({ snapshot: page(inputs ? "暂停" : "播放"), target }),
    input: async () => { inputs++; await gate; } });
  try {
    await h.start(plan([tap(), tap("second")])); await until(() => inputs === 1);
    unlinkSync((await h.get()).ledgerPath); release(); await h.session.settled();
    const run = await h.get(); assert.equal(run.status, "interrupted"); assert.equal(run.stopCode, "plan_recording_failed");
    assert.equal(inputs, 1); assert.equal(run.steps[1].status, "pending");
  } finally { release(); await h.dispose(); }
});

test("already-aborted starts, short grants and foreign sessions cannot reserve or run a plan", async () => {
  const h = harness();
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(h.start(plan(), h.runId, controller.signal));
    assert.equal(await h.get(), undefined);
    h.session.state.expiresAt = new Date(Date.now() + 1000).toISOString();
    await assert.rejects(h.start(), /剩余时间不足/);
    await assert.rejects(h.session.request({ name: "get_debug_plan", input: { sessionId: randomUUID(), runId: h.runId } }), /不属于/);
    assert.equal(h.session.state.plan, undefined); assert.equal(h.counts().inputs, 0);
  } finally { await h.dispose(); }
});

test("the total plan deadline cancels an in-flight input without continuing or expiring the grant", async () => {
  let inputs = 0;
  const h = harness({ input: async (_s, _t, _a, _f, signal) => { inputs++; await delay(5000, undefined, { signal }); } });
  try {
    await h.start({ ...plan([tap(), tap("second")]), timeoutMs: 1000 }); await h.session.settled();
    const run = await h.get(); assert.equal(run.status, "cancelled"); assert.equal(run.stopCode, "duration_limit");
    assert.equal(inputs, 1); assert.equal(h.session.state.active, true); assert.equal(run.steps[1].status, "pending");
  } finally { await h.dispose(); }
});

test("plan waits and action expectations cannot advance on ambiguous matches or compressed absence", async () => {
  for (const kind of ["wait", "step"] as const) for (const compressed of [false, true]) {
    let inputs = 0;
    const h = harness({ observe: async () => {
      const snapshot = page("播放"); snapshot.root!.text = "页面标记";
      if (compressed) snapshot.hierarchyDumpMode = "compressed";
      else { const extra = structuredClone(snapshot.root!.children[0]); extra.id = "0/1";
        snapshot.root!.children.push(extra); snapshot.nodeCount++; }
      return { snapshot, target };
    }, input: async (_s, _t, _a, _f, _signal, onEvidence) => { inputs++; onEvidence?.(receipt); } });
    try {
      const expect = compressed ? { selector: { text: "不存在" }, state: "absent" } : condition("播放");
      const step = kind === "wait" ? { id: "strict", kind, condition: expect, timeoutMs: 1000 }
        : { id: "strict", kind, input: { action: { kind: "back" }, expect, timeoutMs: 1000 } };
      await h.start({ ...plan([step, tap("must-not-run")]), startConditions: [condition("页面标记")] });
      await h.session.settled();
      const run = await h.get(); assert.equal(run.status, "failed");
      assert.match(run.message, /证据不足/); assert.equal(run.steps[1].status, "pending");
      assert.equal(inputs, kind === "wait" ? 0 : 1);
    } finally { await h.dispose(); }
  }
});

test("a condition becoming true during a plan wait still needs two new strict confirmations", async () => {
  let reads = 0;
  const h = harness({ observe: async () => {
    const snapshot = page(++reads >= 4 ? "就绪" : "等待"); snapshot.root!.text = "页面标记";
    return { snapshot, target };
  } });
  try {
    await h.start({ ...plan([{ id: "wait", kind: "wait", condition: condition("就绪"), timeoutMs: 2000 }]),
      startConditions: [condition("页面标记")], finalConditions: [condition("就绪")] });
    await h.session.settled(); assert.equal((await h.get()).status, "passed");
    assert.equal(reads, 7); assert.equal(h.counts().inputs, 0);
  } finally { await h.dispose(); }
});

test("deleting the plan journal during tap preflight prevents that input", async () => {
  let reads = 0, inputs = 0;
  const h = harness({ observe: async () => {
    if (++reads === 3) unlinkSync(h.session.state.plan!.ledgerPath);
    return { snapshot: page("播放"), target };
  }, input: async () => { inputs++; } });
  try {
    await h.start(); await h.session.settled();
    assert.equal((await h.get()).status, "interrupted"); assert.equal(inputs, 0);
    assert.equal(h.session.state.steps.at(-1)!.dispatchState, "not_sent");
  } finally { await h.dispose(); }
});

test("plan journal loss after the first continuous-scroll gesture blocks its next gesture", async () => {
  let inputs = 0;
  const h = harness({ observe: async () => {
    const snapshot = page(`row-${inputs}`), list = snapshot.root!.children[0];
    snapshot.root!.text = "列表页面";
    Object.assign(list, { resourceId: "list", className: "androidx.recyclerview.widget.RecyclerView", clickable: false, scrollable: true,
      bounds: { left: 20, top: 200, right: 1060, bottom: 1900, raw: "" } });
    const row = structuredClone(list);
    Object.assign(row, { id: "0/0/0", resourceId: null, clickable: false, scrollable: false, children: [],
      bounds: { left: 40, top: 300, right: 1000, bottom: 400, raw: "" } });
    list.children = [row]; snapshot.nodeCount = 3;
    return { snapshot, target };
  }, input: async (_s, _t, _a, _f, _signal, onEvidence) => {
    inputs++; onEvidence?.(receipt); if (inputs === 1) unlinkSync(h.session.state.plan!.ledgerPath);
  } });
  try {
    await h.start({ ...plan([{ id: "scroll", kind: "scroll-until", input: {
      target: { selector: { resourceId: "list" } }, direction: "down", until: { selector: { text: "END" }, kind: "end_marker" }, maxScrolls: 4,
    } }]), startConditions: [condition("列表页面")] });
    await h.session.settled(); const run = await h.get();
    assert.equal(run.status, "interrupted"); assert.equal(inputs, 1);
    const trace = h.session.state.steps.at(-1)!.scrollTask!;
    assert.equal(trace.iterations.filter(item => item.dispatchState === "sent").length, 1);
    assert.equal(trace.iterations.at(-1)!.dispatchState, "not_sent");
  } finally { await h.dispose(); }
});
