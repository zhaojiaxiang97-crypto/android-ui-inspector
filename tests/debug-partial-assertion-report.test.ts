import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { parseUiHierarchy } from "../electron/capture/xml-tree";
import { exportDebugReportEvidence } from "../electron/desktop/debug-report-export";
import { loadTestReport } from "../electron/desktop/test-report";
import { debugToolSchemas } from "../shared/debug-protocol";
import type { DebugSessionReport } from "../shared/debug-report";
import type { DebugTaskCheckResult } from "../shared/debug-task";
import type { UiSnapshot } from "../shared/types";
import { makeDebugReportExportFixture } from "./fixtures/debug-report-export";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const frame = { width: 200, height: 400, rotation: 0 as const };
function cover(snapshot: UiSnapshot, bounds = { x: 0, y: 0, width: 200, height: 20 }) {
  const evidence = snapshot.helperObservation!;
  evidence.windowsBefore = [evidence.windowsBefore[0], { id: "8", type: "system", layer: 2,
    focused: false, active: false, packageName: "com.android.systemui", rootAvailable: true, bounds }];
  evidence.windowsAfter = structuredClone(evidence.windowsBefore);
}

async function fixture(kind: "wait" | "tap" | "resume" = "wait") {
  const f = await makeDebugReportExportFixture();
  const entry = f.report.steps[2], { packageName, serial } = f.report.session;
  const document = JSON.parse(readFileSync(join(f.directory, f.report.snapshots[0].tree!.path), "utf8"));
  const snapshots = f.report.snapshots.map((_, index) => {
    const snapshot = helperEvidenceSnapshot({ packageName, serial, ...frame, startedAt: 100 + index * 400 });
    const xml = `<hierarchy rotation="0"><node index="0" class="Root" package="${packageName}" text="READY"
      resource-id="${packageName}:id/player" content-desc="" bounds="[0,0][200,400]" bounds-screen="[0,0][200,400]"
      visible-bounds="[0,0][200,400]" window-id="7" visible-to-user="true" enabled="true" clickable="true"
      focusable="true" focused="false" scrollable="false" selected="false">
      <node index="0" class="Button" package="${packageName}" text="目标" resource-id="${packageName}:id/button"
        content-desc="" bounds="[40,80][160,160]" bounds-screen="[40,80][160,160]" visible-bounds="[40,80][160,160]"
        window-id="7" visible-to-user="true" enabled="true" clickable="true" focusable="true" focused="false"
        scrollable="false" selected="false"/></node></hierarchy>`;
    snapshot.rawXml = xml; snapshot.xmlSize = Buffer.byteLength(xml); snapshot.root = parseUiHierarchy(xml).root;
    snapshot.nodeCount = 2;
    Object.assign(snapshot.root!.attributes!, { "debug-observation-component": `${packageName}/.Main`,
      "debug-observation-window-id": "task-window", "debug-observation-activity-record-id": "activity-1" });
    cover(snapshot); return snapshot;
  });
  const ids = f.report.snapshots.map(item => item.snapshotId);
  const image = await sharp({ create: { ...frame, channels: 4, background: "#335577" } }).png().toBuffer();
  const save = () => {
    for (const [index, evidence] of f.report.snapshots.entries()) {
      evidence.source = "accessibility-helper";
      evidence.tree = f.artifact(Buffer.from(JSON.stringify({ ...document, snapshotId: evidence.snapshotId,
        capturedAt: evidence.capturedAt, snapshot: snapshots[index] })), "json");
      evidence.screenshot = f.artifact(image, "png");
    }
    f.save();
  };
  const observation = (index: number) => ({ snapshotId: ids[index], capturedAt: f.report.snapshots[index].capturedAt,
    component: `${packageName}/.Main`, windowId: "task-window", activityRecordId: "activity-1" });
  const condition = { selector: { text: "READY" }, state: "visible" as const, visibility: "partial" as const };
  entry.step.time = f.report.session.startedAt; entry.step.status = "done";
  entry.finishedAt = f.report.session.updatedAt;
  entry.before = { snapshotId: ids[0], freshness: "current", reason: null }; entry.step.beforeId = ids[0];
  entry.after = { snapshotId: ids[2], freshness: "current", reason: null }; entry.step.afterId = ids[2];
  entry.step.verified = entry.verified = true;
  entry.step.assertionConfirmation = { first: observation(1), second: observation(2) };
  if (kind === "wait") {
    entry.step.action = "wait_for_ui";
    entry.step.input = debugToolSchemas.wait_for_ui.parse({ sessionId: f.report.session.id, ...condition });
  } else {
    entry.step.action = "perform_ui_step";
    entry.step.input = debugToolSchemas.perform_ui_step.parse({ sessionId: f.report.session.id,
      requestId: "abcdef00-0000-4000-8000-000000000099", backend: "accessibility-helper",
      target: { selector: { text: "目标" } }, action: { kind: "tap" }, expect: condition });
    entry.step.dispatchState = "sent";
    entry.step.inputEvidence = { classification: "accepted", spawned: true, closed: true, exitCode: 0, signal: null,
      durationMs: 20, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
    entry.step.resolvedInput = { action: { kind: "tap", x: 100, y: 120 }, frame, targetNodeId: "0/0" };
  }
  f.report.steps = [entry]; f.report.session.droppedSteps = 2;
  if (kind === "resume") {
    const original = structuredClone(entry);
    original.step.status = "failed"; original.step.verified = original.verified = false;
    original.finishedAt = "2026-10-12T09:00:00.500Z";
    original.step.message = "等待未确认";
    delete original.step.assertionConfirmation; delete original.step.afterId;
    original.after = { snapshotId: null, freshness: "missing", reason: "原断言失败" };
    entry.step.id = 4; entry.step.time = "2026-10-12T09:00:01.000Z";
    entry.step.action = "resume_ui_step";
    entry.step.input = { sessionId: f.report.session.id, requestId: original.step.input.requestId, timeoutMs: 1000 };
    delete entry.step.inputEvidence; delete entry.step.resolvedInput;
    entry.step.beforeId = ids[1]; entry.before = { snapshotId: ids[1], freshness: "current", reason: null };
    f.report.steps = [original, entry]; f.report.session.totalSteps = 4;
  }
  save();
  return { ...f, entry, snapshots, ids, save, saveManifest: f.save,
    result: async () => (await loadTestReport(f.file)).debug!.steps.at(-1)! };
}

test("partial wait, compound tap and read-only resume roundtrip two actual Helper trees and screenshots", async () => {
  for (const kind of ["wait", "tap", "resume"] as const) {
    const f = await fixture(kind);
    try { assert.equal((await f.result()).verified, true, kind); }
    finally { f.cleanup(); }
  }
});

test("partial assertion manifests reject missing, reused, stale, reordered and misbound observations", async () => {
  const mutations = [
    (f: Awaited<ReturnType<typeof fixture>>) => { delete f.entry.step.assertionConfirmation; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.entry.step.assertionConfirmation!.second = structuredClone(f.entry.step.assertionConfirmation!.first); },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.entry.step.assertionConfirmation!.first.capturedAt = "2026-10-12T08:59:59.000Z"; },
    (f: Awaited<ReturnType<typeof fixture>>) => { const c = f.entry.step.assertionConfirmation!; [c.first, c.second] = [c.second, c.first]; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.entry.step.afterId = f.ids[1]; f.entry.after.snapshotId = f.ids[1]; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.report.snapshots[1].source = "uiautomator"; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.entry.step.time = "2026-10-12T09:00:01.500Z"; f.entry.before = { snapshotId: null, freshness: "missing", reason: "none" }; delete f.entry.step.beforeId; },
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    try { mutate(f); f.saveManifest(); await assert.rejects(loadTestReport(f.file)); }
    finally { f.cleanup(); }
  }
  const f = await fixture("tap");
  try { f.entry.step.input.backend = "uiautomator"; f.saveManifest(); await assert.rejects(loadTestReport(f.file)); }
  finally { f.cleanup(); }
});

test("partial offline checks bind declared component/window/Activity to each actual tree and helper capture", async () => {
  const mutations = [
    (f: Awaited<ReturnType<typeof fixture>>) => { f.entry.step.assertionConfirmation!.first.component += "Changed"; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.entry.step.assertionConfirmation!.second.windowId = "other"; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.entry.step.assertionConfirmation!.first.activityRecordId = null; },
    (f: Awaited<ReturnType<typeof fixture>>) => { delete f.snapshots[1].root!.attributes!["debug-observation-component"]; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.snapshots[1].helperObservation!.serviceInstanceId = "10000000-0000-4000-8000-000000000099"; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.snapshots[1].helperObservation!.captureId = f.snapshots[2].helperObservation!.captureId; },
    (f: Awaited<ReturnType<typeof fixture>>) => { cover(f.snapshots[1], { x: 0, y: 0, width: 200, height: 400 }); },
    (f: Awaited<ReturnType<typeof fixture>>) => { cover(f.snapshots[1], { x: 0, y: 0, width: 200, height: 210 }); cover(f.snapshots[2], { x: 0, y: 200, width: 200, height: 200 }); },
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    try { mutate(f); f.save(); assert.equal((await f.result()).verified, null); }
    finally { f.cleanup(); }
  }
});

test("missing or corrupt partial screenshots/trees cannot retain a successful result", async () => {
  for (const index of [1, 2]) for (const kind of ["tree", "screenshot"] as const) {
    const f = await fixture();
    try {
      const artifact = f.report.snapshots[index][kind]!;
      writeFileSync(join(f.directory, artifact.path), "corrupt");
      assert.equal((await f.result()).verified, null, `${index}/${kind}`);
      f.report.snapshots[index][kind] = null; f.saveManifest();
      assert.equal((await f.result()).verified, null, `missing ${index}/${kind}`);
    } finally { f.cleanup(); }
  }
});

test("partial assertion does not relax original tap safety or allow evidence for an implicit condition", async () => {
  for (const kind of ["tap", "resume"] as const) for (const remove of [false, true]) {
    const f = await fixture(kind);
    try {
      if (remove) delete f.report.steps[0].step.resolvedInput;
      else cover(f.snapshots[0], { x: 80, y: 100, width: 40, height: 40 });
      f.save(); const result = await f.result();
      assert.equal(result.verified, null); assert.equal(result.step.dispatchState, "sent");
    } finally { f.cleanup(); }
  }
  const f = await fixture();
  try { delete f.entry.step.input.visibility; f.saveManifest(); await assert.rejects(loadTestReport(f.file)); }
  finally { f.cleanup(); }
});

test("selected partial exports keep both proof trees and screenshots and demote intentionally omitted attachments", async () => {
  for (const kind of ["wait", "tap", "resume"] as const) for (const omission of ["none", "trees", "images"] as const) {
    const f = await fixture(kind);
    try {
      const result = await exportDebugReportEvidence(f.source(), { ...f.request(),
        stepIds: kind === "resume" ? [3, 4] : [3], includeTrees: omission !== "trees",
        includeScreenshots: omission !== "images", includeLogs: false }, f.parent, { appVersion: "0.1.2" });
      assert.equal(result.error, null, `${kind}/${omission}`);
      const file = join(result.directory!, "report.json"), loaded = await loadTestReport(file);
      const report = JSON.parse(readFileSync(file, "utf8")) as DebugSessionReport;
      assert.equal(loaded.debug!.steps.at(-1)!.verified, omission === "none" ? true : false, `${kind}/${omission}`);
      assert.deepEqual(report.steps.at(-1)!.step.assertionConfirmation, f.entry.step.assertionConfirmation);
      assert.equal(report.snapshots.length, 3, "first proof is retained even when neither before nor after references it");
      for (const evidence of report.snapshots) {
        assert.equal(Boolean(evidence.tree), omission !== "trees");
        assert.equal(Boolean(evidence.screenshot), omission !== "images");
      }
    } finally { f.cleanup(); }
  }
});

test("a selected partial resume without its original request remains unverified and never fabricates another input", async () => {
  const f = await fixture("resume");
  try {
    const result = await exportDebugReportEvidence(f.source(), { ...f.request(), stepIds: [4], includeLogs: false },
      f.parent, { appVersion: "0.1.2" });
    assert.equal(result.error, null);
    const loaded = await loadTestReport(join(result.directory!, "report.json"));
    assert.notEqual(loaded.debug!.steps[0].verified, true);
    assert.equal(loaded.debug!.steps[0].step.dispatchState, "sent");
    assert.equal(loaded.debug!.steps[0].step.inputEvidence, undefined);
  } finally { f.cleanup(); }
});

test("partial compound proof cannot reuse its input-before frame or another assertion's observations", async () => {
  const f = await fixture("tap");
  try {
    const before = f.report.snapshots[0], proof = f.entry.step.assertionConfirmation!;
    proof.first = { ...proof.first, snapshotId: before.snapshotId, capturedAt: before.capturedAt };
    f.saveManifest(); await assert.rejects(loadTestReport(f.file), /输入后/);
    proof.first.snapshotId = f.ids[1]; proof.first.capturedAt = before.capturedAt;
    f.report.snapshots[1].capturedAt = before.capturedAt;
    f.save(); await assert.rejects(loadTestReport(f.file), /输入后/);
  } finally { f.cleanup(); }
  const g = await fixture();
  try {
    const duplicate = structuredClone(g.entry); duplicate.step.id = 4;
    g.report.steps.push(duplicate); g.report.session.totalSteps = 4; g.saveManifest();
    await assert.rejects(loadTestReport(g.file), /旧观察/);
  } finally { g.cleanup(); }
});

test("partial proof PNG dimensions must match its actual capture frame", async () => {
  const f = await fixture();
  try {
    const image = await sharp({ create: { width: 4, height: 6, channels: 4, background: "#335577" } }).png().toBuffer();
    f.report.snapshots[1].screenshot = f.artifact(image, "png"); f.saveManifest();
    assert.equal((await f.result()).verified, null);
  } finally { f.cleanup(); }
});

async function taskFixture() {
  const f = await fixture(), { entry } = f;
  const taskId = "00000000-0000-4000-8000-000000000099";
  const check: DebugTaskCheckResult = { taskId, checkpointId: null, stepId: entry.step.id, checkedAt: entry.finishedAt,
    status: "passed", reason: "原始验收通过", observations: structuredClone(entry.step.assertionConfirmation!),
    conditions: [{ conditionId: "ready", status: "passed", reason: "原始条件通过", firstMatchCount: 1,
      secondMatchCount: 1, firstNodeId: "0", secondNodeId: "0" }] };
  entry.step.action = "check_debug_task";
  entry.step.input = { sessionId: f.report.session.id, taskId };
  entry.step.taskCheck = structuredClone(check); delete entry.step.assertionConfirmation;
  entry.step.beforeId = f.ids[1]; entry.before.snapshotId = f.ids[1];
  f.report.task = { id: taskId, definedAt: f.report.session.startedAt, definedStepId: 1,
    definition: { goal: "确认只读页面状态", checkpoints: [], finalConditions: [
      { id: "ready", selector: { text: "READY" }, state: "visible", visibility: "partial" },
    ] }, checks: [check] };
  f.save();
  return { ...f, assess: async () => (await loadTestReport(f.file)).debug!.taskAssessment!.final! };
}

test("partial task conditions use the same two-image and bound-identity evidence as standalone assertions", async () => {
  const f = await taskFixture();
  try { assert.equal((await f.assess()).status, "passed"); }
  finally { f.cleanup(); }
  const mutations = [
    (f: Awaited<ReturnType<typeof taskFixture>>) => { f.report.snapshots[1].screenshot = null; },
    (f: Awaited<ReturnType<typeof taskFixture>>) => { f.report.snapshots[2].tree = null; },
    (f: Awaited<ReturnType<typeof taskFixture>>) => {
      for (const check of [f.report.task!.checks[0], f.entry.step.taskCheck!]) {
        check.observations.first!.windowId = "substituted"; check.observations.second!.windowId = "substituted";
      }
    },
    (f: Awaited<ReturnType<typeof taskFixture>>) => { f.entry.step.time = "2026-10-12T09:00:01.500Z";
      f.entry.before.freshness = "previous"; f.entry.before.reason = "旧帧不能完成当前任务"; },
  ];
  for (const mutate of mutations) {
    const g = await taskFixture();
    try { mutate(g); g.saveManifest();
      if (g.entry.before.freshness === "previous") await assert.rejects(loadTestReport(g.file));
      else assert.equal((await g.assess()).status, "insufficient_evidence");
    } finally { g.cleanup(); }
  }
});

test("partial task export demotes missing PNG proof while ordinary old task semantics stay separate", async () => {
  for (const includeScreenshots of [true, false]) {
    const f = await taskFixture();
    try {
      const result = await exportDebugReportEvidence(f.source(), { ...f.request(), stepIds: [3], includeScreenshots,
        includeLogs: false }, f.parent, { appVersion: "0.1.2" });
      assert.equal(result.error, null);
      const loaded = await loadTestReport(join(result.directory!, "report.json"));
      assert.equal(loaded.debug!.taskAssessment!.final!.status, includeScreenshots ? "passed" : "insufficient_evidence");
      if (!includeScreenshots) assert.equal(loaded.debug!.steps[0].verified, false);
    } finally { f.cleanup(); }
  }
});

test("ordinary legacy wait keeps its old report behavior without partial proof metadata", async () => {
  const f = await fixture();
  try {
    delete f.entry.step.input.visibility; delete f.entry.step.assertionConfirmation;
    f.report.snapshots[1].tree = null; f.report.snapshots[1].screenshot = null; f.saveManifest();
    assert.equal((await f.result()).verified, true);
  } finally { f.cleanup(); }
});
