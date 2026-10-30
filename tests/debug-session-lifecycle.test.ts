import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession } from "../electron/automation/debug-session";
import { DebugInputError } from "../electron/device/debug-input";
import type { DebugInputEvidence, DebugSessionEvent, UiSnapshot } from "../shared/types";
import type { DebugSessionReport } from "../shared/debug-report";

const packageName = "com.example.lifecycle", serial = "offline-device";
const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "fixture-window" };
const receipt: DebugInputEvidence = { classification: "accepted", spawned: true, closed: true, exitCode: 0,
  signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
function snapshot(): UiSnapshot {
  const root = makeNode("0"); root.package = packageName; root.children = []; root.text = "ready";
  const frame = { width: 100, height: 100, rotation: 0 as const };
  return { serial, root, nodeCount: 1, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null,
    captureMode: "fast", inspectionSource: "uiautomator",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(overrides: Partial<ConstructorParameters<typeof DebugSession>[0]> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "inspector-step-lifecycle-")), path = join(directory, "current.json");
  const events: DebugSessionEvent[] = [];
  const session = new DebugSession({ serial, packageName, snapshotPath: path, directory,
    onEvent: event => events.push(structuredClone(event)), observe: async () => ({ snapshot: snapshot(), target }), ...overrides });
  const capture = () => session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
  const back = (snapshotId: unknown, signal?: AbortSignal) => session.request({ name: "press_back", input: { sessionId: session.state.id, snapshotId } }, signal);
  return { session, directory, path, events, capture, back,
    report: () => JSON.parse(readFileSync(session.state.reportPath!, "utf8")) as DebugSessionReport,
    async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}

test("caller cancellation keeps sent input owned until it settles and cannot reuse or replay its old snapshot", async () => {
  const entered = deferred(), release = deferred(), caller = new AbortController();
  let reads = 0, inputs = 0;
  const h = harness({ observe: async () => { reads++; return { snapshot: snapshot(), target }; },
    input: async (_serial, _target, _action, _frame, signal, onEvidence) => {
      inputs++; assert.equal(existsSync(h.path), false, "share is revoked before the input adapter starts");
      entered.resolve(); await release.promise; assert.equal(signal!.aborted, true);
      const evidence = { ...receipt, classification: "cancelled" as const, exitCode: null, signal: "SIGTERM" };
      onEvidence?.(evidence); throw new DebugInputError(evidence);
    } });
  try {
    const first = await h.capture(), pending = h.back(first.snapshotId, caller.signal);
    await entered.promise; caller.abort(new Error("cancel only this input"));
    assert.equal(h.session.state.active, true); assert.equal(h.session.state.busy, true); assert.equal(h.session.hasPendingWork, true);
    let settled = false; const draining = h.session.settled().then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    await assert.rejects(h.capture(), /正在执行/); assert.equal(reads, 2); assert.equal(inputs, 1);
    release.resolve(); const result = await pending; await draining;
    assert.equal(result.isError, true); assert.equal(result.dispatchState, "unknown"); assert.equal(result.verified, false);
    assert.equal(result.snapshotId, null); assert.equal(h.session.hasPendingWork, false); assert.equal(existsSync(h.path), false);
    const saved = h.report().steps.at(-1)!;
    assert.equal(saved.step.inputEvidence?.classification, "cancelled"); assert.equal(saved.step.dispatchState, "unknown");
    assert.ok(saved.before.snapshotId); assert.equal(saved.after.snapshotId, null);
    assert.equal((await h.back(first.snapshotId)).dispatchState, "not_sent"); assert.equal(inputs, 1); assert.equal(reads, 2);
  } finally { release.resolve(); await h.dispose(); }
});

test("stop during the post-input observation preserves the accepted receipt and rejects the late page", async () => {
  const entered = deferred(), release = deferred(); let reads = 0, inputs = 0;
  const h = harness({ observe: async () => {
    if (++reads === 3) { entered.resolve(); await release.promise; }
    return { snapshot: snapshot(), target };
  }, input: async (_serial, _target, _action, _frame, _signal, onEvidence) => { inputs++; onEvidence?.(receipt); } });
  try {
    const first = await h.capture(), pending = h.back(first.snapshotId);
    await entered.promise; const published = h.events.filter(event => event.snapshot).length;
    h.session.stop("stop after acknowledged input");
    assert.equal(h.session.state.busy, false); assert.equal(h.session.hasPendingWork, true);
    let settled = false; const draining = h.session.settled().then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    await assert.rejects(h.capture(), /会话已结束/);
    release.resolve(); const result = await pending; await draining;
    assert.equal(result.isError, true); assert.equal(result.dispatchState, "sent"); assert.equal(result.verified, false);
    assert.equal(inputs, 1); assert.equal(reads, 3); assert.equal(h.session.hasPendingWork, false);
    assert.equal(existsSync(h.path), false); assert.equal(h.events.filter(event => event.snapshot).length, published);
    const saved = h.report().steps.at(-1)!;
    assert.equal(saved.step.inputEvidence?.classification, "accepted"); assert.equal(saved.step.dispatchState, "sent");
    assert.ok(saved.before.snapshotId); assert.equal(saved.after.snapshotId, null);
  } finally { release.resolve(); await h.dispose(); }
});

test("stopping optional recording keeps a completed action and receipt without claiming verification", async () => {
  let inputs = 0, reads = 0;
  const h = harness({ observe: async () => { reads++; return { snapshot: snapshot(), target }; },
    input: async (_serial, _target, _action, _frame, _signal, onEvidence) => { inputs++; onEvidence?.(receipt); },
    onEvent: event => {
      if (event.state.progress?.phase === "recording" && event.state.progress.action === "press_back") {
        h.session.stop("stop optional evidence"); assert.equal(h.session.hasPendingWork, true);
      }
    } });
  try {
    const first = await h.capture(), result = await h.back(first.snapshotId); await h.session.settled();
    assert.equal(result.isError, undefined); assert.equal(result.dispatched, true); assert.equal(result.dispatchState, "sent");
    assert.equal(result.verified, false); assert.equal(inputs, 1); assert.equal(reads, 3); assert.equal(h.session.hasPendingWork, false);
    const saved = h.report().steps.at(-1)!;
    assert.equal(saved.step.status, "done"); assert.equal(saved.step.error, undefined); assert.equal(saved.step.dispatchState, "sent");
    assert.equal(saved.step.inputEvidence?.classification, "accepted"); assert.ok(saved.before.snapshotId); assert.ok(saved.after.snapshotId);
    assert.equal(h.report().session.active, false); assert.equal(existsSync(h.path), false);
  } finally { await h.dispose(); }
});
