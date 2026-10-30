import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSessionRecording } from "../electron/automation/debug-session-recording";
import type { StepContext } from "../electron/automation/debug-step-context";
import type { McpSnapshot } from "../electron/automation/mcp-snapshot";
import type { DebugSessionState, DebugStep } from "../shared/types";
import type { DebugSessionReport } from "../shared/debug-report";
import type { DebugTaskCheckResult } from "../shared/debug-task";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inspector-session-recording-"));
  const state: DebugSessionState = { id: randomUUID(), serial: "offline-device", packageName: "com.example.recording",
    active: true, busy: false, expiresAt: new Date(Date.now() + 60_000).toISOString(), steps: [], evidencePath: null, reportPath: null, stopReason: null };
  const step: DebugStep = { id: 1, time: new Date().toISOString(), action: "press_back", input: {}, status: "failed",
    dispatchState: "unknown", verified: false, message: "input outcome unknown",
    error: { category: "input", phase: "input", code: "unconfirmed-exit", message: "original input error" } };
  state.steps.push(step);
  const root = makeNode("0"); root.package = state.packageName; root.children = [];
  const entry: McpSnapshot = { id: randomUUID(), sharedAt: step.time, ownerPid: process.pid, selectedNodeId: null,
    snapshot: { serial: state.serial, root, nodeCount: 1, xmlSize: 0, rawXml: null, error: null, warning: null,
      screenshotDataUrl: null, captureMode: "fast", inspectionSource: "uiautomator" } };
  const context: StepContext = { step, started: performance.now(), phase: "input", before: entry, beforeFreshness: "current",
    after: null, previousAfter: entry, invalidatedAfter: false, finishedAt: step.time };
  const recording = new DebugSessionRecording({ directory, state });
  return { directory, state, step, context, entry, recording,
    report: () => JSON.parse(readFileSync(state.reportPath!, "utf8")) as DebugSessionReport,
    dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

test("recorder uses previous-page evidence only when neither dispatch nor a task invalidated it", () => {
  for (const mode of ["previous", "invalidated", "task"] as const) {
    const h = fixture();
    try {
      h.context.invalidatedAfter = mode === "invalidated";
      if (mode === "task") h.context.task = { taskId: randomUUID(), checkpointId: null, conditions: [], first: null, second: null };
      h.recording.record(h.context, 1);
      const saved = h.report().steps[0];
      assert.equal(saved.before.snapshotId, h.entry.id); assert.equal(saved.before.freshness, "current");
      assert.equal(saved.after.snapshotId, mode === "previous" ? h.entry.id : null);
      assert.equal(saved.after.freshness, mode === "previous" ? "previous" : "missing");
      assert.equal(saved.step.dispatchState, "unknown"); assert.deepEqual(saved.step.error, h.step.error);
    } finally { h.dispose(); }
  }
});

test("stop and final recording update the same step and retain its actual completion and log facts", () => {
  const h = fixture();
  try {
    h.context.invalidatedAfter = true; h.state.active = false;
    h.recording.record(h.context, 1);
    h.context.finishedAt = new Date(Date.parse(h.step.time) + 1000).toISOString();
    h.context.logs = [{ text: null, evidence: { source: "session", sessionId: h.state.id, stepId: 1, packageName: h.state.packageName,
      startedAt: h.step.time, finishedAt: h.context.finishedAt, status: "cancelled", attribution: "missing", reason: "stopped",
      truncated: false, lineCount: 0, file: null, androidScope: null } }];
    h.recording.record(h.context, 1);
    const report = h.report(); assert.equal(report.steps.length, 1); assert.equal(report.session.totalSteps, 1);
    assert.equal(report.session.active, false); assert.equal(report.steps[0].finishedAt, h.context.finishedAt);
    assert.equal(report.steps[0].logs![0].status, "cancelled"); assert.equal(report.steps[0].logs![0].file, null);
    assert.equal(report.steps[0].step.dispatchState, "unknown"); assert.deepEqual(report.steps[0].step.error, h.step.error);
  } finally { h.dispose(); }
});

test("compatibility failure evidence strips bitmaps and keeps the previous file when the 8 MiB limit rejects a replacement", () => {
  const h = fixture();
  try {
    h.entry.snapshot.screenshotDataUrl = "data:image/png;base64,screen-pixels";
    h.entry.snapshot.root!.layerImageDataUrl = "data:image/png;base64,layer-pixels";
    const command = { name: "press_back" as const, input: { sessionId: h.state.id, snapshotId: h.entry.id } };
    h.recording.saveFailure(h.context, command);
    const path = h.state.evidencePath!, original = readFileSync(path, "utf8");
    assert.doesNotMatch(original, /screen-pixels|layer-pixels/);
    const parsed = JSON.parse(original); assert.equal(parsed.before.id, h.entry.id); assert.equal(parsed.after, null);
    assert.equal(parsed.step.dispatchState, "unknown"); assert.equal(parsed.step.error.message, "original input error");
    h.step.input = { oversized: "x".repeat(8 * 1024 * 1024) };
    h.recording.saveFailure(h.context, command);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.ok(h.step.recordingErrors?.some(error => error.code === "last_failure_write_failed" && /8MiB/.test(error.message)));
    assert.equal(h.step.dispatchState, "unknown"); assert.equal(h.step.error?.message, "original input error");
  } finally { h.dispose(); }
});

test("record and session-save failures downgrade task proof separately from completed action and sanitized recording errors", () => {
  for (const method of ["record", "saveSession"] as const) {
    const h = fixture();
    try {
      const check: DebugTaskCheckResult = { taskId: randomUUID(), checkpointId: null, stepId: 1, checkedAt: h.step.time,
        status: "passed", reason: "two observations passed", conditions: [], observations: { first: null, second: null } };
      Object.assign(h.step, { status: "done", dispatchState: "sent", error: undefined, verified: true, taskCheck: check });
      h.state.task = { id: check.taskId, definedAt: h.step.time, definedStepId: 1,
        definition: { goal: "read only", checkpoints: [], finalConditions: [] }, checks: [structuredClone(check)] };
      writeFileSync(h.recording.directory, "a file blocks the report directory");
      if (method === "record") h.recording.record(h.context, 1); else h.recording.saveSession(1);
      assert.equal(h.step.status, "done"); assert.equal(h.step.dispatchState, "sent"); assert.equal(h.step.error, undefined);
      assert.equal(h.step.verified, false); assert.equal(h.step.taskCheck!.status, "insufficient_evidence");
      assert.equal(h.state.task.checks[0].status, "insufficient_evidence");
      assert.ok(h.step.recordingErrors?.some(error => error.code === "report_write_failed"));
      h.recording.recordingFailure(h.step, "fixture", new Error("token=private-value failed"));
      assert.doesNotMatch(h.step.recordingErrors!.at(-1)!.message, /private-value/);
      assert.equal(existsSync(join(h.recording.directory, "report.json")), false);
    } finally { h.dispose(); }
  }
});
