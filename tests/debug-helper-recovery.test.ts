import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { exportDebugReportEvidence } from "../electron/desktop/debug-report-export";
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
const transitionDiagnostics: HelperObservationDiagnostics = { version: 1, reasons: [
  { code: "window_inventory_changed", count: 1 }, { code: "focus_invalid", count: 1 }] };
const transition = (snapshot: UiSnapshot) => incomplete(snapshot, transitionDiagnostics, metadata => {
  metadata.windowsAfter[0].id = "8"; metadata.windowsAfter[0].focused = false;
});
const systemGap = (snapshot: UiSnapshot) => incomplete(snapshot, { version: 1, reasons: [{ code: "focus_invalid", count: 1 }] }, metadata => {
  metadata.packageName = ""; metadata.windowId = "";
  metadata.windowsBefore = [{ ...metadata.windowsBefore[0], id: "91", type: "system", packageName: "com.android.systemui", active: false, focused: false }];
  metadata.windowsAfter = structuredClone(metadata.windowsBefore);
});
const windowMotion = (snapshot: UiSnapshot) => incomplete(snapshot, { version: 1, reasons: [{ code: "window_inventory_changed", count: 1 }] }, metadata => {
  metadata.windowsBefore[0].bounds.x = -80; metadata.windowsAfter[0].bounds.x = -20;
  metadata.windowsBefore[0].bounds.width = metadata.windowsAfter[0].bounds.width = 399;
});
const fullscreenExpansion = (snapshot: UiSnapshot) => incomplete(snapshot, { version: 1, reasons: [{ code: "window_inventory_changed", count: 1 }] }, metadata => {
  metadata.windowsBefore[0].bounds = { x: 112, y: 194, width: 320, height: 603 };
  metadata.windowsAfter[0].bounds = { x: 0, y: 0, width: 400, height: 800 };
});

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
    assert.ok(step.observationFailures!.every(item => item.error.helperRecoveryDiagnostics?.executor === "retry"));
    assert.deepEqual(step.observationFailures![0].error.helperDiagnostics, diagnostics);
    const loaded = await loadTestReport(h.session.state.reportPath!);
    assert.deepEqual(loaded.debug!.steps.at(-1)!.step.observationFailures, step.observationFailures);
    assert.equal((await h.step()).replayed, true); assert.equal(h.counts().inputs, 1);
  } finally { await h.dispose(); }
});

test("the real navigation failure pair recovers two fresh complete child-window frames after one input", async () => {
  const h = harness({ read: (snapshot, reads) => {
    if (reads === 2 || reads === 3) throw transition(snapshot);
    if (reads >= 4) {
      const xml = snapshot.rawXml!.replace(/window-id="7"/g, 'window-id="8"');
      snapshot.rawXml = xml; snapshot.root = parseUiHierarchy(xml).root; snapshot.xmlSize = Buffer.byteLength(xml);
      const evidence = snapshot.helperObservation!; evidence.windowId = "8";
      for (const windows of [evidence.windowsBefore, evidence.windowsAfter]) windows[0].id = "8";
    }
  } });
  try {
    const result = await h.step();
    assert.equal(result.verified, true, String(result.message)); assert.deepEqual(h.counts(), { reads: 5, inputs: 1 });
    const step = h.report().steps.at(-1)!.step;
    assert.deepEqual(step.observationFailures!.map(item => item.willRetry), [true, true]);
    assert.ok(step.observationFailures!.every(item => JSON.stringify(item.error.helperDiagnostics) === JSON.stringify(transitionDiagnostics)));
    await loadTestReport(h.session.state.reportPath!);
    assert.equal((await h.step()).replayed, true); assert.equal(h.counts().inputs, 1);
  } finally { await h.dispose(); }
});

test("sent Back recovers two real system-only gaps using two new complete authorized frames without another input", async () => {
  const h = harness({ read: (snapshot, reads) => { if (reads === 2 || reads === 3) throw systemGap(snapshot); } });
  try {
    const result = await h.step({ action: { kind: "back" }, target: undefined });
    assert.equal(result.verified, true, String(result.message)); assert.deepEqual(h.counts(), { reads: 5, inputs: 1 });
    assert.deepEqual(h.report().steps.at(-1)!.step.observationFailures!.map(item => item.willRetry), [true, true]);
    await loadTestReport(h.session.state.reportPath!);
    assert.equal((await h.step({ action: { kind: "back" }, target: undefined })).replayed, true); assert.equal(h.counts().inputs, 1);
  } finally { await h.dispose(); }
});

test("sent tap and Back tolerate horizontal motion or final full-display expansion then require two fresh complete frames", async () => {
  for (const fail of [windowMotion, fullscreenExpansion]) {
  for (const kind of ["tap", "back"] as const) {
    const h = harness({ read: (snapshot, reads) => { if (reads === 2 || reads === 3) throw fail(snapshot); } });
    try {
      const result = await h.step(kind === "back" ? { action: { kind }, target: undefined } : {});
      assert.equal(result.verified, true, String(result.message)); assert.deepEqual(h.counts(), { reads: 5, inputs: 1 });
      assert.deepEqual(h.report().steps.at(-1)!.step.observationFailures!.map(item => item.willRetry), [true, true]);
      await loadTestReport(h.session.state.reportPath!);
      assert.equal((await h.step(kind === "back" ? { action: { kind }, target: undefined } : {})).replayed, true);
      assert.equal(h.counts().inputs, 1);
    } finally { await h.dispose(); }
  }
  }
});

test("focus transition recovery does not loosen pre-input, verification, scroll or cancellation boundaries", async () => {
  for (const fail of [transition, systemGap, windowMotion, fullscreenExpansion]) {
  for (const scenario of ["before", "verification", "scroll", "single-scroll", "cancel", "exhausted"] as const) {
    const h = harness({ list: scenario === "scroll" || scenario === "single-scroll", cancelOnRetry: scenario === "cancel", read: (snapshot, reads) => {
      if (reads === (scenario === "before" ? 1 : scenario === "verification" ? 3 : 2)
        || scenario === "exhausted" && reads >= 2) throw fail(snapshot);
    } });
    try {
      const result = scenario === "scroll" ? await h.session.request({ name: "scroll_until", input: { sessionId: h.session.state.id,
        requestId: h.requestId, backend: "accessibility-helper", target: { selector: { resourceId: "list" } }, direction: "down",
        maxScrolls: 2, until: { kind: "end_marker", selector: { text: "END" } }, timeoutMs: 5000 } })
        : scenario === "single-scroll" ? await h.step({ action: { kind: "scroll", direction: "down" }, target: { selector: { resourceId: "list" } } })
          : await h.step();
      assert.equal(result.isError, true); assert.equal(h.counts().inputs, scenario === "before" ? 0 : 1);
      assert.equal(h.counts().reads, scenario === "before" ? 1 : scenario === "verification" ? 3 : scenario === "exhausted" ? 4 : 2);
      if (scenario === "exhausted") assert.deepEqual(h.report().steps.at(-1)!.step.observationFailures!.map(item => item.willRetry), [true, true, false]);
      if (scenario === "exhausted") assert.equal(h.report().steps.at(-1)!.step.error?.helperRecoveryDiagnostics?.executor, "budget_exhausted");
      if (["verification", "scroll", "single-scroll"].includes(scenario))
        assert.equal(h.report().steps.at(-1)!.step.error?.helperRecoveryDiagnostics?.executor,
          scenario === "scroll" && (fail === transition || fail === systemGap) ? "scroll_scope_changed" : "navigation_only");
    } finally { await h.dispose(); }
  }
  }
});

test("standalone wait does not gain system-only gap retries", async () => {
  for (const fail of [systemGap, windowMotion, fullscreenExpansion]) {
  const h = harness({ read: (snapshot, reads) => { if (reads === 2) throw fail(snapshot); } });
  try {
    await h.session.request({ name: "capture_ui", input: { sessionId: h.session.state.id, mode: "fast", backend: "accessibility-helper" } });
    const result = await h.session.request({ name: "wait_for_ui", input: { sessionId: h.session.state.id, selector: { text: "END" }, timeoutMs: 5000 } });
    assert.equal(result.isError, true); assert.deepEqual(h.counts(), { reads: 2, inputs: 0 });
  } finally { await h.dispose(); }
  }
});

test("standalone Helper waits retry stable missing children and restart both partial confirmation frames", async () => {
  for (const failures of [[2], [2, 3], [3]]) {
    const captures = new Map<number, string>();
    const h = harness({ read: (snapshot, reads) => {
      captures.set(reads, snapshot.helperObservation!.captureId);
      if (failures.includes(reads)) throw incomplete(snapshot);
    } });
    try {
      await h.session.request({ name: "capture_ui", input: { sessionId: h.session.state.id, mode: "fast", backend: "accessibility-helper" } });
      const result = await h.session.request({ name: "wait_for_ui", input: { sessionId: h.session.state.id,
        selector: { text: "START" }, visibility: "partial", timeoutMs: 5000 } });
      assert.equal(result.verified, true, String(result.message));
      const lastFailure = failures.at(-1)!, expectedReads = lastFailure + 2;
      assert.deepEqual(h.counts(), { reads: expectedReads, inputs: 0 });
      const loaded = await loadTestReport(h.session.state.reportPath!), step = loaded.debug!.steps.at(-1)!.step;
      assert.equal(loaded.debug!.steps.at(-1)!.verified, true);
      assert.equal(step.observationFailures!.length, failures.length);
      assert.ok(step.observationFailures!.every(item => item.willRetry && item.error.helperRecoveryDiagnostics?.executor === "retry"));
      const proof = step.assertionConfirmation!;
      for (const [index, observation] of [proof.first, proof.second].entries()) {
        const saved = loaded.debug!.snapshots.find(item => item.evidence.snapshotId === observation.snapshotId)!;
        assert.equal(saved.snapshot!.helperObservation!.captureId, captures.get(lastFailure + index + 1));
      }
      for (const rejected of failures) assert.ok(!loaded.debug!.snapshots.some(item => item.snapshot?.helperObservation?.captureId === captures.get(rejected)),
        "a failed read never becomes a saved snapshot");
    } finally { await h.dispose(); }
  }
});

test("read-only child recovery rejects changed trusted inventory, source, capture and additional failure reasons", async () => {
  let trustedCapture = "";
  const changes: Array<[string, (metadata: Record<string, any>) => void, HelperObservationDiagnostics?]> = [
    ["service", e => { e.serviceInstanceId = randomUUID(); }],
    ["capture", e => { e.captureId = trustedCapture; }],
    ["old capture time", e => { e.timing = helperEvidenceSnapshot({ startedAt: 1 }).helperObservation!.timing; }],
    ["display", e => { e.displayBefore.rotation = e.displayAfter.rotation = 1; }],
    ["package", e => { e.packageName = "com.foreign.app"; for (const list of [e.windowsBefore, e.windowsAfter]) list[0].packageName = e.packageName; }],
    ["stable new window", e => { e.windowId = "8"; for (const list of [e.windowsBefore, e.windowsAfter]) list[0].id = "8"; }],
    ["stable new geometry", e => { for (const list of [e.windowsBefore, e.windowsAfter]) list[0].bounds.width = 399; }],
    ["stable new layer", e => { for (const list of [e.windowsBefore, e.windowsAfter]) list[0].layer = 3; }],
    ["stable new system window", e => { for (const list of [e.windowsBefore, e.windowsAfter]) list.push({ ...list[0],
      id: "9", type: "system", packageName: "com.android.systemui", focused: false, active: false, layer: 0 }); }],
    ["focus changed", e => { e.windowsAfter[0].focused = false; }],
    ["inventory reason", e => { e.windowsAfter[0].id = "8"; }, { version: 1, reasons: [
      { code: "child_unavailable", count: 1 }, { code: "window_inventory_changed", count: 1 }] }],
    ["other reason", () => {}, { version: 1, reasons: [{ code: "node_read_failed", count: 1 }] }],
  ];
  for (const [label, change, reasons] of changes) {
    const h = harness({ read: (snapshot, reads) => {
      if (reads === 1) trustedCapture = snapshot.helperObservation!.captureId;
      if (reads === 2) throw incomplete(snapshot, reasons ?? diagnostics, change);
    } });
    try {
      await h.session.request({ name: "capture_ui", input: { sessionId: h.session.state.id, mode: "fast", backend: "accessibility-helper" } });
      const result = await h.session.request({ name: "wait_for_ui", input: { sessionId: h.session.state.id,
        selector: { text: "START" }, visibility: "partial", timeoutMs: 5000 } });
      assert.equal(result.isError, true, label); assert.deepEqual(h.counts(), { reads: 2, inputs: 0 }, label);
      assert.equal(h.report().steps.at(-1)!.step.observationFailures![0].willRetry, false, label);
    } finally { await h.dispose(); }
  }
});

test("a new complete frame after read-only child failure cannot change the trusted window or geometry", async () => {
  for (const change of ["window", "geometry", "service", "capture"] as const) {
    let failedCapture = "";
    const h = harness({ read: (snapshot, reads) => {
      if (reads === 2) { failedCapture = snapshot.helperObservation!.captureId; throw incomplete(snapshot); }
      if (reads === 3) {
        const e = snapshot.helperObservation!;
        if (change === "service") e.serviceInstanceId = randomUUID();
        else if (change === "capture") e.captureId = failedCapture;
        else if (change === "geometry") for (const list of [e.windowsBefore, e.windowsAfter]) list[0].bounds.width = 399;
        else {
          e.windowId = "8"; for (const list of [e.windowsBefore, e.windowsAfter]) list[0].id = "8";
          snapshot.rawXml = snapshot.rawXml!.replace(/window-id="7"/g, 'window-id="8"');
          snapshot.root = parseUiHierarchy(snapshot.rawXml).root; snapshot.xmlSize = Buffer.byteLength(snapshot.rawXml);
        }
      }
    } });
    try {
      await h.session.request({ name: "capture_ui", input: { sessionId: h.session.state.id, mode: "fast", backend: "accessibility-helper" } });
      const result = await h.session.request({ name: "wait_for_ui", input: { sessionId: h.session.state.id,
        selector: { text: "START" }, visibility: "partial", timeoutMs: 5000 } });
      assert.equal(result.isError, true, change); assert.deepEqual(h.counts(), { reads: 3, inputs: 0 }, change);
      assert.equal(h.report().steps.at(-1)!.step.assertionConfirmation, undefined, change);
    } finally { await h.dispose(); }
  }
});

test("child-only read retries do not extend capture, pre-input scrolling or waits without a current trusted frame", async () => {
  for (const scenario of ["capture", "scroll", "unknown input", "no trusted source"] as const) {
    const h = harness({ list: scenario === "scroll", uncertain: scenario === "unknown input", read: (snapshot, reads) => {
      if (reads === (scenario === "no trusted source" ? 1 : 2)) throw incomplete(snapshot);
    } });
    try {
      if (scenario === "unknown input") assert.equal((await h.step()).dispatchState, "unknown");
      else if (scenario !== "no trusted source") await h.session.request({ name: "capture_ui",
        input: { sessionId: h.session.state.id, mode: "fast", backend: "accessibility-helper" } });
      const result = scenario === "capture" ? await h.session.request({ name: "capture_ui",
        input: { sessionId: h.session.state.id, mode: "fast", backend: "accessibility-helper" } })
        : scenario === "scroll" ? await h.session.request({ name: "scroll_until", input: { sessionId: h.session.state.id,
          requestId: randomUUID(), backend: "accessibility-helper", target: { selector: { resourceId: "list" } },
          direction: "down", until: { kind: "end_marker", selector: { text: "START" } }, timeoutMs: 5000 } })
        : await h.session.request({ name: "wait_for_ui", input: { sessionId: h.session.state.id,
          selector: { text: "START" }, timeoutMs: 5000 } });
      assert.equal(result.isError, true, scenario);
      assert.deepEqual(h.counts(), { reads: scenario === "no trusted source" ? 1 : 2, inputs: scenario === "unknown input" ? 1 : 0 }, scenario);
    } finally { await h.dispose(); }
  }
});

test("standalone child recovery shares the two-read limit and respects cancellation and the wait deadline", async () => {
  for (const scenario of ["exhausted", "cancel", "timeout"] as const) {
    const h = harness({ cancelOnRetry: scenario === "cancel", read: async (snapshot, reads, signal) => {
      if (reads >= 2 && (scenario !== "timeout" || reads === 2)) throw incomplete(snapshot);
      if (scenario === "timeout" && reads === 3) await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    } });
    try {
      await h.session.request({ name: "capture_ui", input: { sessionId: h.session.state.id, mode: "fast", backend: "accessibility-helper" } });
      const result = await h.session.request({ name: "wait_for_ui", input: { sessionId: h.session.state.id,
        selector: { text: "START" }, visibility: "partial", timeoutMs: scenario === "timeout" ? 1000 : 5000 } });
      assert.equal(result.isError, true, scenario);
      assert.deepEqual(h.counts(), { reads: scenario === "exhausted" ? 4 : scenario === "timeout" ? 3 : 2, inputs: 0 }, scenario);
      const step = h.report().steps.at(-1)!.step;
      assert.equal(step.assertionConfirmation, undefined, scenario);
      if (scenario === "exhausted") {
        assert.deepEqual(step.observationFailures!.map(item => item.willRetry), [true, true, false]);
        assert.equal(step.observationFailures!.at(-1)!.error.helperRecoveryDiagnostics?.executor, "budget_exhausted");
      }
      if (scenario === "timeout") assert.equal(step.error!.code, "timeout");
      if (scenario === "cancel") assert.equal(step.error!.code, "cancelled");
    } finally { await h.dispose(); }
  }
});

test("a newer frame after a system-only gap cannot replace the authorized App or Helper service", async () => {
  for (const change of ["package", "service"] as const) {
    const h = harness({ read: (snapshot, reads) => {
      if (reads === 2) throw systemGap(snapshot);
      if (reads === 3) {
        if (change === "service") snapshot.helperObservation!.serviceInstanceId = randomUUID();
        else snapshot.helperObservation!.packageName = "com.foreign.app";
      }
    } });
    try { assert.equal((await h.step()).isError, true); assert.deepEqual(h.counts(), { reads: 3, inputs: 1 }); }
    finally { await h.dispose(); }
  }
});

test("read-only resume uses the original tap or back action and does not extend swipe recovery", async () => {
  for (const fail of [transition, windowMotion, fullscreenExpansion]) {
  for (const kind of ["tap", "back", "scroll"] as const) {
    const h = harness({ list: kind === "scroll", read: (snapshot, reads) => {
      if (reads === 2) throw new HelperCaptureError("helper-incomplete", "Unclassified first failure");
      if (reads === 3) throw fail(snapshot);
    } });
    try {
      const first = await h.step(kind === "tap" ? {} : kind === "back" ? { action: { kind }, target: undefined }
        : { action: { kind, direction: "down" }, target: { selector: { resourceId: "list" } } });
      assert.equal(first.isError, true); assert.equal(first.dispatchState, "sent");
      const result = await h.session.request({ name: "resume_ui_step", input: { sessionId: h.session.state.id, requestId: h.requestId, timeoutMs: 5000 } });
      assert.equal(result.verified, kind !== "scroll", String(result.message));
      assert.deepEqual(h.counts(), { reads: kind === "scroll" ? 3 : 5, inputs: 1 });
    } finally { await h.dispose(); }
  }
  }
});

test("full-display expansion never recovers changed source, replayed capture or pre-input capture time", async () => {
  for (const changed of ["service", "capture", "time"] as const) {
    let first: UiSnapshot["helperObservation"];
    const h = harness({ read: (snapshot, reads) => {
      if (reads === 1) first = snapshot.helperObservation;
      if (reads === 2) {
        if (changed === "service") snapshot.helperObservation!.serviceInstanceId = randomUUID();
        else if (changed === "capture") snapshot.helperObservation!.captureId = first!.captureId;
        else snapshot.helperObservation!.timing = first!.timing;
        throw fullscreenExpansion(snapshot);
      }
    } });
    try {
      const result = await h.step(); assert.equal(result.isError, true); assert.deepEqual(h.counts(), { reads: 2, inputs: 1 });
      const error = h.report().steps[0].step.error!;
      assert.equal(error.helperRecoveryDiagnostics?.executor, "source_rejected");
      assert.equal(error.helperRecoveryDiagnostics?.source, changed === "service" ? "service_changed"
        : changed === "capture" ? "capture_reused" : "capture_time_regressed");
    } finally { await h.dispose(); }
  }
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
      (r: DebugSessionReport) => { (r.steps[0].step.error!.helperRecoveryDiagnostics as any).executor = "private page text"; },
      (r: DebugSessionReport) => { (r.steps[0].step.error!.helperRecoveryDiagnostics as any).token = "secret"; },
      (r: DebugSessionReport) => { r.steps[0].step.observationFailures!.push(r.steps[0].step.observationFailures![0]); },
    ]) {
      const changed = structuredClone(original); mutate(changed); writeFileSync(h.session.state.reportPath!, JSON.stringify(changed));
      await assert.rejects(() => loadTestReport(h.session.state.reportPath!));
    }
  } finally { await h.dispose(); }
});

test("a rejected window motion keeps its bounded reason through failure recording, selected export and independent import", async () => {
  const h = harness({ read: (snapshot, reads) => {
    if (reads === 2) throw incomplete(snapshot, { version: 1, reasons: [{ code: "window_inventory_changed", count: 1 }] }, e => {
      e.windowsBefore[0].bounds.x = -80; e.windowsAfter[0].bounds.x = -20; e.windowsAfter[0].bounds.y = 1;
    });
  } });
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "helper-recovery-export-")));
  try {
    const result = await h.step(); assert.equal(result.isError, true); assert.deepEqual(h.counts(), { reads: 2, inputs: 1 });
    const report = h.report(), original = report.steps[0].step.error!.helperRecoveryDiagnostics!;
    assert.equal(original.candidate, "motion_not_horizontal"); assert.equal(original.executor, "candidate_unavailable");
    assert.equal(report.steps[0].after.snapshotId, null); assert.equal(report.steps[0].step.observationFailures![0].willRetry, false);
    const filePath = realpathSync(h.session.state.reportPath!), loaded = await loadTestReport(filePath);
    assert.deepEqual(loaded.index.cases[0].attempts[0].steps[0].error?.helperRecoveryDiagnostics, original);
    const exported = await exportDebugReportEvidence({ filePath, reportSha256: loaded.index.reportSha256 },
      { requestId: randomUUID(), sourceId: randomUUID(), reportSha256: loaded.index.reportSha256, stepIds: [1],
        includeTrees: true, includeScreenshots: true, includeLogs: false }, parent, { appVersion: "fixture" });
    assert.equal(exported.error, null, String(exported.error)); assert.ok(exported.directory);
    const reloaded = await loadTestReport(join(exported.directory, "report.json"));
    assert.deepEqual(reloaded.debug!.steps[0].step.error!.helperRecoveryDiagnostics, original);
    assert.deepEqual(reloaded.debug!.steps[0].step.observationFailures![0].error.helperRecoveryDiagnostics, original);
    assert.deepEqual(h.report().steps[0].step.error!.helperRecoveryDiagnostics, original);
  } finally { await h.dispose(); rmSync(parent, { recursive: true, force: true }); }
});
