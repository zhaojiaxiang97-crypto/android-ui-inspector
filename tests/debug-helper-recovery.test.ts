import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { DebugSession } from "../electron/automation/debug-session";
import { HelperCaptureError } from "../electron/capture/accessibility-helper";
import { DebugInputError } from "../electron/device/debug-input";
import { ObservationRecoveryBudget, ObservationRecoveryTimeoutError } from "../electron/automation/debug-observation-recovery";
import { DebugStepExecutor } from "../electron/automation/debug-step-executor";
import { DebugObservationError } from "../electron/automation/debug-observation-error";
import { debugStepFailure, type StepContext } from "../electron/automation/debug-step-context";
import { loadTestReport } from "../electron/desktop/test-report";
import { parseUiHierarchy } from "../electron/capture/xml-tree";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";
import type { UiSnapshot, DebugInputEvidence } from "../shared/types";
import type { DebugSessionReport } from "../shared/debug-report";
import type { HelperObservationDiagnostics } from "../shared/helper-observation-diagnostics";

const packageName = "com.example.helper", serial = "helper-fixture";
const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "adb-window", activityRecordId: "activity-1" };
const receipt: DebugInputEvidence = { classification: "accepted", spawned: true, closed: true, exitCode: 0, signal: null,
  durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
const diagnostics: HelperObservationDiagnostics = { version: 1, reasons: [{ code: "child_unavailable", count: 1 }] };
const image = sharp({ create: { width: 400, height: 800, channels: 4, background: "black" } }).png().toBuffer()
  .then(bytes => `data:image/png;base64,${bytes.toString("base64")}`);

function incomplete(snapshot: UiSnapshot, reasons = diagnostics, mutate?: (metadata: Record<string, any>) => void) {
  const metadata = { ...structuredClone(snapshot.helperObservation!), complete: false as const, diagnostics: reasons };
  mutate?.(metadata);
  return new HelperCaptureError("helper-incomplete", "Helper 观察不完整。", { diagnostics: reasons, recoveryEvidence: metadata });
}

function harness(options: { list?: boolean; uncertain?: boolean;
  read?: (snapshot: UiSnapshot, reads: number, signal: AbortSignal) => void | Promise<void>; cancelOnRetry?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "helper-recovery-"));
  let reads = 0, inputs = 0;
  const session = new DebugSession({ serial, packageName, directory, snapshotPath: join(directory, "current.json"),
    onEvent: event => { if (options.cancelOnRetry && event.state.steps.at(-1)?.message.includes("正在重新观察")) session.stop(); },
    observe: async (_s, _p, _m, signal) => {
      const page = helperEvidenceSnapshot({ startedAt: ++reads * 100, width: 400, height: 800, text: inputs ? "END" : "START" });
      page.screenshotDataUrl = await image;
      if (options.list) {
        const child = page.rawXml!.replace(/^.*?<hierarchy[^>]*>/s, "").replace(/<\/hierarchy>$/, "")
          .replace(/\[0,0\]\[400,800\]/g, "[20,100][380,160]").replace('clickable="true"', 'clickable="false"');
        const root = `<hierarchy rotation="0"><node index="0" class="android.widget.ScrollView" package="${packageName}" text=""
          resource-id="list" content-desc="" bounds="[0,0][400,800]" bounds-screen="[0,0][400,800]" visible-bounds="[0,0][400,800]"
          window-id="7" visible-to-user="true" enabled="true" clickable="false" focusable="true" focused="false" scrollable="true" selected="false">${child}</node></hierarchy>`;
        Object.assign(page, { rawXml: root, root: parseUiHierarchy(root).root, nodeCount: 2, xmlSize: Buffer.byteLength(root) });
      }
      await options.read?.(page, reads, signal!);
      return { snapshot: page, target };
    }, input: async (_s, _t, _a, _f, _signal, onEvidence) => {
      inputs++;
      if (options.uncertain) throw new DebugInputError({ ...receipt, classification: "timeout", exitCode: null, signal: "SIGTERM" });
      onEvidence?.(receipt);
    } });
  const requestId = randomUUID();
  const input = { sessionId: session.state.id, requestId, backend: "accessibility-helper", action: { kind: "tap" },
    target: { selector: { resourceId: `${packageName}:id/result` } }, expect: { selector: { text: "END" } }, timeoutMs: 5000 };
  return { session, directory, requestId, input, counts: () => ({ reads, inputs }),
    step: (overrides: Record<string, unknown> = {}) => session.request({ name: "perform_ui_step", input: { ...input, ...overrides } }),
    report: () => JSON.parse(readFileSync(session.state.reportPath!, "utf8")) as DebugSessionReport,
    async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}

test("Helper retries two known incomplete reads without repeating input and persists successful recovery", async () => {
  const h = harness({ read: (snapshot, reads) => { if (reads === 2 || reads === 3) throw incomplete(snapshot); } });
  try {
    const result = await h.step();
    assert.equal(result.verified, true, String(result.message)); assert.deepEqual(h.counts(), { reads: 5, inputs: 1 });
    const step = h.report().steps.at(-1)!.step;
    assert.equal(step.observationFailures?.length, 2); assert.equal(step.error, undefined);
    assert.ok(step.observationFailures!.every(item => item.willRetry && item.error.code === "helper-incomplete"));
    assert.deepEqual(step.observationFailures![0].error.helperDiagnostics, diagnostics);
    const loaded = await loadTestReport(h.session.state.reportPath!);
    assert.deepEqual(loaded.debug!.steps.at(-1)!.step.observationFailures, step.observationFailures);
    assert.equal((await h.step()).replayed, true); assert.equal(h.counts().inputs, 1);
  } finally { await h.dispose(); }
});

test("recovery allowance is shared across post-action and expectation reads", async () => {
  const h = harness({ read: (snapshot, reads) => { if ([2, 4, 6].includes(reads)) throw incomplete(snapshot); } });
  try {
    const result = await h.step();
    assert.equal(result.isError, true); assert.equal(result.dispatchState, "sent");
    assert.deepEqual(h.counts(), { reads: 6, inputs: 1 });
    const step = h.report().steps.at(-1)!.step;
    assert.deepEqual(step.observationFailures!.map(item => item.willRetry), [true, true, false]);
    assert.equal(step.error!.code, "helper-incomplete"); assert.deepEqual(step.error!.helperDiagnostics, diagnostics);
  } finally { await h.dispose(); }
});

test("Helper verification restarts the two-frame requirement after a failed read", async () => {
  const h = harness({ read: (snapshot, reads) => { if (reads === 3) throw incomplete(snapshot); } });
  try { const result = await h.step(); assert.equal(result.verified, true); assert.deepEqual(h.counts(), { reads: 5, inputs: 1 }); }
  finally { await h.dispose(); }
});

test("scroll end confirmation restarts after recovery without adding a gesture", async () => {
  const h = harness({ list: true, read: (snapshot, reads) => { if (reads === 3) throw incomplete(snapshot); } });
  try {
    const result = await h.session.request({ name: "scroll_until", input: { sessionId: h.session.state.id, requestId: h.requestId,
      backend: "accessibility-helper", target: { selector: { resourceId: "list" } }, direction: "down", maxScrolls: 2,
      until: { kind: "end_marker", selector: { text: "END" } }, timeoutMs: 5000 } });
    assert.equal(result.verified, true, String(result.message)); assert.deepEqual(h.counts(), { reads: 5, inputs: 1 });
    assert.equal(h.report().steps.at(-1)!.step.scrollTask!.iterations.length, 1);
  } finally { await h.dispose(); }
});

test("unclassified, old, malformed or foreign Helper failures never recover", async () => {
  const errors = [
    (_s: UiSnapshot) => new HelperCaptureError("helper-incomplete", "旧版本"),
    (_s: UiSnapshot) => new HelperCaptureError("helper-truncated", "截断", { diagnostics }),
    (s: UiSnapshot) => incomplete(s, { version: 1, reasons: [{ code: "node_read_failed", count: 1 }] }),
    (s: UiSnapshot) => incomplete(s, diagnostics, m => { m.serviceInstanceId = randomUUID(); }),
    (s: UiSnapshot) => incomplete(s, diagnostics, m => { m.packageName = "com.foreign"; }),
    (s: UiSnapshot) => incomplete(s, diagnostics, m => { m.displayAfter.rotation = 1; }),
    (s: UiSnapshot) => incomplete(s, diagnostics, m => { m.timing.startedAtMs = 1; }),
    (s: UiSnapshot) => incomplete(s, diagnostics, m => { m.windowsAfter[0].type = "unknown"; }),
  ];
  for (const fail of errors) {
    const h = harness({ read: (snapshot, reads) => { if (reads === 2) throw fail(snapshot); } });
    try { const r = await h.step(); assert.equal(r.isError, true); assert.deepEqual(h.counts(), { reads: 2, inputs: 1 }); }
    finally { await h.dispose(); }
  }
});

test("failed capture identity cannot be replayed by the next success or failure", async () => {
  for (const nextFails of [true, false]) {
    let captureId = "";
    const h = harness({ read: (snapshot, reads) => {
      if (reads === 2) { captureId = snapshot.helperObservation!.captureId; throw incomplete(snapshot); }
      if (reads === 3) { snapshot.helperObservation!.captureId = captureId; if (nextFails) throw incomplete(snapshot); }
    } });
    try { assert.equal((await h.step()).isError, true); assert.deepEqual(h.counts(), { reads: 3, inputs: 1 }); }
    finally { await h.dispose(); }
  }
});

test("failure before input, uncertain dispatch and cancellation cannot replay input", async () => {
  const before = harness({ read: (snapshot) => { throw incomplete(snapshot); } });
  try { assert.equal((await before.step()).dispatchState, "not_sent"); assert.deepEqual(before.counts(), { reads: 1, inputs: 0 }); }
  finally { await before.dispose(); }
  const unknown = harness({ uncertain: true });
  try {
    assert.equal((await unknown.step()).dispatchState, "unknown"); assert.deepEqual(unknown.counts(), { reads: 1, inputs: 1 });
    const recovered = await unknown.session.request({ name: "resume_ui_step", input: { sessionId: unknown.session.state.id,
      requestId: unknown.requestId, timeoutMs: 5000 } });
    assert.equal(recovered.verified, true); assert.equal(recovered.dispatchState, "unknown"); assert.equal(unknown.counts().inputs, 1);
  } finally { await unknown.dispose(); }
  const cancelled = harness({ cancelOnRetry: true, read: (snapshot, reads) => { if (reads === 2) throw incomplete(snapshot); } });
  try {
    const result = await cancelled.step(); assert.equal(result.isError, true); assert.deepEqual(cancelled.counts(), { reads: 2, inputs: 1 });
    assert.deepEqual(cancelled.report().steps.at(-1)!.step.error!.helperDiagnostics, diagnostics);
  } finally { await cancelled.dispose(); }
});

test("step timeout interrupts a pending recovery read and retains its diagnostic", async () => {
  const h = harness({ read: async (snapshot, reads, signal) => {
    if (reads === 2) throw incomplete(snapshot);
    if (reads === 3) await new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  } });
  try {
    const result = await h.step({ timeoutMs: 1000 }); assert.equal(result.isError, true);
    assert.deepEqual(h.counts(), { reads: 3, inputs: 1 });
    const error = h.report().steps.at(-1)!.step.error!; assert.equal(error.code, "timeout"); assert.deepEqual(error.helperDiagnostics, diagnostics);
  } finally { await h.dispose(); }
});

test("recovery budget limits both extra reads and total elapsed time without resetting", () => {
  let time = 0; const budget = new ObservationRecoveryBudget(() => time);
  assert.equal(budget.reserveRetry(), true); time = 14_999; assert.equal(budget.remainingMs, 1);
  assert.equal(budget.reserveRetry(), true); assert.equal(budget.remainingMs, 1);
  assert.equal(budget.reserveRetry(), false); time = 15_000; assert.equal(budget.remainingMs, 0);
  time = 0; const expired = new ObservationRecoveryBudget(() => time); assert.equal(expired.reserveRetry(), true);
  time = 15_001; assert.equal(expired.reserveRetry(), false);
});

test("expired shared budget blocks the next verification read and confirmation delay", async () => {
  let now = 0, reads = 0;
  const budget = new ObservationRecoveryBudget(() => now); budget.reserveRetry(); now = 15_001;
  const context = { phase: "capture", started: performance.now(), step: { action: "perform_ui_step", dispatchState: "sent" } };
  const executor: any = new DebugStepExecutor({} as any, { events: { phase() {}, emit() {} } } as any);
  executor.recoveryBudgets.set(context, budget);
  executor.capture = async () => { reads++; return { snapshot: { inspectionSource: "uiautomator" } }; };
  executor.acceptActionObservation = () => ({ entry: { id: "must-not-publish" } });
  await assert.rejects(() => executor.observeAfterInput(new AbortController().signal, context, "uiautomator", "verification"), ObservationRecoveryTimeoutError);
  await assert.rejects(() => executor.waitForObservation(350, new AbortController().signal, context), ObservationRecoveryTimeoutError);
  assert.equal(reads, 0);
});

test("timeout and cancellation retain the latest known diagnostic across another error kind", () => {
  const context = { phase: "capture", step: { observationFailures: [
    { error: { helperDiagnostics: diagnostics } }, { error: { code: "window_changed" } },
  ] } } as unknown as StepContext;
  for (const [timedOut, cancelled] of [[true, false], [false, true]]) {
    const failure = debugStepFailure(new DebugObservationError("window_changed", "切换中"), context, timedOut, cancelled);
    assert.equal(failure.category, timedOut ? "timeout" : "cancelled"); assert.deepEqual(failure.helperDiagnostics, diagnostics);
  }
});

test("scroll stops when an incomplete read proves the focused window changed", async () => {
  const h = harness({ list: true, read: (snapshot, reads) => {
    if (reads === 2) throw incomplete(snapshot, { version: 1, reasons: [{ code: "window_inventory_changed", count: 1 }] },
      metadata => { metadata.windowsAfter[0].id = "8"; });
  } });
  try {
    const result = await h.session.request({ name: "scroll_until", input: { sessionId: h.session.state.id, requestId: h.requestId,
      backend: "accessibility-helper", target: { selector: { resourceId: "list" } }, direction: "down", maxScrolls: 2,
      until: { kind: "end_marker", selector: { text: "END" } }, timeoutMs: 5000 } });
    assert.equal(result.isError, true); assert.deepEqual(h.counts(), { reads: 2, inputs: 1 });
    assert.equal(h.report().steps.at(-1)!.step.observationFailures![0].willRetry, false);
  } finally { await h.dispose(); }
});

test("report import rejects unknown diagnostic data and oversized recovery histories", async () => {
  const h = harness({ read: (snapshot, reads) => { if (reads >= 2) throw incomplete(snapshot); } });
  try {
    await h.step(); const original = h.report();
    const loaded = await loadTestReport(h.session.state.reportPath!);
    assert.deepEqual(loaded.index.cases[0].attempts[0].steps[0].error?.helperDiagnostics, diagnostics);
    for (const mutate of [
      (r: DebugSessionReport) => { (r.steps[0].step.error!.helperDiagnostics as any).text = "private page text"; },
      (r: DebugSessionReport) => { (r.steps[0].step.error!.helperDiagnostics!.reasons[0] as any).code = "unknown_reason"; },
      (r: DebugSessionReport) => { r.steps[0].step.observationFailures!.push(r.steps[0].step.observationFailures![0]); },
    ]) {
      const changed = structuredClone(original); mutate(changed); writeFileSync(h.session.state.reportPath!, JSON.stringify(changed));
      await assert.rejects(() => loadTestReport(h.session.state.reportPath!));
    }
  } finally { await h.dispose(); }
});
