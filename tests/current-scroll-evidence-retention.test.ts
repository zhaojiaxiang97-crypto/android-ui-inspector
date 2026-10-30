import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { DebugSessionRecording } from "../electron/automation/debug-session-recording";
import type { StepContext } from "../electron/automation/debug-step-context";
import type { McpSnapshot } from "../electron/automation/mcp-snapshot";
import { exportDebugReportEvidence } from "../electron/desktop/debug-report-export";
import { loadTestReport } from "../electron/desktop/test-report";
import { inspectRegressionEvidence } from "../scripts/automation-ui-regression";
import type { DebugSessionReport } from "../shared/debug-report";
import { debugSnapshotPriorities } from "../shared/debug-evidence-priority";
import type { DebugSessionState } from "../shared/types";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const MiB = 1024 * 1024, frame = { width: 1024, height: 960, rotation: 0 as const };
let pngs: Promise<string[]> | undefined;
function images() {
  return pngs ??= (async () => {
    const pixels = Buffer.alloc(frame.width * frame.height * 3);
    let seed = 7;
    for (let i = 0; i < pixels.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels[i] = seed & 255; }
    const result: string[] = [];
    for (let index = 0; index < 14; index++) {
      pixels[0] = index;
      const bytes = await sharp(pixels, { raw: { width: frame.width, height: frame.height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
      assert.ok(bytes.length > 2.9 * 1000_000);
      result.push(`data:image/png;base64,${bytes.toString("base64")}`);
    }
    return result;
  })();
}

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "current-scroll-retention-"))), png = await images();
  const started = Date.now() - 120_000;
  const state: DebugSessionState = { id: randomUUID(), serial: "fixture", packageName: "com.example.fixture", active: true,
    busy: false, expiresAt: new Date(Date.now() + 60_000).toISOString(), startedAt: new Date(started).toISOString(),
    steps: [], evidencePath: null, stopReason: null };
  const recorder = new DebugSessionRecording({ directory, state });
  let sequence = 0;
  const observe = (index: number, helper = false, text = "END"): McpSnapshot => {
    const order = ++sequence;
    const snapshot = helperEvidenceSnapshot({ startedAt: order * 100, packageName: state.packageName, serial: state.serial, ...frame, text });
    snapshot.screenshotDataUrl = png[index];
    if (!helper) { snapshot.inspectionSource = "uiautomator"; delete snapshot.helperObservation; }
    Object.assign(snapshot.root!.attributes!, { "debug-observation-component": `${state.packageName}/.Main`,
      "debug-observation-window-id": "window", "debug-observation-activity-record-id": "activity" });
    return { id: randomUUID(), sharedAt: new Date(started + order * 1000).toISOString(), ownerPid: process.pid, selectedNodeId: null, snapshot };
  };
  const scroll = (id: number, entries: McpSnapshot[], done = true): StepContext => {
    const iterations = Array.from({ length: entries.length - 2 }, (_, i) => ({ index: i + 1, startedAt: entries[i].sharedAt,
      durationMs: 1, beforeId: entries[i].id, afterId: entries[i + 1].id, dispatchState: "sent" as const, progress: "changed" as const,
      resolvedInput: { action: { kind: "swipe" as const, fromX: 50, fromY: 100, toX: 50, toY: 50, durationMs: 350 }, frame } }));
    return { step: { id, time: entries[0].sharedAt, action: "scroll_until", status: done ? "done" : "running", message: "fixture scroll",
      input: { sessionId: state.id, requestId: randomUUID(), backend: "uiautomator", target: { selector: { resourceId: state.packageName + ":id/list" } },
        direction: "down", until: { kind: "end_marker", selector: { resourceId: state.packageName + ":id/end" } }, maxScrolls: 12, timeoutMs: 120000 },
      dispatchState: iterations.length ? "sent" : "not_sent", verified: done,
      scrollTask: { stopReason: done ? "end_reached" : "running", iterations, observationIds: entries.map(item => item.id),
        ...(done ? { confirmation: { firstSnapshotId: entries.at(-2)!.id, secondSnapshotId: entries.at(-1)!.id, kind: "end_marker" as const } } : {}) } },
      before: entries[Math.max(0, entries.length - 3)], beforeFreshness: "current", after: entries.at(-1)!, previousAfter: null,
      invalidatedAfter: false, started: performance.now(), phase: "verify", scrollObservations: entries,
      finishedAt: new Date(Date.parse(entries.at(-1)!.sharedAt) + 500).toISOString() };
  };
  const record = (context: StepContext) => {
    state.steps = [...state.steps.filter(item => item.id !== context.step.id), context.step];
    recorder.record(context, context.step.id); recorder.saveSession(context.step.id);
  };
  const history = () => {
    const entries: McpSnapshot[] = [];
    for (let i = 0; i < 5; i++) {
      const pair = [observe(i * 2), observe(i * 2 + 1)]; entries.push(...pair); record(scroll(i + 1, pair));
    }
    return entries;
  };
  const report = () => JSON.parse(readFileSync(state.reportPath!, "utf8")) as DebugSessionReport;
  const exportSteps = async (ids: number[]) => {
    const parent = join(directory, "exports"); mkdirSync(parent, { recursive: true });
    const sha = createHash("sha256").update(readFileSync(state.reportPath!)).digest("hex");
    const result = await exportDebugReportEvidence({ filePath: state.reportPath!, reportSha256: sha }, {
      requestId: randomUUID(), sourceId: state.id, reportSha256: sha, stepIds: ids,
      includeTrees: true, includeScreenshots: true, includeLogs: true }, parent, { appVersion: "fixture" });
    assert.equal(result.error, null); assert.ok(result.directory);
    return inspectRegressionEvidence(join(result.directory, "report.json"), ids,
      { sessionId: state.id, serial: state.serial, packageName: state.packageName }, loadTestReport, ids.at(-1));
  };
  return { state, recorder, observe, scroll, record, history, report, exportSteps,
    dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

test("recording keeps the current scroll across intermediate saves and trims old proof before its four-frame export", async () => {
  const f = await fixture();
  try {
    const history = f.history(), visualReference = history[0];
    const entries = [f.observe(10), f.observe(11), f.observe(12), f.observe(13)];
    const visual = (context: StepContext) => {
      context.step.input.visualConfirmation = { snapshotId: visualReference.id, description: "fixture visual reference" };
      const first = context.step.scrollTask!.iterations[0]; first.resolvedInput!.targetNodeId = "0";
      first.resolvedInput!.visualConfirmation = { referenceSnapshotId: visualReference.id, currentSnapshotId: first.beforeId!,
        description: "fixture visual reference", region: { left: 0, top: 0, width: frame.width, height: frame.height },
        sha256: "a".repeat(64), overlapNodeIds: [] };
    };
    const current = f.scroll(6, entries.slice(0, 3), false); visual(current); f.record(current);
    assert.equal(current.step.recordingErrors, undefined, "intermediate persistence must not lose the first input frame");
    const complete = f.scroll(6, entries); complete.step.input = current.step.input; visual(complete); f.record(complete);
    const report = f.report();
    assert.equal(report.limits.maxBytes, 32 * MiB); assert.ok(report.storage.bytes <= 32 * MiB);
    assert.ok(report.snapshots.filter(item => !entries.some(entry => entry.id === item.snapshotId)).some(item => !item.screenshot));
    for (const entry of [...entries, visualReference]) {
      const saved = report.snapshots.find(item => item.snapshotId === entry.id)!;
      assert.ok(saved.tree && saved.screenshot); assert.deepEqual(saved.warnings, []);
    }
    assert.equal(complete.step.recordingErrors, undefined);
    assert.equal(debugSnapshotPriorities(report).get(entries[0].id), 1, "viewer defaults are unchanged");
    assert.equal((await f.exportSteps([6])).complete, true);
  } finally { f.dispose(); }
});

test("a current scroll larger than 32 MiB still records missing evidence and cannot pass complete archival", async () => {
  const f = await fixture();
  try {
    const entries = Array.from({ length: 12 }, (_, i) => f.observe(i)), current = f.scroll(1, entries); f.record(current);
    const report = f.report();
    assert.equal(report.limits.maxBytes, 32 * MiB); assert.ok(report.storage.bytes <= 32 * MiB);
    assert.ok(report.snapshots.some(item => !item.screenshot));
    assert.ok(current.step.recordingErrors?.some(error => error.code === "evidence_capacity_exceeded"));
    assert.ok(report.steps[0].step.recordingErrors?.some(error => error.code === "evidence_capacity_exceeded"));
    const evidence = await inspectRegressionEvidence(f.state.reportPath!, [1], {
      sessionId: f.state.id, serial: f.state.serial, packageName: f.state.packageName }, loadTestReport, 1);
    assert.notEqual(evidence.complete, true); assert.ok(evidence.missingScreenshots > 0);
  } finally { f.dispose(); }
});

test("partial resume protects only a unique same-session/request original input-before under history pressure", async () => {
  for (const variant of ["same request", "different request", "different session", "ambiguous original"] as const) {
  const f = await fixture();
  try {
    f.history();
    const before = f.observe(10, true, "START"), requestId = randomUUID();
    const original: StepContext = { started: performance.now(), phase: "capture", before, beforeFreshness: "current", after: null,
      previousAfter: null, invalidatedAfter: true, finishedAt: new Date(Date.parse(before.sharedAt) + 500).toISOString(),
      step: { id: 6, time: before.sharedAt, action: "perform_ui_step", status: "failed", message: "fixture capture failed", verified: false,
        input: { sessionId: f.state.id, requestId, backend: "accessibility-helper", target: { selector: { text: "START" } },
          action: { kind: "tap" }, expect: { selector: { text: "END" }, state: "visible", visibility: "partial" }, timeoutMs: 1000 },
        dispatchState: "sent", error: { category: "capture", code: "capture_failed", phase: "capture", message: "fixture" },
        resolvedInput: { action: { kind: "tap", x: frame.width / 2, y: frame.height / 2 }, frame, targetNodeId: "0" },
        inputEvidence: { classification: "accepted", spawned: true, closed: true, exitCode: 0, signal: null, durationMs: 1,
          stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false } } };
    f.record(original);
    const originalSaved = f.report().steps.at(-1)!;
    if (variant === "ambiguous original") f.record({ ...original, step: { ...original.step, id: 7 } });
    const first = f.observe(11, true), second = f.observe(12, true);
    const proof = (entry: McpSnapshot) => ({ snapshotId: entry.id, capturedAt: entry.sharedAt,
      component: f.state.packageName + "/.Main", windowId: "window", activityRecordId: "activity" });
    const resume: StepContext = { started: performance.now(), phase: "verify", before: null, beforeFreshness: "current", after: second,
      previousAfter: null, invalidatedAfter: false, assertionObservations: [first, second],
      finishedAt: new Date(Date.parse(second.sharedAt) + 500).toISOString(),
      step: { id: variant === "ambiguous original" ? 8 : 7, time: first.sharedAt, action: "resume_ui_step", status: "done", message: "fixture resumed", verified: true,
        input: { sessionId: variant === "different session" ? randomUUID() : f.state.id,
          requestId: variant === "different request" ? randomUUID() : requestId, timeoutMs: 1000 }, dispatchState: "sent",
        assertionConfirmation: { first: proof(first), second: proof(second) } } };
    f.record(resume);
    const report = f.report();
    for (const entry of [first, second]) assert.ok(report.snapshots.find(item => item.snapshotId === entry.id)!.screenshot);
    assert.equal(Boolean(report.snapshots.find(item => item.snapshotId === before.id)!.screenshot), variant === "same request", variant);
    assert.deepEqual(report.steps.find(item => item.step.id === 6), originalSaved, "recovery never rewrites the original failure");
    assert.equal(resume.step.recordingErrors, undefined);
    if (variant === "same request") {
      const evidence = await f.exportSteps([6, 7]);
      assert.equal(evidence.complete, true); assert.ok(evidence.recoveryChain);
    }
  } finally { f.dispose(); }
  }
});
