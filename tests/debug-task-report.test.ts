import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession } from "../electron/automation/debug-session";
import { DebugEvidenceWriter } from "../electron/automation/debug-evidence";
import type { McpSnapshot } from "../electron/automation/mcp-snapshot";
import { loadTestReport } from "../electron/desktop/test-report";
import { DEBUG_REPORT_VERSION, DEBUG_SNAPSHOT_VERSION, LEGACY_DEBUG_REPORT_VERSION, type DebugSessionReport, type DebugSnapshotDocument } from "../shared/debug-report";
import type { DebugTaskCheckResult, DebugTaskCondition, DebugTaskDefinition, DebugTaskObservation } from "../shared/debug-task";
import type { DebugSessionState } from "../shared/types";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const at = (milliseconds: number) => new Date(Date.UTC(2026, 9, 11, 9) + milliseconds).toISOString();
const condition = (id: string): DebugTaskCondition => ({ id, selector: { text: "READY" }, state: "visible" });
const definition = (): DebugTaskDefinition => ({ goal: "固定条件检查", checkpoints: [], finalConditions: [condition("ready")] });

function fixture(taskDefinition = definition()) {
  const directory = mkdtempSync(join(tmpdir(), "inspector-task-report-"));
  mkdirSync(join(directory, "artifacts"));
  const taskId = uuid(2), sessionId = uuid(1), packageName = "com.example.benchmark";
  const missing = { snapshotId: null, freshness: "missing" as const, reason: "此步骤没有观察" };
  const report: DebugSessionReport = { schemaVersion: DEBUG_REPORT_VERSION,
    session: { id: sessionId, serial: "offline-task", packageName, startedAt: at(0), updatedAt: at(20), active: false,
      stopReason: "本地测试结束", totalSteps: 1, droppedSteps: 0 },
    limits: { maxSteps: 100, maxSnapshots: 200, maxImages: 100, maxBytes: 32 * 1024 * 1024,
      maxTreeBytes: 2 * 1024 * 1024, maxImageBytes: 10 * 1024 * 1024 }, storage: { bytes: 0 }, snapshots: [],
    steps: [{ step: { id: 1, time: at(0), action: "define_debug_task", input: { sessionId, definition: structuredClone(taskDefinition) },
      status: "done", message: "固定验收条件已定义", verified: null }, finishedAt: at(10), durationMs: 10, verified: null, before: missing, after: missing }],
    task: { id: taskId, definedAt: at(0), definedStepId: 1, definition: structuredClone(taskDefinition), checks: [] },
  };
  let snapshotSequence = 100;
  const trees = new Map<string, DebugSnapshotDocument>();
  const file = join(directory, "report.json");
  const artifact = (bytes: Buffer, extension: "json" | "png") => {
    const sha256 = createHash("sha256").update(bytes).digest("hex"), path = `artifacts/${sha256}.${extension}`;
    writeFileSync(join(directory, path), bytes);
    return { path, sha256, size: bytes.length };
  };
  const save = () => writeFileSync(file, JSON.stringify(report));
  const replaceTree = (snapshotId: string) => {
    report.snapshots.find(item => item.snapshotId === snapshotId)!.tree = artifact(Buffer.from(JSON.stringify(trees.get(snapshotId)!)), "json"); save();
  };
  const observation = (milliseconds: number): DebugTaskObservation => {
    const snapshotId = uuid(snapshotSequence++), root = makeNode("0"), button = makeNode("0/0", 1);
    root.text = "ROOT"; root.children = [button]; root.bounds = { left: 0, top: 0, right: 360, bottom: 640, raw: "[0,0][360,640]" };
    button.text = "READY"; button.bounds = { left: 20, top: 40, right: 160, bottom: 80, raw: "[20,40][160,80]" };
    const frame = { width: 360, height: 640, rotation: 0 as const };
    const tree: DebugSnapshotDocument = { schemaVersion: DEBUG_SNAPSHOT_VERSION, snapshotId, capturedAt: at(milliseconds),
      content: "tree-properties-without-layer-bitmaps", snapshot: { serial: report.session.serial, root, nodeCount: 2, xmlSize: 0,
        rawXml: null, screenshotDataUrl: null, error: null, warning: null, inspectionSource: "uiautomator", captureMode: "fast", hierarchyDumpMode: "full",
        captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } } };
    trees.set(snapshotId, tree);
    report.snapshots.push({ snapshotId, capturedAt: tree.capturedAt, source: "uiautomator", tree: artifact(Buffer.from(JSON.stringify(tree)), "json"), screenshot: null, warnings: [] });
    return { snapshotId, capturedAt: tree.capturedAt, component: `${packageName}/.Main`, windowId: "task-window", activityRecordId: "activity-1" };
  };
  const addCheck = (checkpointId: string | null = null, status: DebugTaskCheckResult["status"] = "passed") => {
    const stepId = report.session.totalSteps + 1, start = stepId * 1000;
    const conditions = checkpointId === null ? report.task!.definition.finalConditions
      : report.task!.definition.checkpoints.find(checkpoint => checkpoint.id === checkpointId)!.conditions;
    const first = observation(start + 100), second = observation(start + 500);
    const check: DebugTaskCheckResult = { taskId, checkpointId, stepId, checkedAt: at(start + 600), status, reason: "原始固定条件记录",
      observations: { first, second }, conditions: conditions.map(item => ({ conditionId: item.id, status, reason: "原始条件记录",
        firstMatchCount: 1, secondMatchCount: 1, firstNodeId: "0/0", secondNodeId: "0/0" })) };
    const reference = (value: DebugTaskObservation) => ({ snapshotId: value.snapshotId, freshness: "current" as const, reason: null });
    report.steps.push({ step: { id: stepId, time: at(start), action: "check_debug_task",
      input: { sessionId, taskId, ...(checkpointId === null ? {} : { checkpointId }) }, status: "done", message: "验收记录", verified: status === "passed",
      taskCheck: structuredClone(check), beforeId: first.snapshotId, afterId: second.snapshotId }, finishedAt: at(start + 700), durationMs: 700,
      verified: status === "passed", before: reference(first), after: reference(second) });
    report.task!.checks = report.task!.checks.filter(item => item.checkpointId !== checkpointId).concat(check);
    report.task!.checks.sort((a, b) => (a.checkpointId === null ? 99 : taskDefinition.checkpoints.findIndex(item => item.id === a.checkpointId))
      - (b.checkpointId === null ? 99 : taskDefinition.checkpoints.findIndex(item => item.id === b.checkpointId)));
    report.session.totalSteps = stepId; report.session.updatedAt = at(start + 800); save();
    return check;
  };
  const syncCheck = (check: DebugTaskCheckResult) => {
    const entry = report.steps.find(item => item.step.id === check.stepId);
    if (entry) { entry.step.taskCheck = structuredClone(check); entry.verified = check.status === "passed"; entry.step.verified = entry.verified; }
    save();
  };
  save();
  return { directory, file, report, trees, observation, artifact, replaceTree, addCheck, syncCheck, save,
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("v1 remains readable but cannot smuggle task definitions, task checks, or v2 actions", async () => {
  const f = fixture();
  try {
    f.report.schemaVersion = LEGACY_DEBUG_REPORT_VERSION; delete f.report.task;
    f.report.steps[0].step.action = "capture_ui"; f.report.steps[0].step.input = { sessionId: f.report.session.id, mode: "fast", backend: "uiautomator" }; f.save();
    const original = structuredClone(f.report), loaded = await loadTestReport(f.file);
    assert.equal(loaded.index.run.runner.version, LEGACY_DEBUG_REPORT_VERSION); assert.equal(loaded.debug!.task, null);
    assert.equal(loaded.debug!.taskAssessment, undefined);
    for (const mutation of [
      () => { f.report.task = null; },
      () => { f.report.steps[0].step.action = "define_debug_task"; },
      () => { f.report.steps[0].step.taskCheck = {} as DebugTaskCheckResult; },
    ]) { Object.assign(f.report, structuredClone(original)); delete f.report.task; mutation(); f.save(); await assert.rejects(loadTestReport(f.file)); }
  } finally { f.cleanup(); }
});

test("v2 task verification derives its own result without changing the whole recording status or source bytes", async () => {
  const f = fixture();
  try {
    const check = f.addCheck(), original = readFileSync(f.file);
    const loaded = await loadTestReport(f.file);
    assert.deepEqual(loaded.debug!.task, f.report.task);
    assert.equal(loaded.debug!.taskAssessment!.final!.status, "passed");
    assert.equal(loaded.debug!.taskAssessment!.checks[0].recorded.stepId, check.stepId);
    assert.equal(loaded.index.run.status, "recorded"); assert.equal(loaded.index.run.exitCode, null);
    assert.equal(loaded.index.cases[0].attempts[0].steps[1].status, "passed");
    assert.deepEqual(readFileSync(f.file), original);
    f.report.session.active = true; f.save();
    assert.equal((await loadTestReport(f.file)).index.run.status, "recording");
  } finally { f.cleanup(); }
});

test("a task without a final check has no derived final verdict", async () => {
  const f = fixture();
  try { const loaded = await loadTestReport(f.file); assert.equal(loaded.debug!.taskAssessment!.final, null); assert.deepEqual(loaded.debug!.taskAssessment!.checks, []); }
  finally { f.cleanup(); }
});

test("fabricated passed flags and match counts cannot override two saved trees", async () => {
  const f = fixture();
  try {
    const check = f.addCheck(); check.conditions[0].firstMatchCount = check.conditions[0].secondMatchCount = 123; f.syncCheck(check);
    let loaded = await loadTestReport(f.file);
    assert.equal(loaded.debug!.taskAssessment!.final!.conditions[0].firstMatchCount, 1);
    for (const observation of [check.observations.first!, check.observations.second!]) {
      f.trees.get(observation.snapshotId)!.snapshot.root!.children[0].text = "NOT READY"; f.replaceTree(observation.snapshotId);
    }
    loaded = await loadTestReport(f.file);
    assert.equal(loaded.debug!.task!.checks[0].status, "passed");
    assert.equal(loaded.debug!.taskAssessment!.final!.status, "failed");
    assert.equal(loaded.index.cases[0].attempts[0].steps[1].status, "completed");
    assert.equal(loaded.index.run.status, "recorded");
  } finally { f.cleanup(); }
});

test("missing, omitted, corrupt or oversized trees make a recorded pass insufficient, never a condition failure", async () => {
  for (const kind of ["missing", "omitted", "corrupt", "limit"] as const) {
    const f = fixture();
    try {
      const check = f.addCheck(), first = f.report.snapshots.find(item => item.snapshotId === check.observations.first!.snapshotId)!;
      if (kind === "missing") rmSync(join(f.directory, first.tree!.path));
      if (kind === "omitted") first.tree = null;
      if (kind === "corrupt") writeFileSync(join(f.directory, first.tree!.path), "changed");
      if (kind === "limit") f.report.limits.maxTreeBytes = 1;
      f.save(); const loaded = await loadTestReport(f.file);
      assert.equal(loaded.debug!.task!.checks[0].status, "passed");
      assert.equal(loaded.debug!.taskAssessment!.final!.status, "insufficient_evidence");
      assert.equal(loaded.debug!.taskAssessment!.final!.conditions[0].status, "insufficient_evidence");
      assert.notEqual(loaded.index.cases[0].attempts[0].steps[1].status, "passed");
    } finally { f.cleanup(); }
  }
});

test("task proofs past the 16MiB aggregate tree loading budget remain insufficient", async () => {
  const f = fixture();
  try {
    f.addCheck(); const proofs = [...f.report.snapshots];
    for (let index = 0; index < 8; index++) {
      const observed = f.observation(100 + index), tree = f.trees.get(observed.snapshotId)!;
      tree.snapshot.rawXml = "x".repeat(2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(tree)) - 40); f.replaceTree(observed.snapshotId);
    }
    f.report.snapshots = [...f.report.snapshots.slice(2), ...proofs]; f.save();
    const loaded = await loadTestReport(f.file);
    assert.equal(loaded.debug!.taskAssessment!.final!.status, "insufficient_evidence");
    assert.ok(loaded.debug!.snapshots.filter(item => proofs.some(proof => proof.snapshotId === item.evidence.snapshotId)).every(item => item.treeError));
  } finally { f.cleanup(); }
});

test("missing PNG evidence does not invalidate valid tree conditions", async () => {
  const f = fixture();
  try {
    f.addCheck(); f.report.snapshots[0].screenshot = f.artifact(Buffer.from("invalid png"), "png"); f.save();
    rmSync(join(f.directory, f.report.snapshots[0].screenshot!.path));
    const loaded = await loadTestReport(f.file);
    assert.equal(loaded.debug!.taskAssessment!.final!.status, "passed"); assert.ok(loaded.images[0].error);
  } finally { f.cleanup(); }
});

test("changed page metadata, unstable conditions and compressed absence cannot establish a pass", async () => {
  const f = fixture();
  try {
    const check = f.addCheck(); check.observations.second!.windowId = "different-window"; f.syncCheck(check);
    assert.equal((await loadTestReport(f.file)).debug!.taskAssessment!.final!.status, "insufficient_evidence");
    check.observations.second!.windowId = check.observations.first!.windowId; f.syncCheck(check);
    const second = f.trees.get(check.observations.second!.snapshotId)!;
    second.snapshot.root!.children[0].text = "NOT READY"; f.replaceTree(second.snapshotId);
    assert.equal((await loadTestReport(f.file)).debug!.taskAssessment!.final!.status, "insufficient_evidence");
    f.report.task!.definition.finalConditions[0].state = "absent";
    (f.report.steps[0].step.input.definition as DebugTaskDefinition).finalConditions[0].state = "absent";
    for (const observation of [check.observations.first!, check.observations.second!]) {
      const tree = f.trees.get(observation.snapshotId)!; tree.snapshot.hierarchyDumpMode = "compressed"; f.replaceTree(observation.snapshotId);
    }
    f.save(); assert.equal((await loadTestReport(f.file)).debug!.taskAssessment!.final!.status, "insufficient_evidence");
  } finally { f.cleanup(); }
});

test("task identity, definitions, fixed conditions, observations, timestamps and step references reject substitution", async () => {
  const mutations: Array<(f: ReturnType<typeof fixture>, check: DebugTaskCheckResult) => void> = [
    f => { f.report.task!.id = uuid(99); },
    f => { f.report.task!.definition.finalConditions[0].selector.text = "OTHER"; },
    f => { f.report.task!.definedAt = at(1); },
    (_f, check) => { check.conditions[0].conditionId = "another-condition"; },
    (_f, check) => { check.conditions.push(structuredClone(check.conditions[0])); },
    (_f, check) => { check.taskId = uuid(99); },
    (_f, check) => { check.checkpointId = "unknown-phase"; },
    (_f, check) => { check.observations.first!.snapshotId = uuid(999); },
    (_f, check) => { check.observations.first!.capturedAt = at(2101); },
    (_f, check) => { check.observations.second!.snapshotId = check.observations.first!.snapshotId; },
    (_f, check) => { check.checkedAt = at(1999); },
    f => { f.report.steps[1].before.freshness = "previous"; f.report.steps[1].before.reason = "旧页"; },
    f => { f.report.steps[1].step.beforeId = uuid(999); },
    (_f, check) => { check.status = "passed"; check.conditions[0].status = "failed"; },
    f => { f.report.steps[1].step.action = "capture_ui"; f.report.steps[1].step.input = { sessionId: f.report.session.id }; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    try { const check = f.addCheck(); mutate(f, check); f.syncCheck(check); await assert.rejects(loadTestReport(f.file)); }
    finally { f.cleanup(); }
  }
});

test("latest results cannot conflict with visible step records or bypass the six-result bound", async () => {
  const f = fixture();
  try {
    f.addCheck(); f.report.steps[1].step.taskCheck!.reason = "different record"; f.save(); await assert.rejects(loadTestReport(f.file), /不一致/);
    f.report.steps[1].step.taskCheck = structuredClone(f.report.task!.checks[0]);
    f.report.task!.checks = Array.from({ length: 7 }, () => structuredClone(f.report.task!.checks[0])); f.save(); await assert.rejects(loadTestReport(f.file));
  } finally { f.cleanup(); }
});

test("different check steps cannot reuse earlier observations even when timestamps are rewritten to overlap", async () => {
  const f = fixture();
  try {
    const first = f.addCheck(), later = f.addCheck();
    later.observations = structuredClone(first.observations);
    const entry = f.report.steps[2]; entry.step.time = f.report.steps[1].step.time;
    entry.before.snapshotId = entry.step.beforeId = first.observations.first!.snapshotId;
    entry.after.snapshotId = entry.step.afterId = first.observations.second!.snapshotId;
    f.syncCheck(later); await assert.rejects(loadTestReport(f.file), /复用/);
  } finally { f.cleanup(); }
});

test("task definition and condition limits are enforced by the native loader", async () => {
  const f = fixture();
  try {
    f.report.task!.definition.checkpoints = Array.from({ length: 6 }, (_, index) => ({ id: `phase-${index}`, title: "阶段", conditions: [condition(`phase-condition-${index}`)] }));
    f.save(); await assert.rejects(loadTestReport(f.file));
    f.report.task!.definition.checkpoints = Array.from({ length: 2 }, (_, index) => ({ id: `phase-${index}`, title: "阶段",
      conditions: Array.from({ length: 10 }, (_v, offset) => condition(`phase-condition-${index}-${offset}`)) }));
    f.save(); await assert.rejects(loadTestReport(f.file));
  } finally { f.cleanup(); }
});

test("ordered checkpoint proofs are required even when the final trees satisfy every final condition", async () => {
  const staged: DebugTaskDefinition = { goal: "先完成阶段", checkpoints: [{ id: "first", title: "第一阶段", conditions: [condition("phase-ready")] }], finalConditions: [condition("ready")] };
  const f = fixture(staged);
  try {
    const phase = f.addCheck("first"), final = f.addCheck();
    let loaded = await loadTestReport(f.file); assert.equal(loaded.debug!.taskAssessment!.final!.status, "passed");
    rmSync(join(f.directory, f.report.snapshots.find(item => item.snapshotId === phase.observations.first!.snapshotId)!.tree!.path));
    loaded = await loadTestReport(f.file);
    assert.equal(loaded.debug!.taskAssessment!.final!.status, "insufficient_evidence");
    assert.equal(loaded.debug!.taskAssessment!.checks.find(item => item.recorded.stepId === final.stepId)!.effective.status, "insufficient_evidence");
    assert.equal(loaded.index.cases[0].attempts[0].steps[2].status, "completed");
  } finally { f.cleanup(); }
  const skipped = fixture(staged);
  try { skipped.addCheck(); const loaded = await loadTestReport(skipped.file); assert.equal(loaded.debug!.taskAssessment!.final!.status, "insufficient_evidence"); }
  finally { skipped.cleanup(); }
});

test("later checkpoint observations cannot be borrowed for an earlier final check", async () => {
  const f = fixture({ goal: "阶段顺序", checkpoints: [{ id: "first", title: "第一阶段", conditions: [condition("phase-ready")] }], finalConditions: [condition("ready")] });
  try {
    const final = f.addCheck(), laterPhase = f.addCheck("first");
    f.report.task!.checks = [final]; f.save();
    const loaded = await loadTestReport(f.file);
    assert.equal(loaded.debug!.taskAssessment!.checks.find(item => item.recorded.stepId === laterPhase.stepId)!.effective.status, "passed");
    assert.equal(loaded.debug!.taskAssessment!.checks.find(item => item.recorded.stepId === final.stepId)!.effective.status, "insufficient_evidence");
    assert.equal(loaded.debug!.taskAssessment!.final!.status, "insufficient_evidence");
  } finally { f.cleanup(); }
});

test("the latest final verdict and its step cannot borrow a historical checkpoint absent from the latest task proofs", async () => {
  const f = fixture({ goal: "当前阶段证明", checkpoints: [{ id: "first", title: "第一阶段", conditions: [condition("phase-ready")] }], finalConditions: [condition("ready")] });
  try {
    f.addCheck("first"); const final = f.addCheck(); f.report.task!.checks = [final]; f.save();
    const loaded = await loadTestReport(f.file);
    assert.equal(loaded.debug!.taskAssessment!.final!.status, "insufficient_evidence");
    assert.equal(loaded.debug!.taskAssessment!.checks.find(item => item.recorded.stepId === final.stepId)!.effective.status, "insufficient_evidence");
    assert.equal(loaded.index.cases[0].attempts[0].steps[2].status, "completed");
  } finally { f.cleanup(); }
});

test("historical checks are derived independently and rechecking a checkpoint invalidates subsequent phase prerequisites", async () => {
  const f = fixture({ goal: "重验阶段", checkpoints: [
    { id: "first", title: "第一阶段", conditions: [condition("phase-1")] }, { id: "second", title: "第二阶段", conditions: [condition("phase-2")] },
  ], finalConditions: [condition("ready")] });
  try {
    f.addCheck("first"); f.addCheck("second"); const originalFinal = f.addCheck();
    const retry = f.addCheck("first", "failed");
    for (const observation of [retry.observations.first!, retry.observations.second!]) {
      f.trees.get(observation.snapshotId)!.snapshot.root!.children[0].text = "NOT READY"; f.replaceTree(observation.snapshotId);
    }
    const retryFinal = f.addCheck(); f.report.task!.checks = [retry, retryFinal]; f.save();
    const loaded = await loadTestReport(f.file), assessments = loaded.debug!.taskAssessment!;
    assert.equal(assessments.checks.find(item => item.recorded.stepId === originalFinal.stepId)!.effective.status, "passed");
    assert.equal(assessments.checks.find(item => item.recorded.stepId === retry.stepId)!.effective.status, "failed");
    assert.equal(assessments.checks.find(item => item.recorded.stepId === retryFinal.stepId)!.effective.status, "insufficient_evidence");
    assert.equal(assessments.final!.status, "insufficient_evidence");
  } finally { f.cleanup(); }
});

test("rolling past definition and check steps retains independent task proofs; missing old trees still downgrade", async () => {
  const f = fixture();
  try {
    const check = f.addCheck();
    f.report.steps = Array.from({ length: 100 }, (_, index) => {
      const stepId = index + 3;
      return { step: { id: stepId, time: at(stepId * 1000), action: "capture_ui", input: { sessionId: f.report.session.id, mode: "fast", backend: "uiautomator" }, status: "done" as const, message: "后续只读观察" },
        finishedAt: at(stepId * 1000 + 1), durationMs: 1, verified: null,
        before: { snapshotId: null, freshness: "missing" as const, reason: "无独立观察" }, after: { snapshotId: null, freshness: "missing" as const, reason: "无独立观察" } };
    });
    f.report.session.totalSteps = 102; f.report.session.droppedSteps = 2; f.report.session.updatedAt = at(103000); f.save();
    let loaded = await loadTestReport(f.file);
    assert.equal(loaded.debug!.steps.length, 100); assert.equal(loaded.debug!.taskAssessment!.checks.length, 1);
    assert.equal(loaded.debug!.taskAssessment!.final!.status, "passed");
    const evidence = f.report.snapshots.find(item => item.snapshotId === check.observations.second!.snapshotId)!;
    rmSync(join(f.directory, evidence.tree!.path));
    loaded = await loadTestReport(f.file); assert.equal(loaded.debug!.taskAssessment!.final!.status, "insufficient_evidence");
    assert.equal(loaded.index.run.status, "recorded");
  } finally { f.cleanup(); }
});

test("a stopped or insufficient original check is not promoted to pass by offline reading", async () => {
  const f = fixture();
  try {
    const check = f.addCheck(null, "insufficient_evidence");
    f.report.steps[1].step.status = "failed"; f.syncCheck(check);
    const loaded = await loadTestReport(f.file);
    assert.equal(loaded.debug!.taskAssessment!.final!.status, "insufficient_evidence");
    assert.equal(loaded.index.cases[0].attempts[0].steps[1].status, "failed");
  } finally { f.cleanup(); }
});

test("rejected task requests stay readable without inventing a definition or a proof", async () => {
  const f = fixture();
  try {
    f.report.task = null;
    const entry = f.report.steps[0]; entry.step.status = "failed"; entry.step.verified = entry.verified = false;
    entry.step.error = { category: "verify", code: "debug-step-failed", phase: "verify", message: "任务在输入后被拒绝" }; f.save();
    let loaded = await loadTestReport(f.file); assert.equal(loaded.debug!.task, null); assert.equal(loaded.index.cases[0].attempts[0].steps[0].status, "failed");
    entry.step.action = "check_debug_task"; entry.step.input = { sessionId: f.report.session.id, taskId: uuid(999) }; f.save();
    loaded = await loadTestReport(f.file); assert.equal(loaded.debug!.taskAssessment, undefined);
  } finally { f.cleanup(); }
});

test("real offline session reports keep task proofs readable after rejected requests, stop and 100-step rolling", async () => {
  const taskDefinition: DebugTaskDefinition = { goal: "实际离线留证", checkpoints: [{ id: "first", title: "第一阶段", conditions: [condition("phase-ready")] }], finalConditions: [condition("ready")] };
  const f = fixture(taskDefinition), observed = f.observation(100), snapshot = f.trees.get(observed.snapshotId)!.snapshot;
  const session = new DebugSession({ serial: snapshot.serial, packageName: f.report.session.packageName,
    directory: join(f.directory, "session"), snapshotPath: join(f.directory, "current.json"), onEvent: () => {},
    observe: async () => ({ snapshot: structuredClone(snapshot), target: { packageName: f.report.session.packageName,
      component: observed.component, windowId: observed.windowId, activityName: ".Main", activityRecordId: observed.activityRecordId ?? undefined } }) });
  try {
    await session.request({ name: "define_debug_task", input: { sessionId: session.state.id, definition: taskDefinition } });
    const taskId = session.state.task!.id;
    await session.request({ name: "check_debug_task", input: { sessionId: session.state.id, taskId, checkpointId: "first" } });
    await session.request({ name: "check_debug_task", input: { sessionId: session.state.id, taskId } });
    await session.request({ name: "define_debug_task", input: { sessionId: session.state.id, definition: taskDefinition } });
    await session.request({ name: "check_debug_task", input: { sessionId: session.state.id, taskId: uuid(999) } });
    let loaded = await loadTestReport(session.state.reportPath!);
    assert.equal(loaded.debug!.taskAssessment!.final!.status, "passed");
    assert.equal(loaded.index.cases[0].attempts[0].steps.at(-1)!.status, "failed");
    for (let index = 0; index < 102; index++) await session.request({ name: "capture_ui", input: { sessionId: session.state.id, mode: "fast", backend: "uiautomator" } });
    session.stop("离线测试结束"); await session.settled();
    loaded = await loadTestReport(session.state.reportPath!);
    assert.equal(loaded.debug!.steps.length, 100); assert.ok(loaded.debug!.session.droppedSteps >= 7);
    assert.equal(loaded.debug!.taskAssessment!.checks.length, 2); assert.equal(loaded.debug!.taskAssessment!.final!.status, "passed");
    assert.equal(loaded.index.run.status, "recorded");
  } finally { session.stop(); await session.settled(); f.cleanup(); }
});

test("writer snapshot eviction can retain only the second observation as insufficient evidence and remains importable", async () => {
  const f = fixture(), check = f.addCheck();
  const state: DebugSessionState = { id: f.report.session.id, serial: f.report.session.serial, packageName: f.report.session.packageName,
    active: false, busy: false, expiresAt: new Date(Date.now() + 60_000).toISOString(), steps: [], evidencePath: null,
    reportPath: null, task: structuredClone(f.report.task), stopReason: "低额度离线测试" };
  const writer = new DebugEvidenceWriter(join(f.directory, "limited"), state, { maxSnapshots: 1 });
  try {
    const defined = structuredClone(f.report.steps[0]);
    defined.step.time = defined.finishedAt = state.task!.definedAt = new Date().toISOString();
    state.task!.checks = []; state.steps.push(defined.step);
    writer.record(state, 1, defined, { entry: null, freshness: "missing", reason: "定义不采集页面" }, { entry: null, freshness: "missing", reason: "定义不采集页面" });
    const record = structuredClone(f.report.steps[1]); record.step.time = new Date().toISOString();
    const makeEntry = (observation: DebugTaskObservation): McpSnapshot => ({ id: observation.snapshotId, sharedAt: new Date().toISOString(),
      ownerPid: process.pid, selectedNodeId: null, snapshot: structuredClone(f.trees.get(observation.snapshotId)!.snapshot) });
    const first = makeEntry(check.observations.first!);
    await new Promise(resolve => setTimeout(resolve, 2));
    const second = makeEntry(check.observations.second!);
    check.observations.first!.capturedAt = first.sharedAt; check.observations.second!.capturedAt = second.sharedAt;
    check.checkedAt = record.finishedAt = new Date().toISOString();
    state.task!.checks = [structuredClone(check)]; record.step.taskCheck = structuredClone(check); state.steps.push(record.step);
    writer.record(state, 2, record, { entry: first, freshness: "current", reason: null }, { entry: second, freshness: "current", reason: null });
    const raw = JSON.parse(readFileSync(writer.path, "utf8")) as DebugSessionReport;
    assert.equal(raw.snapshots.length, 1); assert.equal(raw.task!.checks[0].observations.first, null);
    assert.equal(raw.task!.checks[0].observations.second!.snapshotId, second.id); assert.equal(raw.task!.checks[0].status, "insufficient_evidence");
    assert.equal(raw.steps[1].before.freshness, "missing"); assert.equal(raw.steps[1].after.freshness, "current");
    assert.deepEqual(raw.task!.checks[0], state.task!.checks[0]); assert.deepEqual(raw.steps[1].step.taskCheck, record.step.taskCheck);
    const loaded = await loadTestReport(writer.path);
    assert.equal(loaded.debug!.taskAssessment!.final!.status, "insufficient_evidence");
    assert.equal(loaded.debug!.task!.checks[0].observations.second!.snapshotId, second.id); assert.ok(loaded.debug!.snapshots[0].snapshot);
    assert.equal(loaded.index.cases[0].attempts[0].steps[1].status, "completed"); assert.equal(loaded.index.run.status, "recorded");
    const claimPass = structuredClone(raw); claimPass.task!.checks[0].status = claimPass.steps[1].step.taskCheck!.status = "passed";
    claimPass.steps[1].verified = claimPass.steps[1].step.verified = true;
    for (const result of [claimPass.task!.checks[0], claimPass.steps[1].step.taskCheck!]) for (const item of result.conditions) item.status = "passed";
    writeFileSync(writer.path, JSON.stringify(claimPass)); await assert.rejects(loadTestReport(writer.path));
  } finally { f.cleanup(); }
});
