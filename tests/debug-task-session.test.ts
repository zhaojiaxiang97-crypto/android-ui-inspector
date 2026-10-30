import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession } from "../electron/automation/debug-session";
import type { DebugTarget } from "../electron/device/target";
import { debugTaskCheckResult, type DebugTaskCheckResult, type DebugTaskDefinition } from "../shared/debug-task";
import type { DebugSessionReport } from "../shared/debug-report";
import type { DebugSessionEvent, FastCaptureBackend, UiSnapshot } from "../shared/types";

const packageName = "com.example.task", serial = "fixture-device";
const target: DebugTarget = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "real-window", activityRecordId: "real-activity" };
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1EAAAAASUVORK5CYII=";
function snapshot(text = "完成", source: FastCaptureBackend = "uiautomator"): UiSnapshot {
  const root = makeNode("0"), node = makeNode("0/0"); root.package = node.package = packageName;
  root.visibleToUser = false; root.children = [node]; node.text = text; node.visibleToUser = node.enabled = true;
  node.bounds = { left: 10, top: 10, right: 40, bottom: 40, raw: "[10,10][40,40]" };
  const frame = { width: 100, height: 100, rotation: 0 as const };
  return { serial, root, nodeCount: 2, xmlSize: 0, rawXml: null, screenshotDataUrl: png, error: null, warning: null,
    inspectionSource: source, captureMode: "fast", hierarchyDumpMode: "full",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } };
}
const definition = (stages = 0): DebugTaskDefinition => ({ goal: "检查声明的页面条件，不根据这句话推断任何业务副作用。",
  checkpoints: Array.from({ length: stages }, (_, index) => ({ id: `stage-${index}`, title: `阶段 ${index}`,
    conditions: [{ id: `condition-${index}`, selector: { text: "完成" }, state: "visible" as const }] })),
  finalConditions: [{ id: "final", selector: { text: "完成" }, state: "visible" }] });
type Observation = { snapshot: UiSnapshot; target: DebugTarget };
function harness(options: { observe?: (read: number, signal: AbortSignal, backend: FastCaptureBackend) => Promise<Observation>;
  onEvent?: (event: DebugSessionEvent) => void; blockedDirectory?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "inspector-task-session-")), path = join(directory, "current.json");
  let evidenceDirectory = directory;
  if (options.blockedDirectory) { evidenceDirectory = join(directory, "blocked"); writeFileSync(evidenceDirectory, "file"); }
  const counts = { reads: 0, inputs: 0, times: [] as number[], modes: [] as string[], backends: [] as string[] };
  const session = new DebugSession({ serial, packageName, snapshotPath: path, directory: evidenceDirectory,
    onEvent: options.onEvent ?? (() => {}),
    observe: async (_serial, _package, mode, signal, backend = "uiautomator") => {
      counts.reads++; counts.times.push(Date.now()); counts.modes.push(mode); counts.backends.push(backend);
      return options.observe ? options.observe(counts.reads, signal!, backend) : { snapshot: snapshot("完成", backend), target };
    }, input: async () => { counts.inputs++; } });
  return { directory, path, session, counts, async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}
type Harness = ReturnType<typeof harness>;
async function define(h: Harness, value = definition()) {
  const result = await h.session.request({ name: "define_debug_task", input: { sessionId: h.session.state.id, definition: value } });
  assert.equal(result.isError, undefined); assert.equal(typeof result.taskId, "string"); return result;
}
async function check(h: Harness, taskId: unknown, checkpointId?: string, signal?: AbortSignal) {
  const result = await h.session.request({ name: "check_debug_task", input: { sessionId: h.session.state.id, taskId,
    ...(checkpointId ? { checkpointId } : {}) } }, signal);
  if (result.taskResult) debugTaskCheckResult.parse(result.taskResult);
  return result;
}
const taskResult = (result: Record<string, unknown>) => result.taskResult as DebugTaskCheckResult;
function report(h: Harness): DebugSessionReport {
  assert.ok(h.session.state.reportPath); return JSON.parse(readFileSync(h.session.state.reportPath, "utf8"));
}

test("task definition is fixed metadata, permits prior read-only capture, and returns independent copies", async () => {
  const h = harness();
  try {
    await h.session.request({ name: "capture_ui", input: { sessionId: h.session.state.id, mode: "deep" } });
    const result = await define(h), task = structuredClone(h.session.state.task);
    assert.equal(h.counts.reads, 1); assert.equal(h.counts.inputs, 0);
    assert.equal(task!.definedStepId, 2); assert.equal(task!.definedAt, h.session.state.steps[1].time);
    assert.deepEqual(report(h).task, task); assert.equal(h.session.state.steps[1].verified, null);
    (result.task as NonNullable<typeof h.session.state.task>).definition.goal = "mutated return";
    (result.state as typeof h.session.state).task!.definition.goal = "mutated state return";
    assert.deepEqual(h.session.state.task, task);
    const duplicate = await defineRequest(h, definition(1));
    assert.equal(duplicate.isError, true); assert.equal(h.counts.reads, 1); assert.deepEqual(h.session.state.task, task);
    const failed = report(h).steps.at(-1)!;
    assert.equal(failed.before.freshness, "missing"); assert.equal(failed.after.freshness, "missing"); assert.equal(failed.step.taskCheck, undefined);
  } finally { await h.dispose(); }
});
const defineRequest = (h: Harness, value = definition()) => h.session.request({ name: "define_debug_task",
  input: { sessionId: h.session.state.id, definition: value } });

test("an input request permanently blocks late task definition even after its failed step rolls away", async () => {
  const h = harness();
  try {
    const attempt = await h.session.request({ name: "tap_node", input: { sessionId: h.session.state.id, snapshotId: randomUUID(), nodeId: "0/0" } });
    assert.equal(attempt.isError, true); assert.equal(h.counts.inputs, 0);
    for (let index = 0; index < 102; index++) await h.session.request({ name: "capture_ui", input: { sessionId: h.session.state.id } });
    assert.equal(h.session.state.steps.length, 100); assert.ok(h.session.state.steps.every(step => step.action !== "tap_node"));
    const result = await defineRequest(h); assert.equal(result.isError, true); assert.match(String(result.message), /输入请求开始前/);
    assert.equal(h.session.state.task, null); assert.equal(h.counts.reads, 102); assert.equal(h.counts.inputs, 0);
  } finally { await h.dispose(); }
});

test("one task check reads exactly two fresh fast observations and binds actual target and persisted proof", async () => {
  const h = harness();
  try {
    const defined = await define(h), result = await check(h, defined.taskId), value = taskResult(result);
    assert.equal(result.isError, undefined); assert.equal(result.verified, true); assert.equal(value.status, "passed");
    assert.equal(h.counts.reads, 2); assert.equal(h.counts.inputs, 0);
    assert.deepEqual(h.counts.modes, ["fast", "fast"]); assert.deepEqual(h.counts.backends, ["uiautomator", "uiautomator"]);
    assert.ok(h.counts.times[1] - h.counts.times[0] >= 340);
    for (const observation of [value.observations.first!, value.observations.second!]) {
      assert.equal(observation.component, target.component); assert.equal(observation.windowId, target.windowId);
      assert.equal(observation.activityRecordId, target.activityRecordId);
    }
    assert.notEqual(value.observations.first!.snapshotId, value.observations.second!.snapshotId);
    const saved = report(h), step = saved.steps.at(-1)!;
    assert.equal(saved.schemaVersion, "inspector-debug-report-2"); assert.deepEqual(saved.task, h.session.state.task);
    assert.deepEqual(step.step.taskCheck, value); assert.equal(step.verified, true);
    assert.equal(step.before.snapshotId, value.observations.first!.snapshotId); assert.equal(step.after.snapshotId, value.observations.second!.snapshotId);
    assert.equal(step.before.freshness, "current"); assert.equal(step.after.freshness, "current");
    assert.ok(saved.snapshots.every(item => item.tree));
  } finally { await h.dispose(); }
});

test("checkpoints run in order, final prerequisites do not capture, and rechecking clears later and final results", async () => {
  let label = "完成";
  const h = harness({ observe: async () => ({ snapshot: snapshot(label), target }) });
  try {
    const { taskId } = await define(h, definition(2));
    const premature = await check(h, taskId); assert.equal(taskResult(premature).status, "insufficient_evidence");
    assert.equal(premature.isError, undefined); assert.equal(h.counts.reads, 0);
    assert.deepEqual(taskResult(premature).observations, { first: null, second: null });
    assert.equal((await check(h, taskId, "stage-1")).isError, true); assert.equal(h.counts.reads, 0);
    assert.equal(taskResult(await check(h, taskId, "stage-0")).status, "passed");
    assert.deepEqual(h.session.state.task!.checks.map(item => item.checkpointId), ["stage-0"]);
    assert.equal(taskResult(await check(h, taskId, "stage-1")).status, "passed");
    assert.equal(taskResult(await check(h, taskId)).status, "passed"); assert.equal(h.counts.reads, 6);
    label = "还没完成";
    const recheck = await check(h, taskId, "stage-0"); assert.equal(taskResult(recheck).status, "failed");
    assert.equal(recheck.isError, undefined); assert.equal(recheck.verified, false);
    assert.deepEqual(h.session.state.task!.checks.map(item => item.checkpointId), ["stage-0"]);
    assert.equal(taskResult(await check(h, taskId)).status, "insufficient_evidence"); assert.equal(h.counts.reads, 8);
    const saved = report(h);
    assert.ok(saved.steps.filter(item => item.step.taskCheck).length > saved.task!.checks.length);
    for (const latest of saved.task!.checks) assert.deepEqual(saved.steps.find(item => item.step.id === latest.stepId)!.step.taskCheck, latest);
  } finally { await h.dispose(); }
});

test("at most one latest check per target is kept, including all five stages and final", async () => {
  const h = harness();
  try {
    const { taskId } = await define(h, definition(5));
    for (let index = 0; index < 5; index++) assert.equal(taskResult(await check(h, taskId, `stage-${index}`)).status, "passed");
    const firstFinal = taskResult(await check(h, taskId));
    const latestFinal = taskResult(await check(h, taskId));
    assert.equal(h.session.state.task!.checks.length, 6); assert.notEqual(firstFinal.stepId, latestFinal.stepId);
    assert.deepEqual(h.session.state.task!.checks.at(-1), latestFinal); assert.equal(h.counts.reads, 14); assert.equal(h.counts.inputs, 0);
  } finally { await h.dispose(); }
});

test("Helper current observations are explicitly rejected without switching or borrowing the old page", async () => {
  const h = harness();
  try {
    const { taskId } = await define(h);
    await h.session.request({ name: "capture_ui", input: { sessionId: h.session.state.id, backend: "accessibility-helper" } });
    const result = await check(h, taskId); assert.equal(result.isError, true); assert.match(String(result.message), /不会自动换源/);
    assert.equal(h.counts.reads, 1); assert.equal(h.counts.inputs, 0); assert.equal(taskResult(result).status, "insufficient_evidence");
    assert.deepEqual(taskResult(result).observations, { first: null, second: null });
    const step = report(h).steps.at(-1)!; assert.equal(step.before.freshness, "missing"); assert.equal(step.after.freshness, "missing");
    await h.session.request({ name: "capture_ui", input: { sessionId: h.session.state.id, backend: "uiautomator" } });
    assert.equal(taskResult(await check(h, taskId)).status, "passed"); assert.equal(h.counts.reads, 4);
  } finally { await h.dispose(); }
});

test("a capture error preserves the first accepted observation and its structured error without inventing a second", async () => {
  const h = harness({ observe: async read => { if (read === 3) throw new Error("second read failed"); return { snapshot: snapshot(), target }; } });
  try {
    const { taskId } = await define(h);
    await h.session.request({ name: "capture_ui", input: { sessionId: h.session.state.id } });
    const result = await check(h, taskId), value = taskResult(result);
    assert.equal(result.isError, true); assert.equal(value.status, "insufficient_evidence"); assert.equal(result.verified, false);
    assert.ok(value.observations.first); assert.equal(value.observations.second, null);
    assert.equal(h.counts.reads, 3); assert.equal(h.counts.inputs, 0);
    const saved = report(h).steps.at(-1)!;
    assert.equal(saved.before.freshness, "current"); assert.equal(saved.before.snapshotId, value.observations.first!.snapshotId);
    assert.equal(saved.after.freshness, "missing"); assert.equal(saved.step.error!.phase, "capture");
    assert.match(saved.step.error!.message, /second read failed/); assert.equal(saved.step.taskCheck!.conditions.length, 1);
  } finally { await h.dispose(); }
});

test("stop during the second capture persists the first proof immediately and rejects late sharing", async () => {
  let release: (() => void) | undefined;
  const h = harness({ observe: async read => { if (read === 2) await new Promise<void>(resolve => { release = resolve; }); return { snapshot: snapshot(), target }; } });
  try {
    const { taskId } = await define(h), pending = check(h, taskId);
    for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(release); h.session.stop("user stopped task");
    const immediate = report(h); assert.equal(immediate.session.active, false);
    assert.equal(immediate.task!.checks[0].status, "insufficient_evidence"); assert.ok(immediate.task!.checks[0].observations.first);
    assert.equal(immediate.task!.checks[0].observations.second, null); assert.equal(existsSync(h.path), false);
    release!(); const result = await pending;
    assert.equal(result.isError, true); assert.equal(taskResult(result).status, "insufficient_evidence");
    assert.equal(existsSync(h.path), false); assert.equal(h.counts.reads, 2); assert.equal(h.counts.inputs, 0);
    assert.equal(report(h).task!.checks.length, 1); assert.equal(report(h).steps.filter(item => item.step.action === "check_debug_task").length, 1);
  } finally { release?.(); await h.dispose(); }
});

test("stop from the first accepted observation event still retains that observation as before evidence", async () => {
  let active: Harness | undefined;
  const h = harness({ onEvent: event => { if (event.snapshot && event.state.steps.at(-1)?.action === "check_debug_task") active!.session.stop("stop on first page"); } });
  active = h;
  try {
    const { taskId } = await define(h), result = await check(h, taskId);
    assert.equal(h.counts.reads, 1); assert.equal(h.counts.inputs, 0); assert.equal(result.isError, true);
    assert.ok(taskResult(result).observations.first); assert.equal(taskResult(result).observations.second, null);
    const saved = report(h).steps.at(-1)!; assert.equal(saved.before.freshness, "current"); assert.equal(saved.after.freshness, "missing");
    assert.equal(saved.step.error!.code, "cancelled"); assert.equal(existsSync(h.path), false);
  } finally { await h.dispose(); }
});

test("caller cancellation while a task check is busy prevents a second capture and concurrent requests cannot replace the task", async () => {
  const controller = new AbortController(); let firstAccepted: (() => void) | undefined;
  const accepted = new Promise<void>(resolve => { firstAccepted = resolve; });
  const h = harness({ onEvent: event => { if (event.snapshot && event.state.steps.at(-1)?.action === "check_debug_task") firstAccepted!(); } });
  try {
    const { taskId } = await define(h), pending = check(h, taskId, undefined, controller.signal);
    await accepted;
    await assert.rejects(check(h, taskId), /正在执行/);
    await assert.rejects(defineRequest(h), /正在执行/);
    controller.abort(new Error("client cancelled task"));
    const result = await pending;
    assert.equal(result.isError, true); assert.equal(taskResult(result).status, "insufficient_evidence");
    assert.equal(h.counts.reads, 1); assert.equal(h.counts.inputs, 0); assert.equal(h.session.state.busy, false);
    assert.equal(h.session.state.steps.at(-1)!.error!.code, "cancelled");
    assert.equal(h.session.state.task!.checks.length, 1); assert.ok(taskResult(result).observations.first);
    assert.equal(taskResult(result).observations.second, null); assert.equal(report(h).steps.at(-1)!.after.freshness, "missing");
  } finally { await h.dispose(); }
});

test("tree overflow and metadata write failures downgrade returned, live and persisted results; missing PNG alone does not", async () => {
  for (const kind of ["tree", "metadata", "image"] as const) {
    const h = harness({ blockedDirectory: kind === "metadata", observe: async () => {
      const page = snapshot();
      if (kind === "tree") page.root!.attributes = { large: "x".repeat(2 * 1024 * 1024) };
      if (kind === "image") page.screenshotDataUrl = null;
      return { snapshot: page, target };
    } });
    try {
      const { taskId } = await define(h), result = await check(h, taskId), expected = kind === "image" ? "passed" : "insufficient_evidence";
      assert.equal(taskResult(result).status, expected); assert.equal(result.verified, kind === "image");
      if (kind !== "image") assert.ok(!String(result.message).includes("均满足所有声明"));
      assert.equal(h.session.state.task!.checks[0].status, expected); assert.equal(h.session.state.steps.at(-1)!.verified, kind === "image");
      assert.equal(h.counts.reads, 2); assert.equal(h.counts.inputs, 0);
      if (kind !== "metadata") {
        assert.equal(report(h).task!.checks[0].status, expected); assert.equal(report(h).steps.at(-1)!.verified, kind === "image");
      } else assert.ok(h.session.state.steps.at(-1)!.recordingErrors?.length);
    } finally { await h.dispose(); }
  }
});

test("a lost stored checkpoint tree prevents a later final pass even when both current page conditions pass", async () => {
  const h = harness();
  try {
    const { taskId } = await define(h, definition(1)), checkpoint = taskResult(await check(h, taskId, "stage-0"));
    assert.equal(checkpoint.status, "passed");
    const previous = report(h), tree = previous.snapshots.find(item => item.snapshotId === checkpoint.observations.first!.snapshotId)!.tree!;
    rmSync(join(h.directory, h.session.state.id, tree.path));
    const result = await check(h, taskId);
    assert.equal(result.isError, undefined); assert.equal(taskResult(result).status, "insufficient_evidence"); assert.equal(result.verified, false);
    assert.ok(h.session.state.task!.checks.every(item => item.status === "insufficient_evidence"));
    const saved = report(h);
    assert.equal(saved.snapshots.find(item => item.snapshotId === checkpoint.observations.first!.snapshotId)!.tree, null);
    assert.equal(saved.task!.checks.at(-1)!.status, "insufficient_evidence"); assert.equal(h.counts.reads, 4); assert.equal(h.counts.inputs, 0);
  } finally { await h.dispose(); }
});
