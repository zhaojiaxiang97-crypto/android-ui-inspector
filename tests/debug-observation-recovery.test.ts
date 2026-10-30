import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession } from "../electron/automation/debug-session";
import { DebugObservationError } from "../electron/automation/debug-observation-error";
import { DebugInputError } from "../electron/device/debug-input";
import { readMcpSnapshot } from "../electron/automation/mcp-snapshot";
import type { DebugSessionReport } from "../shared/debug-report";
import type { DebugInputEvidence, UiSnapshot } from "../shared/types";

const packageName = "com.example.recovery", serial = "offline-device";
const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "window-1", activityRecordId: "activity-1" };
const receipt: DebugInputEvidence = { classification: "accepted", spawned: true, closed: true, exitCode: 0,
  signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };

function snapshot(text = "播放视频"): UiSnapshot {
  const root = makeNode("0"), button = makeNode("0/0");
  root.package = button.package = packageName;
  root.clickable = root.scrollable = false; root.bounds = { left: 0, top: 0, right: 1080, bottom: 2400, raw: "" };
  button.resourceId = `${packageName}:id/play`; button.text = text;
  button.clickable = button.enabled = button.visibleToUser = true;
  button.scrollable = false; button.children = [];
  button.bounds = { left: 20, top: 100, right: 180, bottom: 160, raw: "" };
  root.children = [button];
  const frame = { width: 1080, height: 2400, rotation: 0 as const };
  return { serial, root, nodeCount: 2, xmlSize: 0, rawXml: null, error: null, warning: null, screenshotDataUrl: null,
    captureMode: "fast", inspectionSource: "uiautomator",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } };
}

function harness(overrides: Partial<ConstructorParameters<typeof DebugSession>[0]> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "inspector-observation-recovery-")), path = join(directory, "current.json");
  const session = new DebugSession({ serial, packageName, directory, snapshotPath: path, onEvent: () => {},
    observe: async () => ({ snapshot: snapshot(), target }), ...overrides });
  return { session, path,
    capture: () => session.request({ name: "capture_ui", input: { sessionId: session.state.id } }),
    tap: (snapshotId: unknown) => session.request({ name: "tap_node", input: { sessionId: session.state.id, snapshotId, nodeId: "0/0" } }),
    report: () => JSON.parse(readFileSync(session.state.reportPath!, "utf8")) as DebugSessionReport,
    async dispose() { session.stop(); await session.settled(); rmSync(directory, { force: true, recursive: true }); },
  };
}

test("post-click window transition and empty tree recover inside one action without replaying input", async () => {
  let reads = 0, inputs = 0;
  const h = harness({ observe: async () => {
    reads++;
    if (reads === 3) throw new DebugObservationError("window_changed", "页面切换中");
    if (reads === 4) throw new DebugObservationError("hierarchy_unavailable", "新树暂未就绪");
    return { snapshot: snapshot(reads >= 5 ? "暂停视频" : "播放视频"),
      target: reads >= 5 ? { ...target, component: `${packageName}/.Player`, activityName: ".Player", windowId: "window-2", activityRecordId: "activity-2" } : target };
  }, input: async (_s, _t, _a, _f, _signal, onEvidence) => { inputs++; onEvidence?.(receipt); } });
  try {
    const initial = await h.capture(), result = await h.tap(initial.snapshotId);
    assert.equal(result.isError, undefined); assert.equal(result.dispatchState, "sent"); assert.equal(result.verified, false);
    assert.equal(result.observationAttempts, 3); assert.equal(inputs, 1); assert.equal(reads, 5);
    assert.notEqual(result.snapshotId, initial.snapshotId);
    assert.equal(readMcpSnapshot(h.path).snapshot.root!.children[0].text, "暂停视频");
    const saved = h.report().steps.at(-1)!;
    assert.equal(saved.step.status, "done"); assert.equal(saved.step.verified, false); assert.equal(saved.step.dispatchState, "sent");
    assert.equal(saved.step.inputEvidence?.classification, "accepted"); assert.ok(saved.after.snapshotId);
    assert.match(saved.step.message, /第 3 次观察恢复/);
    assert.equal((await h.tap(initial.snapshotId)).dispatchState, "not_sent"); assert.equal(inputs, 1);
  } finally { await h.dispose(); }
});

test("persistent transient observation failure is bounded to three reads and preserves sent evidence", async () => {
  let reads = 0, inputs = 0;
  const h = harness({ observe: async () => {
    if (++reads >= 3) throw new DebugObservationError("hierarchy_unavailable", "新树暂未就绪");
    return { snapshot: snapshot(), target };
  }, input: async (_s, _t, _a, _f, _signal, onEvidence) => { inputs++; onEvidence?.(receipt); } });
  try {
    const result = await h.tap((await h.capture()).snapshotId);
    assert.equal(result.isError, true); assert.equal(result.dispatchState, "sent"); assert.equal(result.verified, false);
    assert.equal(reads, 5); assert.equal(inputs, 1); assert.equal(result.snapshotId, null); assert.equal(existsSync(h.path), false);
    const saved = h.report().steps.at(-1)!;
    assert.equal(saved.step.dispatchState, "sent"); assert.equal(saved.step.inputEvidence?.classification, "accepted");
    assert.ok(saved.before.snapshotId); assert.equal(saved.after.snapshotId, null);
  } finally { await h.dispose(); }
});

test("ordinary observation failures and observations from another App are never retried", async () => {
  for (const foreign of [false, true]) {
    let reads = 0, inputs = 0;
    const h = harness({ observe: async () => {
      if (++reads >= 3) {
        if (!foreign) throw new Error("设备断开");
        const page = snapshot(); page.root!.package = "com.other.app";
        return { snapshot: page, target: { ...target, packageName: "com.other.app" } };
      }
      return { snapshot: snapshot(), target };
    }, input: async () => { inputs++; } });
    try {
      const result = await h.tap((await h.capture()).snapshotId);
      assert.equal(result.isError, true); assert.equal(result.dispatchState, "sent"); assert.equal(result.snapshotId, null);
      assert.equal(reads, 3); assert.equal(inputs, 1); assert.equal(existsSync(h.path), false);
    } finally { await h.dispose(); }
  }
});

test("a transient pre-input failure never triggers recovery or sends input", async () => {
  let reads = 0, inputs = 0;
  const h = harness({ observe: async () => {
    if (++reads === 2) throw new DebugObservationError("window_changed", "页面切换中");
    return { snapshot: snapshot(), target };
  }, input: async () => { inputs++; } });
  try {
    const result = await h.tap((await h.capture()).snapshotId);
    assert.equal(result.isError, true); assert.equal(result.dispatchState, "not_sent");
    assert.equal(inputs, 0); assert.equal(reads, 2);
  } finally { await h.dispose(); }
});

test("changed Activity instance is rejected before input even with the same component and window", async () => {
  let reads = 0, inputs = 0;
  const h = harness({ observe: async () => ({ snapshot: snapshot(), target: { ...target, activityRecordId: ++reads > 1 ? "activity-recreated" : target.activityRecordId } }),
    input: async () => { inputs++; } });
  try {
    const result = await h.tap((await h.capture()).snapshotId);
    assert.equal(result.isError, true); assert.equal(result.dispatchState, "not_sent"); assert.equal(inputs, 0);
  } finally { await h.dispose(); }
});

test("an uncertain input receipt is never replayed or followed by automatic recovery", async () => {
  let reads = 0, inputs = 0;
  const h = harness({ observe: async () => { reads++; return { snapshot: snapshot(), target }; }, input: async () => {
    inputs++; throw new DebugInputError({ ...receipt, classification: "timeout", exitCode: null, signal: "SIGTERM" });
  } });
  try {
    const result = await h.tap((await h.capture()).snapshotId);
    assert.equal(result.isError, true); assert.equal(result.dispatchState, "unknown"); assert.equal(result.snapshotId, null);
    assert.equal(reads, 2); assert.equal(inputs, 1);
  } finally { await h.dispose(); }
});

test("stop during recovery cancels the wait and cannot publish or dispatch again", async () => {
  let reads = 0, inputs = 0;
  const h = harness({ observe: async () => {
    if (++reads === 3) throw new DebugObservationError("window_changed", "页面切换中");
    return { snapshot: snapshot(), target };
  }, input: async () => { inputs++; }, onEvent: event => {
    if (event.state.steps.at(-1)?.message.includes("重新观察（2/3）")) h.session.stop("stop during recovery");
  } });
  try {
    const result = await h.tap((await h.capture()).snapshotId);
    assert.equal(result.isError, true); assert.equal(result.dispatchState, "sent"); assert.equal(result.snapshotId, null);
    assert.equal(inputs, 1); assert.equal(reads, 3); assert.equal(existsSync(h.path), false);
  } finally { await h.dispose(); }
});
