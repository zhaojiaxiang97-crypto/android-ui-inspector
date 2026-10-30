import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { recordCaptureAttempt, isCaptureRequestDiagnostics } from "../shared/capture-attempts";
import { isUiSnapshot } from "../shared/snapshot-validation";
import type { UiSnapshot, CaptureAttempt } from "../shared/types";

const snapshot = (error: string | null = null): UiSnapshot => ({ serial: "sample", root: null, nodeCount: 0,
  xmlSize: 0, rawXml: null, screenshotDataUrl: null, error, warning: null, captureTimings: { tree: 10 } });

test("successful retry keeps the earlier failure even when it had no root", () => {
  const failed = snapshot("App 仍在启动：View capture timed out");
  const first = recordCaptureAttempt([], failed, 1, 0, 3000);
  const attempts = recordCaptureAttempt(first, snapshot(), 2, 5000, 1000);
  assert.equal(attempts[0].error, failed.error);
  assert.equal(attempts[1].error, null);
  failed.captureTimings!.tree = 99;
  assert.equal(attempts[0].timings.tree, 10);
  assert.equal(first.length, 1);
  const diagnostics = { totalDurationMs: 6100, totalAttempts: 2, droppedAttempts: 0, attempts };
  assert.equal(isCaptureRequestDiagnostics(diagnostics), true);
  assert.equal(isUiSnapshot({ ...snapshot(), captureRequestDiagnostics: diagnostics }), true);
  assert.equal(isUiSnapshot(snapshot()), true, "old snapshots remain readable");
});

test("attempt history keeps the first and latest seven with explicit dropped count", () => {
  let attempts: CaptureAttempt[] = [];
  for (let i = 1; i <= 20; i++) attempts = recordCaptureAttempt(attempts, snapshot(), i, (i - 1) * 100, 90);
  assert.deepEqual(attempts.map(a => a.attempt), [1, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(isCaptureRequestDiagnostics({ totalDurationMs: 2000, totalAttempts: 20, droppedAttempts: 12, attempts }), true);
});

test("rejected geometry retains bounded telemetry without publishing the rejected tree", () => {
  const tree = makeNode("0");
  tree.attributes = { "debug-process-id": "123", "sdk-task-queue-buckets": "1;0;0;0;0",
    "sdk-task-queue-max-ms": "0", "sdk-task-slow": "-", "sdk-preview-io": "{\"reads\":2,\"skipped\":1}", "sdk-geometry-summary": "{\"counts\":{}}" };
  const failed = snapshot("SDK geometry rejected");
  failed.captureRequestDiagnostics = { totalDurationMs: 100, totalAttempts: 1, droppedAttempts: 0,
    attempts: recordCaptureAttempt([], { ...failed, root: tree }, 1, 0, 100) };
  const [entry] = recordCaptureAttempt([], failed, 2, 300, 100);
  assert.equal(entry.attempt, 2);
  assert.equal(entry.processId, "123");
  assert.equal(entry.sdkTasks?.["sdk-task-queue-buckets"], "1;0;0;0;0");
  assert.equal(entry.sdkTasks?.["sdk-preview-io"], "{\"reads\":2,\"skipped\":1}");
  assert.equal(failed.root, null);
  assert.equal(entry.sdkGeometry?.["sdk-geometry-summary"], "{\"counts\":{}}");
  failed.captureRequestDiagnostics.attempts[0].sdkTasks!["sdk-task-slow"] = "changed";
  assert.equal(entry.sdkTasks?.["sdk-task-slow"], "-");
  failed.captureRequestDiagnostics.totalAttempts = 0;
  assert.deepEqual(recordCaptureAttempt([], failed, 1, 0, 100)[0].sdkTasks, {});
});

test("summaries cap messages and counters and do not retain pixels or unrelated attributes", () => {
  const s = { ...snapshot(), root: makeNode("0"), warning: "x".repeat(2000) };
  s.root.attributes = { "debug-process-id": "123", "sdk-visible-failure-phase": "draw",
    "sdk-task-queue-buckets": "1;0;0;0;0", "sdk-task-slow": "-",
    "sdk-visible-failure-phase-started-ms": "20", "sdk-visible-failure-phase-wait-ms": "2980",
    "sdk-visible-failure-target": "x".repeat(500), unrelated: "private" };
  s.root.layerImageDataUrl = "data:image/png;base64,private";
  s.captureTimings = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), i]));
  s.captureTimings.invalid = NaN;
  const [a] = recordCaptureAttempt([], s, 1, 0, 1);
  assert.equal(a.warning!.length, 1024);
  assert.equal(Object.keys(a.timings).length, 64);
  assert.equal(a.sdkFailure["sdk-visible-failure-target"].length, 256);
  assert.equal(a.sdkFailure["sdk-visible-failure-phase"], "draw");
  assert.equal(a.sdkFailure["sdk-visible-failure-phase-started-ms"], "20");
  assert.equal(a.sdkFailure["sdk-visible-failure-phase-wait-ms"], "2980");
  assert.equal(a.processId, "123");
  assert.equal(a.sdkTasks?.["sdk-task-queue-buckets"], "1;0;0;0;0");
  assert.equal(JSON.stringify(a).includes("private"), false);
});

test("malformed saved diagnostics are rejected rather than trusted", () => {
  const attempts = recordCaptureAttempt([], snapshot("failed"), 1, 0, 100);
  const d = { totalDurationMs: 100, totalAttempts: 1, droppedAttempts: 0, attempts };
  for (const value of [null, [], { ...d, totalDurationMs: NaN }, { ...d, totalAttempts: 0 },
    { ...d, droppedAttempts: 1 }, { ...d, attempts: [null] }, { ...d, attempts: [...attempts, ...attempts] },
    { ...d, attempts: [{ ...attempts[0], error: "x".repeat(1025) }] },
    { ...d, attempts: [{ ...attempts[0], durationMs: 200 }] },
    { ...d, attempts: [{ ...attempts[0], sdkGeometry: { "sdk-geometry-summary": "x".repeat(16001) } }] },
    { ...d, attempts: [{ ...attempts[0], sdkGeometry: { unknown: "{}" } }] },
    { ...d, attempts: [{ ...attempts[0], sdkFailure: { unknown: "draw" } }] }])
    assert.equal(isCaptureRequestDiagnostics(value), false);
  assert.equal(isUiSnapshot({ ...snapshot(), captureRequestDiagnostics: { ...d, attempts: [] } }), false);
});

test("failure timelines survive attempt recording without retaining unbounded attributes", () => {
  const s = { ...snapshot(), root: makeNode("0") };
  const timing = JSON.stringify({version:1,observedMs:3000,enteredMs:250,snapshotStartedMs:300,
    queueMs:400,geometryMs:12,drawMs:150,verifyMs:4,snapshotPrepareMs:5,snapshotInvokeMs:100});
  s.root.attributes = { "sdk-visible-failure-timing": timing };
  const attempts = recordCaptureAttempt([], s, 1, 0, 100);
  assert.equal(attempts[0].sdkFailure["sdk-visible-failure-timing"],timing);
  s.root.attributes["sdk-visible-failure-timing"] = "changed";
  assert.equal(attempts[0].sdkFailure["sdk-visible-failure-timing"],timing);
  const d = {totalDurationMs:100,totalAttempts:1,droppedAttempts:0,attempts};
  assert.equal(isCaptureRequestDiagnostics(d),true);
  assert.equal(isCaptureRequestDiagnostics({...d,attempts:[{...attempts[0],sdkFailure:{"sdk-visible-failure-timing":"x".repeat(2049)}}]}),false);
});
test("tree difference survives rejected-tree removal and retains bounded immutable data", () => {
  const geometry = JSON.stringify({ version: 1, phase: "before", reason: "position", expected: [0, 0, 10, 10], actual: [0, 2, 10, 10], delta: [0, 2, 0, 0] });
  const s = { ...snapshot("tree-guard rejected"), root: makeNode("0") };
  s.root.attributes = { "sdk-visible-failure-geometry": geometry };
  const attempts = recordCaptureAttempt([], s, 1, 0, 100);
  const d = { totalDurationMs: 100, totalAttempts: 1, droppedAttempts: 0, attempts };
  assert.equal(isCaptureRequestDiagnostics(d), true);
  const rejected = { ...snapshot(s.error), captureRequestDiagnostics: d };
  assert.equal(recordCaptureAttempt([], rejected, 1, 0, 100)[0].sdkFailure["sdk-visible-failure-geometry"], geometry);
  s.root.attributes["sdk-visible-failure-geometry"] = "changed";
  assert.equal(attempts[0].sdkFailure["sdk-visible-failure-geometry"], geometry);
  assert.equal(isCaptureRequestDiagnostics({ ...d, attempts: [{ ...attempts[0], sdkFailure: { "sdk-visible-failure-geometry": "x".repeat(2049) } }] }), false);
});
test("property protocol diagnostics survive rejected-tree removal with bounded immutable fields", () => {
  const fields = { "view-property-probe-requests": "2", "view-property-export-requests": "2",
    "view-property-success": "false", "view-property-phase": "decode" };
  const tree = makeNode("0");
  tree.attributes = { ...fields, private: "pixels" };
  const failed = { ...snapshot("Debug V2 failed"), root: tree };
  const attempts = recordCaptureAttempt([], failed, 1, 0, 100);
  const diagnostics = { totalDurationMs: 100, totalAttempts: 1, droppedAttempts: 0, attempts };
  assert.deepEqual(attempts[0].viewHierarchy, fields);
  assert.equal(isUiSnapshot({ ...snapshot(), captureRequestDiagnostics: diagnostics }), true);
  const rejected = { ...snapshot(failed.error), captureRequestDiagnostics: diagnostics };
  const [renumbered] = recordCaptureAttempt([], rejected, 2, 100, 100);
  assert.deepEqual(renumbered.viewHierarchy, fields);
  assert.equal(renumbered.timings.tree, 10);
  tree.attributes["view-property-phase"] = "changed";
  attempts[0].viewHierarchy!["view-property-phase"] = "changed";
  assert.equal(renumbered.viewHierarchy!["view-property-phase"], "decode");
  assert.equal(JSON.stringify(renumbered).includes("pixels"), false);
  for (const invalid of [
    { ...fields, "view-property-probe-requests": "33" },
    { ...fields, "view-property-probe-requests": "-1" },
    { ...fields, "view-property-probe-requests": "000" },
    { ...fields, "view-property-export-requests": "3" },
    { ...fields, "view-property-phase": "unknown" },
    { ...fields, "view-property-success": false },
    { ...fields, private: "pixels" },
    { "view-property-phase": "decode" },
  ]) {
    const d = { ...diagnostics, attempts: [{ ...renumbered, attempt: 1, startedAfterMs: 0, viewHierarchy: invalid }] };
    assert.equal(isCaptureRequestDiagnostics(d), false);
  }
  tree.attributes = { "view-property-phase": "decode" };
  assert.equal(recordCaptureAttempt([], { ...failed, root: tree }, 1, 0, 100)[0].viewHierarchy, undefined);
});
