import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { DebugEvidenceWriter, type DebugEvidenceObservation } from "../electron/automation/debug-evidence";
import type { McpSnapshot } from "../electron/automation/mcp-snapshot";
import { DEBUG_REPORT_VERSION, DEBUG_SNAPSHOT_VERSION, type DebugLogCapture, type DebugReportStep, type DebugSessionReport } from "../shared/debug-report";
import { isUiSnapshot } from "../shared/snapshot-validation";
import type { DebugSessionState, UiSnapshot } from "../shared/types";
import type { DebugTaskCheckResult } from "../shared/debug-task";
import { loadTestReport } from "../electron/desktop/test-report";

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

test("low total-byte limits discard older evidence before the newest screenshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-evidence-newest-bytes-")), session = state();
  const writer = new DebugEvidenceWriter(directory, session, { maxBytes: 3200 });
  try {
    const first = observation(session, "first", png), second = observation(session, "second", otherPng);
    writer.record(session, 1, step(session, 1), ref(null), ref(first));
    writer.record(session, 2, step(session, 2), ref(first), ref(second));
    const saved = readReport(writer), old = saved.snapshots.find(item => item.snapshotId === first.id)!, latest = saved.snapshots.find(item => item.snapshotId === second.id)!;
    assert.ok(latest.screenshot); assert.ok(old.warnings.some(warning => warning.includes("容量")));
    assert.equal(saved.steps[1].after.snapshotId, second.id);
    storage(directory, saved, writer.path);
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
