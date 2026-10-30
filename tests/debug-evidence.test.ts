import assert from "node:assert/strict";
import { createHash, randomFillSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { makeNode } from "../benchmarks/fixtures";
import { DebugEvidenceWriter, type DebugEvidenceObservation } from "../electron/automation/debug-evidence";
import type { McpSnapshot } from "../electron/automation/mcp-snapshot";
import { DEBUG_REPORT_VERSION, DEBUG_SNAPSHOT_VERSION, type DebugLogCapture, type DebugReportStep, type DebugSessionReport } from "../shared/debug-report";
import { isUiSnapshot } from "../shared/snapshot-validation";
import type { DebugSessionState, UiSnapshot } from "../shared/types";
import type { DebugTaskCheckResult } from "../shared/debug-task";
import { loadTestReport } from "../electron/desktop/test-report";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1EAAAAASUVORK5CYII=";
const otherPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
function state(): DebugSessionState {
  return { id: randomUUID(), serial: "fixture-device", packageName: "com.example.fixture", active: true,
    busy: false, expiresAt: new Date(Date.now() + 60_000).toISOString(), steps: [], evidencePath: null, stopReason: null };
}
function observation(session: DebugSessionState, label = "fixture", image: string | null = png): McpSnapshot {
  const root = makeNode("0"); root.package = session.packageName; root.text = label; root.attributes = { hint: "hint", state: "checked" };
  const snapshot: UiSnapshot = { serial: session.serial, root, nodeCount: 1, xmlSize: 0, rawXml: null, screenshotDataUrl: image,
    warning: null, error: null, inspectionSource: "uiautomator", captureMode: "fast" };
  return { id: randomUUID(), sharedAt: new Date().toISOString(), ownerPid: process.pid, selectedNodeId: null, snapshot };
}
const ref = (entry: McpSnapshot | null): DebugEvidenceObservation => ({ entry, freshness: entry ? "current" : "missing", reason: null });
function step(session: DebugSessionState, id: number): DebugReportStep {
  const time = new Date().toISOString();
  return { step: { id, time, action: "capture_ui", input: { sessionId: session.id, mode: "fast", backend: "uiautomator" },
    status: "done", message: "captured", verified: null }, finishedAt: time, durationMs: 1, verified: null,
    before: { snapshotId: null, freshness: "missing", reason: null }, after: { snapshotId: null, freshness: "missing", reason: null } };
}
const readReport = (writer: DebugEvidenceWriter) => JSON.parse(readFileSync(writer.path, "utf8")) as DebugSessionReport;
function storage(directory: string, report: DebugSessionReport, path: string) {
  const files = new Map(report.snapshots.flatMap(snapshot => [snapshot.tree, snapshot.screenshot]
    .filter((file): file is NonNullable<typeof file> => Boolean(file)).map(file => [file.path, file] as const)));
  for (const file of files.values()) {
    assert.match(file.path, /^artifacts\/[a-f0-9]{64}\.(json|png)$/);
    const bytes = readFileSync(join(directory, file.path));
    assert.equal(bytes.length, file.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  const total = statSync(path).size + [...files.values()].reduce((sum, file) => sum + file.size, 0);
  assert.equal(report.storage.bytes, total);
  assert.ok(total <= report.limits.maxBytes);
  return files;
}

function taskProof(session: DebugSessionState, id: number, before: McpSnapshot, after: McpSnapshot, checkpointId: string | null = "stage"): DebugReportStep {
  session.task ??= { id: randomUUID(), definedAt: new Date().toISOString(), definedStepId: 1,
    definition: { goal: "检查页面", checkpoints: [{ id: "stage", title: "阶段", conditions: [{ id: "stage-visible", selector: { text: "完成" }, state: "visible" }] }],
      finalConditions: [{ id: "final-visible", selector: { text: "完成" }, state: "visible" }] }, checks: [] };
  const identity = (entry: McpSnapshot) => ({ snapshotId: entry.id, capturedAt: entry.sharedAt,
    component: `${session.packageName}/.Main`, windowId: "window", activityRecordId: "activity" });
  const check: DebugTaskCheckResult = { taskId: session.task.id, checkpointId, stepId: id, checkedAt: new Date().toISOString(),
    status: "passed", reason: "两次条件通过", observations: { first: identity(before), second: identity(after) },
    conditions: [{ conditionId: checkpointId ? "stage-visible" : "final-visible", status: "passed", reason: "两次条件通过",
      firstMatchCount: 1, secondMatchCount: 1, firstNodeId: "0", secondNodeId: "0" }] };
  session.task.checks = [...session.task.checks.filter(item => item.checkpointId !== checkpointId), structuredClone(check)];
  const record = step(session, id); record.step.action = "check_debug_task";
  record.step.input = { sessionId: session.id, taskId: session.task.id, ...(checkpointId ? { checkpointId } : {}) };
  record.verified = record.step.verified = true; record.step.taskCheck = check;
  session.steps.push(record.step);
  return record;
}

test("optional logs count toward total bytes and are omitted before current Checker proof", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-log-budget-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxBytes: 10000 });
  try {
    const first = observation(session, "完成"), second = observation(session, "完成"), record = taskProof(session, 2, first, second);
    const log: DebugLogCapture = { evidence: { source: "session", sessionId: session.id, stepId: 2, packageName: session.packageName,
      startedAt: record.step.time, finishedAt: record.finishedAt, status: "available", attribution: "confirmed", reason: null,
      truncated: false, lineCount: 1, file: null, androidScope: null }, text: `${"error ".repeat(4000)}\n` };
    assert.deepEqual(writer.record(session, 2, record, ref(first), ref(second), [log]), []);
    const saved = readReport(writer);
    assert.ok(saved.storage.bytes <= saved.limits.maxBytes); assert.equal(saved.steps[0].logs![0].file, null);
    assert.equal(saved.steps[0].logs![0].status, "unavailable"); assert.match(saved.steps[0].logs![0].reason!, /总容量/);
    assert.ok(saved.snapshots.every(evidence => evidence.tree)); assert.equal(saved.task!.checks[0].status, "passed");
    assert.equal(session.task!.checks[0].status, "passed"); assert.equal(record.step.status, "done");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("debug evidence persists verified local trees and separate deduplicated PNG with private permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session);
  try {
    const before = observation(session, "before"), after = observation(session, "after");
    before.snapshot.root!.layerImageDataUrl = "data:image/png;base64,independent-bitmap";
    before.snapshot.root!.layerImageSize = { width: 1, height: 1 };
    before.snapshot.root!.layerCapturePlacement = {} as NonNullable<UiSnapshot["root"]>["layerCapturePlacement"];
    before.snapshot.root!.layerImageEmpty = false; before.snapshot.root!.layerImageStatus = "captured";
    assert.deepEqual(writer.record(session, 1, step(session, 1), ref(before), ref(after)), []);
    const report = readReport(writer), files = storage(directory, report, writer.path);
    assert.equal(report.schemaVersion, DEBUG_REPORT_VERSION);
    assert.equal(report.snapshots.length, 2); assert.equal(files.size, 3);
    assert.equal(report.snapshots[0].screenshot!.path, report.snapshots[1].screenshot!.path);
    const tree = JSON.parse(readFileSync(join(directory, report.snapshots[0].tree!.path), "utf8"));
    assert.equal(tree.schemaVersion, DEBUG_SNAPSHOT_VERSION);
    assert.equal(tree.content, "tree-properties-without-layer-bitmaps");
    assert.equal(tree.snapshotId, before.id); assert.equal(tree.capturedAt, before.sharedAt);
    assert.equal(tree.snapshot.screenshotDataUrl, null);
    assert.deepEqual(tree.snapshot.root.attributes, { hint: "hint", state: "checked" });
    for (const name of ["layerImageDataUrl", "layerImageSize", "layerCapturePlacement", "layerImageEmpty", "layerImageStatus"])
      assert.equal(name in tree.snapshot.root, false);
    assert.ok(isUiSnapshot(tree.snapshot));
    assert.ok(before.snapshot.root!.layerImageDataUrl); // Never mutate the usable live snapshot.
    assert.equal(report.steps[0].step.beforeId, before.id); assert.equal(report.steps[0].step.afterId, after.id);
    if (process.platform !== "win32") {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(join(directory, "artifacts")).mode & 0o777, 0o700);
      for (const path of [writer.path, ...[...files.keys()].map(file => join(directory, file))]) assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    assert.ok(!readdirSync(directory).some(name => name.endsWith(".tmp")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("rolling steps retain referenced before/after and reclaim only this writer's unreferenced artifacts", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-roll-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxSteps: 2, maxSnapshots: 3 });
  try {
    const observations = Array.from({ length: 4 }, (_, index) => observation(session, `page-${index + 1}`));
    writer.record(session, 1, step(session, 1), ref(null), ref(observations[0]));
    const removedTree = readReport(writer).snapshots[0].tree!.path;
    const foreign = join(directory, "artifacts", "foreign.json"); writeFileSync(foreign, "untouched");
    for (let id = 2; id <= 4; id++) writer.record(session, id, step(session, id), ref(observations[id - 2]), ref(observations[id - 1]));
    const report = readReport(writer);
    assert.deepEqual(report.steps.map(item => item.step.id), [3, 4]);
    assert.equal(report.session.totalSteps, 4); assert.equal(report.session.droppedSteps, 2);
    assert.equal(report.snapshots.length, 3); assert.equal(existsSync(join(directory, removedTree)), false);
    assert.equal(readFileSync(foreign, "utf8"), "untouched");
    const files = storage(directory, report, writer.path);
    assert.equal(readdirSync(join(directory, "artifacts")).length, files.size + 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("snapshot, image and byte limits record missing evidence explicitly and count report metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-limits-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxSnapshots: 1, maxImages: 1, maxBytes: 1800 });
  try {
    const before = observation(session, "before"), after = observation(session, "after", otherPng);
    writer.record(session, 1, step(session, 1), ref(before), ref(after));
    const report = readReport(writer);
    assert.equal(report.snapshots.length, 1);
    assert.equal(report.steps[0].before.snapshotId, null); assert.equal(report.steps[0].before.freshness, "missing");
    assert.match(report.steps[0].before.reason!, /上限/); assert.equal(report.steps[0].step.beforeId, undefined);
    assert.ok(report.snapshots[0].warnings.some(warning => warning.includes("容量")));
    storage(directory, report, writer.path);
    assert.equal(report.limits.maxTreeBytes, 2 * 1024 * 1024); assert.equal(report.limits.maxImageBytes, 10 * 1024 * 1024);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("scroll confirmation trimmed by snapshot or tree limits stays readable and unverified", async () => {
  for (const limits of [{ maxSnapshots: 1 }, { maxTreeBytes: 64 }]) {
    const directory = mkdtempSync(join(tmpdir(), "inspector-scroll-evidence-limit-")), session = state();
    const writer = new DebugEvidenceWriter(directory, session, limits);
    try {
      const record = step(session, 1), before = observation(session, "END", null), after = observation(session, "END", null);
      record.step.action = "scroll_until";
      record.step.input = { sessionId: session.id, requestId: randomUUID(), target: { selector: { resourceId: "list" } },
        direction: "down", until: { selector: { text: "END" }, kind: "end_marker" } };
      record.step.dispatchState = "not_sent";
      record.step.scrollTask = { stopReason: "end_reached", iterations: [], observationIds: [before.id, after.id],
        confirmation: { firstSnapshotId: before.id, secondSnapshotId: after.id, kind: "end_marker" } };
      record.verified = record.step.verified = true; record.finishedAt = new Date().toISOString();
      writer.record(session, 1, record, ref(before), ref(after), undefined, [before, after]);
      const saved = readReport(writer);
      assert.equal(saved.steps[0].verified, null); assert.equal(saved.steps[0].step.verified, null);
      assert.equal(saved.steps[0].step.scrollTask!.stopReason, "end_reached");
      const loaded = await loadTestReport(writer.path);
      assert.equal(loaded.debug!.steps[0].verified, null);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

function partialProof(session: DebugSessionState, id = 1) {
  const record = step(session, id), start = Date.parse(record.step.time);
  const make = (offset: number, image = png) => {
    const entry = observation(session, "暂停视频", image);
    entry.sharedAt = new Date(start + offset).toISOString();
    entry.snapshot = helperEvidenceSnapshot({ packageName: session.packageName, serial: session.serial, text: "暂停视频",
      width: 1, height: 1, startedAt: 100 + offset * 100 });
    entry.snapshot.screenshotDataUrl = image;
    Object.assign(entry.snapshot.root!.attributes!, { "debug-observation-component": `${session.packageName}/.Main`,
      "debug-observation-window-id": "window", "debug-observation-activity-record-id": "activity" });
    return entry;
  };
  const before = make(0), first = make(1), second = make(2, otherPng);
  const proof = (entry: McpSnapshot) => ({ snapshotId: entry.id, capturedAt: entry.sharedAt,
    component: `${session.packageName}/.Main`, windowId: "window", activityRecordId: "activity" });
  record.step.action = "wait_for_ui"; record.step.input = { sessionId: session.id, selector: { text: "暂停视频" },
    state: "visible", visibility: "partial", timeoutMs: 1000 };
  record.step.assertionConfirmation = { first: proof(first), second: proof(second) };
  record.step.verified = record.verified = true; record.finishedAt = new Date(start + 3).toISOString();
  session.steps.push(record.step);
  return { record, before, first, second };
}

test("partial assertion writer retains both confirmation frames independently of its input-before and prioritizes the current proof", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-partial-evidence-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxSnapshots: 3 });
  try {
    const old = observation(session, "old"); writer.record(session, 1, step(session, 1), ref(null), ref(old));
    const { record, before, first, second } = partialProof(session, 2);
    assert.deepEqual(writer.record(session, 2, record, ref(before), ref(second), undefined, undefined, [first, second]), []);
    const saved = readReport(writer), current = saved.steps.at(-1)!;
    assert.equal(current.verified, true); assert.equal(record.step.verified, true);
    assert.deepEqual(new Set(saved.snapshots.map(item => item.snapshotId)), new Set([before.id, first.id, second.id]));
    for (const id of [first.id, second.id]) {
      const evidence = saved.snapshots.find(item => item.snapshotId === id)!;
      assert.ok(evidence.tree && evidence.screenshot); assert.equal(evidence.source, "accessibility-helper");
    }
    assert.equal(current.step.assertionConfirmation!.first.snapshotId, first.id);
    assert.equal(current.step.assertionConfirmation!.second.snapshotId, second.id);
    storage(directory, saved, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("partial assertion missing either tree or PNG downgrades saved and live verification within the original quotas", () => {
  for (const limits of [{ maxSnapshots: 1 }, { maxTreeBytes: 64 }, { maxImages: 1 }, { maxBytes: 6500 }]) {
    const directory = mkdtempSync(join(tmpdir(), "inspector-partial-limit-")), session = state();
    const writer = new DebugEvidenceWriter(directory, session, limits);
    try {
      const { record, before, first, second } = partialProof(session);
      writer.record(session, 1, record, ref(before), ref(second), undefined, undefined, [first, second]);
      const saved = readReport(writer), current = saved.steps[0];
      assert.equal(current.verified, null, JSON.stringify(limits)); assert.equal(current.step.verified, null);
      assert.equal(record.step.verified, null); assert.equal(session.steps[0].verified, null);
      assert.equal(current.step.assertionConfirmation!.first.snapshotId, first.id, "missing evidence never invents another confirmation");
      assert.equal(current.step.assertionConfirmation!.second.snapshotId, second.id);
      storage(directory, saved, writer.path);
      writer.saveSession(session, 1); assert.equal(readReport(writer).steps[0].verified, null, "metadata save cannot restore trimmed proof");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test("image count is capped after content deduplication and single-file overflow does not pretend to save a tree", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-image-limit-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxImages: 1, maxTreeBytes: 64 });
  try {
    writer.record(session, 1, step(session, 1), ref(observation(session)), ref(observation(session, "other", otherPng)));
    const report = readReport(writer);
    assert.equal(report.snapshots.filter(item => item.screenshot).length, 1);
    assert.ok(report.snapshots.every(item => !item.tree && item.warnings.some(warning => warning.includes("单文件上限"))));
    assert.ok(report.snapshots.some(item => item.warnings.some(warning => warning.includes("截图数量"))));
    storage(directory, report, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("low image limits retain the newest distinct screenshot, including a hash reused by the newest observation", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-newest-image-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxSteps: 2, maxImages: 1 });
  try {
    const first = observation(session, "first", png), second = observation(session, "second", otherPng);
    writer.record(session, 1, step(session, 1), ref(null), ref(first));
    const firstImage = readReport(writer).snapshots[0].screenshot!.path;
    writer.record(session, 2, step(session, 2), ref(first), ref(second));
    let saved = readReport(writer);
    assert.equal(saved.snapshots.find(item => item.snapshotId === first.id)!.screenshot, null);
    assert.ok(saved.snapshots.find(item => item.snapshotId === second.id)!.screenshot);
    assert.equal(existsSync(join(directory, firstImage)), false);
    const third = observation(session, "third", png);
    writer.record(session, 3, step(session, 3), ref(second), ref(third));
    saved = readReport(writer);
    assert.equal(saved.snapshots.find(item => item.snapshotId === second.id)!.screenshot, null);
    assert.equal(saved.snapshots.find(item => item.snapshotId === third.id)!.screenshot!.path, firstImage);
    assert.ok(existsSync(join(directory, firstImage)));
    assert.ok(saved.snapshots.find(item => item.snapshotId === second.id)!.warnings.some(warning => warning.includes("截图数量")));
    storage(directory, saved, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("low total-byte limits keep the newest tree before screenshots and report the evidence gap", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-newest-bytes-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxBytes: 6000 });
  try {
    const first = observation(session, "first", png), second = observation(session, "second", otherPng);
    for (const entry of [first, second]) entry.snapshot.root!.attributes = { padding: "x".repeat(1200) };
    writer.record(session, 1, step(session, 1), ref(null), ref(first));
    const issues = writer.record(session, 2, step(session, 2), ref(first), ref(second));
    const saved = readReport(writer), old = saved.snapshots.find(item => item.snapshotId === first.id)!, latest = saved.snapshots.find(item => item.snapshotId === second.id)!;
    assert.ok(latest.tree); assert.equal(latest.screenshot, null);
    assert.ok(old.warnings.some(warning => warning.includes("容量")));
    assert.ok(issues.some(error => error.code === "evidence_capacity_exceeded"));
    assert.ok(saved.steps[1].step.recordingErrors?.some(error => error.code === "evidence_capacity_exceeded"));
    assert.equal(saved.steps[1].after.snapshotId, second.id);
    storage(directory, saved, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("evicting an old screenshot does not fail a current input whose before and after evidence fits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-historical-trim-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxImages: 2 });
  try {
    const old = observation(session, "old", png), before = observation(session, "before", otherPng);
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } }).png().toBuffer();
    const after = observation(session, "after", `data:image/png;base64,${bytes.toString("base64")}`);
    writer.record(session, 1, step(session, 1), ref(null), ref(old));
    const record = step(session, 2); record.step.action = "perform_ui_step"; record.step.dispatchState = "sent";
    const issues = writer.record(session, 2, record, ref(before), ref(after));
    const saved = readReport(writer), prior = saved.snapshots.find(item => item.snapshotId === old.id)!;
    assert.deepEqual(issues, []); assert.equal(saved.steps.at(-1)!.step.recordingErrors, undefined);
    assert.equal(prior.screenshot, null); assert.ok(prior.warnings.some(warning => warning.includes("截图数量")));
    for (const entry of [before, after]) {
      const evidence = saved.snapshots.find(item => item.snapshotId === entry.id)!;
      assert.ok(evidence.tree); assert.ok(evidence.screenshot); assert.deepEqual(evidence.warnings, []);
    }
    storage(directory, saved, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const role of ["boundary", "visual", "scroll-input", "scroll-visual", "scroll-confirmation", "task-check"] as const) {
  test(`image pressure still reports a missing current ${role} frame`, () => {
    const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-critical-trim-")), session = state();
    const writer = new DebugEvidenceWriter(directory, session, { maxImages: 1 });
    try {
      const first = observation(session, "first", png), second = observation(session, "second", otherPng);
      writer.record(session, 1, step(session, 1), ref(null), ref(first));
      const record = role === "task-check" ? taskProof(session, 2, first, second) : step(session, 2);
      const resolved = { action: { kind: "tap" as const, x: 1, y: 1 }, frame: { width: 2, height: 2, rotation: 0 as const },
        visualConfirmation: { referenceSnapshotId: first.id, currentSnapshotId: second.id, description: "fixture",
          region: { left: 0, top: 0, width: 1, height: 1 }, sha256: "a".repeat(64), overlapNodeIds: [] } };
      if (role !== "task-check") { record.step.action = "perform_ui_step"; record.step.dispatchState = "sent"; }
      if (role === "visual") record.step.resolvedInput = resolved;
      if (role.startsWith("scroll-")) {
        record.step.action = "scroll_until";
        record.step.scrollTask = { stopReason: "end_reached", observationIds: [first.id, second.id], iterations: [] };
        if (role === "scroll-confirmation") record.step.scrollTask.confirmation = {
          firstSnapshotId: first.id, secondSnapshotId: second.id, kind: "end_marker" };
        else record.step.scrollTask.iterations.push({ index: 1, startedAt: record.step.time, durationMs: 1,
          ...(role === "scroll-input" ? { beforeId: first.id, afterId: second.id } : { resolvedInput: resolved }),
          dispatchState: "sent", progress: "changed" });
      }
      const issues = writer.record(session, 2, record, ref(role === "boundary" ? first : second), ref(second));
      const saved = readReport(writer);
      assert.equal(saved.snapshots.find(item => item.snapshotId === first.id)!.screenshot, null);
      assert.ok(saved.snapshots.find(item => item.snapshotId === second.id)!.screenshot);
      assert.equal(issues.filter(error => error.code === "evidence_capacity_exceeded").length, 1);
      assert.ok(saved.steps.at(-1)!.step.recordingErrors?.some(error => error.code === "evidence_capacity_exceeded"));
      storage(directory, saved, writer.path);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test("failure context outranks historical ordinary captures and a shared PNG keeps its strongest role", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-failure-priority-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxImages: 2 });
  try {
    const failed = observation(session, "failed", png), record = step(session, 1);
    record.step.status = "failed";
    writer.record(session, 1, record, ref(null), ref(failed));
    const shared = observation(session, "shared", png), ordinary = observation(session, "ordinary", otherPng);
    writer.record(session, 2, step(session, 2), ref(shared), ref(ordinary));
    const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } }).png().toBuffer();
    const latest = observation(session, "latest", `data:image/png;base64,${image.toString("base64")}`);
    const issues = writer.record(session, 3, step(session, 3), ref(null), ref(latest));
    const saved = readReport(writer);
    assert.ok(saved.snapshots.find(item => item.snapshotId === failed.id)!.screenshot);
    assert.ok(saved.snapshots.find(item => item.snapshotId === shared.id)!.screenshot);
    assert.ok(saved.snapshots.find(item => item.snapshotId === latest.id)!.screenshot);
    assert.equal(saved.snapshots.find(item => item.snapshotId === ordinary.id)!.screenshot, null);
    assert.deepEqual(issues, []);
    assert.equal(saved.steps.at(-1)!.step.recordingErrors, undefined);
    assert.equal([...storage(directory, saved, writer.path).keys()].filter(path => path.endsWith(".png")).length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an input before frame can restore a previously trimmed PNG and outranks a newer ordinary capture", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-restored-input-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxImages: 1 });
  try {
    const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).png().toBuffer();
    const first = observation(session, "first", `data:image/png;base64,${image.toString("base64")}`), newer = observation(session, "newer", otherPng);
    const initial = step(session, 1); initial.step.time = first.sharedAt;
    writer.record(session, 1, initial, ref(null), ref(first));
    const next = step(session, 2); next.step.time = newer.sharedAt;
    const previous = { entry: first, freshness: "previous" as const, reason: "此前已接受的观察。" };
    writer.record(session, 2, next, previous, ref(newer));
    assert.equal(readReport(writer).snapshots.find(item => item.snapshotId === first.id)!.screenshot, null);
    const record = step(session, 3);
    record.step.action = "tap_node"; record.step.input = { sessionId: session.id, snapshotId: first.id, nodeId: "0" };
    record.step.dispatchState = "sent";
    const after = observation(session, "after", null); record.finishedAt = after.sharedAt;
    writer.record(session, 3, record, previous, ref(after));
    const saved = readReport(writer), restored = saved.snapshots.find(item => item.snapshotId === first.id)!;
    assert.ok(restored.screenshot); assert.equal(restored.warnings.length, 0);
    assert.equal(saved.snapshots.find(item => item.snapshotId === newer.id)!.screenshot, null);
    const loaded = await loadTestReport(writer.path);
    assert.ok(loaded.images[0].dataUrl); assert.equal(loaded.images[0].error, null);
    storage(directory, saved, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the current input boundary takes priority over historical failures even before its input receipt exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-current-boundary-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxImages: 1 });
  try {
    const failed = observation(session, "failure", png), record = step(session, 1);
    record.step.status = "failed"; writer.record(session, 1, record, ref(null), ref(failed));
    const before = observation(session, "current", otherPng), pending = step(session, 2);
    pending.step.action = "tap_node"; pending.step.status = "running"; pending.step.dispatchState = "not_sent";
    pending.step.input = { sessionId: session.id, snapshotId: before.id, nodeId: "0" };
    writer.record(session, 2, pending, ref(before), ref(null));
    const saved = readReport(writer);
    assert.equal(saved.snapshots.find(item => item.snapshotId === failed.id)!.screenshot, null);
    assert.ok(saved.snapshots.find(item => item.snapshotId === before.id)!.screenshot);
    assert.ok(saved.snapshots.every(item => item.tree)); storage(directory, saved, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("ordinary old trees cannot consume the quota ahead of the current input screenshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-current-image-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxBytes: 14_000 });
  try {
    const old = observation(session, "old", png); old.snapshot.root!.attributes = { payload: "x".repeat(8000) };
    writer.record(session, 1, step(session, 1), ref(null), ref(old));
    const bytes = await sharp(randomFillSync(Buffer.alloc(40 * 40 * 3)), { raw: { width: 40, height: 40, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    assert.ok(bytes.length > 4800);
    const current = observation(session, "current", `data:image/png;base64,${bytes.toString("base64")}`), record = step(session, 2);
    record.step.action = "tap_node"; record.step.input = { sessionId: session.id, snapshotId: current.id, nodeId: "0" }; record.step.dispatchState = "sent";
    const issues = writer.record(session, 2, record, ref(current), ref(current));
    const saved = readReport(writer);
    assert.equal(saved.snapshots.find(item => item.snapshotId === old.id)!.tree, null);
    const boundary = saved.snapshots.find(item => item.snapshotId === current.id)!;
    assert.ok(boundary.tree); assert.ok(boundary.screenshot);
    assert.deepEqual(issues, []); assert.equal(saved.steps.at(-1)!.step.recordingErrors, undefined);
    storage(directory, saved, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("restoring trimmed evidence refuses changed content under an existing snapshot identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-restored-identity-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxImages: 1 });
  try {
    const first = observation(session, "first", png), newer = observation(session, "newer", otherPng);
    writer.record(session, 1, step(session, 1), ref(null), ref(first));
    writer.record(session, 2, step(session, 2), ref(first), ref(newer));
    const changed = structuredClone(first); changed.snapshot.screenshotDataUrl = otherPng;
    const record = step(session, 3); record.step.action = "tap_node"; record.step.dispatchState = "sent";
    record.step.input = { sessionId: session.id, snapshotId: first.id, nodeId: "0" };
    const issues = writer.record(session, 3, record, ref(changed), ref(null));
    const saved = readReport(writer), evidence = saved.snapshots.find(item => item.snapshotId === first.id)!;
    assert.equal(evidence.screenshot, null);
    assert.ok(issues.some(error => error.code === "artifact_identity_changed"));
    assert.ok(evidence.warnings.some(warning => warning.includes("内容已变化"))); storage(directory, saved, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("32 MiB prioritizes operation trees, failure and final dual frames with explicit gaps when eleven distinct 3.5 MB PNGs cannot all fit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-real-image-budget-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session);
  try {
    const pixels = randomFillSync(Buffer.alloc(1080 * 1080 * 3));
    const entries: McpSnapshot[] = [];
    for (let index = 0; index < 11; index++) {
      pixels[0] = index;
      const bytes = await sharp(pixels, { raw: { width: 1080, height: 1080, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
      assert.ok(bytes.length > 3_400_000);
      entries.push(observation(session, index >= 9 ? "完成" : `page-${index}`, `data:image/png;base64,${bytes.toString("base64")}`));
    }
    writer.record(session, 1, step(session, 1), ref(null), ref(entries[0]));
    for (let id = 2; id <= 5; id++) {
      const record = step(session, id), before = entries[id * 2 - 3], after = entries[id * 2 - 2];
      record.step.action = "tap_node"; record.step.input = { sessionId: session.id, snapshotId: before.id, nodeId: "0" };
      record.step.dispatchState = "sent";
      if (id === 2) record.step.status = "failed";
      writer.record(session, id, record, ref(before), ref(after));
    }
    const issues = writer.record(session, 6, taskProof(session, 6, entries[9], entries[10]), ref(entries[9]), ref(entries[10]));
    const saved = readReport(writer), files = storage(directory, saved, writer.path);
    assert.equal(saved.limits.maxBytes, 32 * 1024 * 1024);
    assert.equal(saved.snapshots.length, 11);
    assert.equal(saved.snapshots[0].tree, null); assert.ok(saved.snapshots.slice(1).every(item => item.tree));
    assert.equal([...files.keys()].filter(path => path.endsWith(".png")).length, 9);
    assert.equal(saved.snapshots.filter(item => item.screenshot === null).length, 2);
    assert.ok(saved.snapshots.filter(item => !item.screenshot).every(item => item.warnings.some(warning => warning.includes("总容量"))));
    for (const entry of [entries[1], entries[2], entries[9], entries[10]]) assert.ok(saved.snapshots.find(item => item.snapshotId === entry.id)!.screenshot);
    assert.deepEqual(issues, []);
    assert.equal(saved.steps.at(-1)!.step.recordingErrors, undefined);
    assert.equal(saved.task!.checks[0].status, "passed");
    const beforeSave = readFileSync(writer.path);
    writer.saveSession(session, 6);
    const retained = readReport(writer);
    assert.equal(retained.storage.bytes, saved.storage.bytes);
    assert.equal([...storage(directory, retained, writer.path).keys()].length, files.size);
    assert.ok(beforeSave.length > 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a shared PNG is retained by its newest use when another distinct image appears between uses", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-shared-newest-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxImages: 1 });
  try {
    const first = observation(session, "first", png);
    writer.record(session, 1, step(session, 1), ref(null), ref(first));
    const middle = observation(session, "middle", otherPng), latest = observation(session, "latest", png);
    writer.record(session, 2, step(session, 2), ref(middle), ref(latest));
    const saved = readReport(writer), latestImage = saved.snapshots.find(item => item.snapshotId === latest.id)!.screenshot;
    assert.ok(latestImage);
    assert.equal(saved.snapshots.find(item => item.snapshotId === first.id)!.screenshot!.path, latestImage.path);
    assert.equal(saved.snapshots.find(item => item.snapshotId === middle.id)!.screenshot, null);
    assert.equal([...storage(directory, saved, writer.path).keys()].filter(path => path.endsWith(".png")).length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("missing, invalid and oversized screenshots are separate warnings without inventing image evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-missing-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxImageBytes: 64 });
  try {
    const values = [null, "data:image/jpeg;base64,aGVsbG8=", png];
    for (let id = 1; id <= values.length; id++) writer.record(session, id, step(session, id), ref(null), ref(observation(session, `page-${id}`, values[id - 1])));
    const report = readReport(writer);
    assert.ok(report.snapshots.every(item => item.screenshot === null && item.tree));
    assert.match(report.snapshots[0].warnings.join(), /没有屏幕截图/);
    assert.match(report.snapshots[1].warnings.join(), /PNG编码/);
    assert.match(report.snapshots[2].warnings.join(), /单文件上限/);
    storage(directory, report, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an atomic report write failure retains committed evidence and rolls back new owned orphan artifacts", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-atomic-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session);
  try {
    const first = observation(session);
    writer.record(session, 1, step(session, 1), ref(null), ref(first));
    const original = readFileSync(writer.path), names = readdirSync(join(directory, "artifacts")).sort();
    renameSync(writer.path, `${writer.path}.old`); mkdirSync(writer.path);
    assert.throws(() => writer.record(session, 2, step(session, 2), ref(first), ref(observation(session, "new", otherPng))));
    assert.deepEqual(readdirSync(join(directory, "artifacts")).sort(), names);
    assert.equal(readFileSync(`${writer.path}.old`).toString(), original.toString());
    assert.ok(!readdirSync(directory).some(name => name.endsWith(".tmp")));
    rmSync(writer.path, { recursive: true }); renameSync(`${writer.path}.old`, writer.path);
    session.active = false; session.stopReason = "stopped"; writer.saveSession(session, 2);
    const recovered = readReport(writer); assert.equal(recovered.session.active, false); assert.equal(recovered.session.stopReason, "stopped");
    assert.ok(recovered.snapshots.some(item => item.warnings.some(warning => warning.includes("报告写入失败"))));
    storage(directory, recovered, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("cleanup refuses to remove a foreign replacement of an owned artifact and records that failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-owned-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxSteps: 1 });
  try {
    writer.record(session, 1, step(session, 1), ref(null), ref(observation(session)));
    const oldTree = join(directory, readReport(writer).snapshots[0].tree!.path);
    renameSync(oldTree, `${oldTree}.foreign-backup`); writeFileSync(oldTree, "foreign replacement");
    const errors = writer.record(session, 2, step(session, 2), ref(null), ref(observation(session, "new")));
    assert.equal(readFileSync(oldTree, "utf8"), "foreign replacement");
    assert.ok(errors.some(error => error.code === "artifact_cleanup_failed"));
    assert.ok(readReport(writer).steps[0].step.recordingErrors?.some(error => error.code === "artifact_cleanup_failed"));
    storage(directory, readReport(writer), writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("current checkpoint trees outlive rolling steps and take priority within the snapshot limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-task-proof-roll-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxSteps: 2, maxSnapshots: 3 });
  try {
    const first = observation(session, "完成"), second = observation(session, "完成");
    writer.record(session, 2, taskProof(session, 2, first, second), ref(first), ref(second));
    let previous = second;
    for (let id = 3; id <= 6; id++) {
      const next = observation(session, `page-${id}`); writer.record(session, id, step(session, id), ref(previous), ref(next)); previous = next;
    }
    const report = readReport(writer);
    assert.equal(report.steps.length, 2); assert.ok(report.steps.every(item => item.step.id > 2));
    assert.equal(report.task!.checks[0].status, "passed"); assert.equal(report.snapshots.length, 3);
    for (const entry of [first, second]) assert.ok(report.snapshots.find(item => item.snapshotId === entry.id)!.tree);
    assert.ok(report.snapshots.find(item => item.snapshotId === previous.id));
    assert.deepEqual(report.task, session.task); storage(directory, report, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("byte pressure discards unprotected capture trees before current checkpoint proof", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-task-proof-bytes-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxSteps: 2, maxBytes: 16_000 });
  try {
    const first = observation(session, "完成"), second = observation(session, "完成");
    writer.record(session, 2, taskProof(session, 2, first, second), ref(first), ref(second));
    const large = observation(session, "large"); large.snapshot.root!.attributes = { large: "x".repeat(32_000) };
    writer.record(session, 3, step(session, 3), ref(second), ref(large));
    const report = readReport(writer);
    assert.equal(report.task!.checks[0].status, "passed");
    assert.ok(report.snapshots.find(item => item.snapshotId === first.id)!.tree);
    assert.ok(report.snapshots.find(item => item.snapshotId === second.id)!.tree);
    assert.equal(report.snapshots.find(item => item.snapshotId === large.id)!.tree, null);
    assert.ok(report.snapshots.find(item => item.snapshotId === large.id)!.warnings.some(warning => warning.includes("容量")));
    storage(directory, report, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an impossible snapshot limit removes dangling task references and downgrades all live and saved result copies", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-task-proof-limit-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxSnapshots: 1 });
  try {
    const first = observation(session, "完成"), second = observation(session, "完成"), record = taskProof(session, 2, first, second);
    writer.record(session, 2, record, ref(first), ref(second));
    const report = readReport(writer), check = report.task!.checks[0];
    assert.equal(report.snapshots.length, 1); assert.equal(check.status, "insufficient_evidence");
    assert.equal(check.observations.first, null); assert.ok(check.observations.second);
    assert.equal(report.steps[0].before.freshness, "missing"); assert.equal(report.steps[0].before.snapshotId, null);
    assert.equal(record.step.verified, false); assert.equal(session.steps[0].verified, false); assert.equal(report.steps[0].verified, false);
    assert.deepEqual(record.step.taskCheck, check); assert.deepEqual(session.task!.checks[0], check);
    assert.deepEqual(report.steps[0].step.taskCheck, check); storage(directory, report, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("when even protected trees exceed total capacity their check becomes insufficient without raising the quota", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-task-proof-overflow-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxBytes: 8000 });
  try {
    const first = observation(session, "完成"), second = observation(session, "完成");
    for (const entry of [first, second]) entry.snapshot.root!.attributes = { large: "x".repeat(6000) };
    const record = taskProof(session, 2, first, second); writer.record(session, 2, record, ref(first), ref(second));
    const report = readReport(writer);
    assert.equal(report.limits.maxBytes, 8000); assert.equal(report.task!.checks[0].status, "insufficient_evidence");
    assert.equal(record.step.verified, false); assert.ok(report.snapshots.some(item => item.tree === null));
    assert.deepEqual(report.steps[0].step.taskCheck, report.task!.checks[0]); storage(directory, report, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("atomic task metadata failure keeps committed phase proof, rolls back new assets and cannot return a final pass", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-task-proof-atomic-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session);
  try {
    const first = observation(session, "完成"), second = observation(session, "完成");
    writer.record(session, 2, taskProof(session, 2, first, second), ref(first), ref(second));
    const committed = readFileSync(writer.path), files = readdirSync(join(directory, "artifacts")).sort();
    renameSync(writer.path, `${writer.path}.old`); mkdirSync(writer.path);
    const nextFirst = observation(session, "完成"), nextSecond = observation(session, "完成"), final = taskProof(session, 3, nextFirst, nextSecond, null);
    assert.throws(() => writer.record(session, 3, final, ref(nextFirst), ref(nextSecond)));
    assert.equal(final.step.verified, false); assert.equal(final.step.taskCheck!.status, "insufficient_evidence");
    assert.equal(session.task!.checks[0].status, "passed"); assert.equal(session.task!.checks[1].status, "insufficient_evidence");
    assert.deepEqual(readdirSync(join(directory, "artifacts")).sort(), files);
    assert.equal(readFileSync(`${writer.path}.old`).toString(), committed.toString());
    rmSync(writer.path, { recursive: true }); renameSync(`${writer.path}.old`, writer.path);
    session.active = false; session.stopReason = "stopped"; writer.saveSession(session, 3);
    const recovered = readReport(writer);
    assert.equal(recovered.task!.checks[1].status, "insufficient_evidence"); storage(directory, recovered, writer.path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
