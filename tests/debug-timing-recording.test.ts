import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { DebugEvidenceWriter } from "../electron/automation/debug-evidence";
import { DebugSessionRecording } from "../electron/automation/debug-session-recording";
import type { StepContext } from "../electron/automation/debug-step-context";
import type { DebugSessionState } from "../shared/types";
import { DEBUG_TIMING_SPAN_LIMIT, type DebugTimings } from "../shared/debug-timing";
import { helperEvidence } from "./fixtures/helper-protocol";

function fixture() {
  const parent = resolve(".benchmarks"); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "timing-recording-")), time = new Date().toISOString();
  const state: DebugSessionState = { id: randomUUID(), serial: "timing-fixture", packageName: "com.example.timing", active: true,
    busy: false, expiresAt: new Date(Date.now() + 60_000).toISOString(), steps: [], evidencePath: null };
  const timings = { version: 1 as const, correlationId: randomUUID(), startedAt: time, durationMs: 1, status: "running" as const,
    spans: [], droppedSpans: 0, commandCount: 0, commandCounts: {}, observationCount: 0, observationCounts: {} };
  const context: StepContext = { step: { id: 1, time, action: "capture_ui", input: { sessionId: state.id }, status: "done", message: "captured", timings },
    started: performance.now(), finishedAt: time, phase: "recording", before: null, beforeFreshness: "current", previousAfter: null,
    invalidatedAfter: false, after: { id: randomUUID(), sharedAt: time, ownerPid: process.pid, selectedNodeId: null,
      snapshot: { serial: state.serial, root: makeNode("0"), nodeCount: 1, xmlSize: 0, rawXml: null, error: null, warning: null,
        screenshotDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1EAAAAASUVORK5CYII=",
        inspectionSource: "uiautomator", captureMode: "fast" } } };
  state.steps.push(context.step);
  const final = { ...timings, durationMs: 12, status: "success" as const, spans: [
    { id: 1, parentId: null, phase: "save" as const, startOffsetMs: 2, durationMs: 10, status: "success" as const },
  ] };
  return { directory, state, context, final };
}

test("final timing refresh writes report and compatibility metadata without repeating evidence work", () => {
  const f = fixture(), recording = new DebugSessionRecording(f);
  try {
    recording.record(f.context, 1); recording.saveSteps();
    const reportPath = join(recording.directory, "report.json"), before = JSON.parse(readFileSync(reportPath, "utf8"));
    const artifactDirectory = join(recording.directory, "artifacts");
    const original = new Map(readdirSync(artifactDirectory).map(name => {
      const path = join(artifactDirectory, name), info = statSync(path);
      return [name, { bytes: readFileSync(path), ino: info.ino, mtimeMs: info.mtimeMs }];
    }));
    assert.ok(original.size > 0);
    for (const key of ["root", "screenshotDataUrl"])
      Object.defineProperty(f.context.after!.snapshot, key, { get() { throw new Error("snapshot processed again"); } });
    recording.record = () => { throw new Error("record called again"); };
    recording.saveSession = () => { throw new Error("saveSession called again"); };
    f.context.step.timings = f.final; f.state.active = false; f.state.stopReason = "finished";
    recording.finalizeTiming(f.context, 2);
    const after = JSON.parse(readFileSync(reportPath, "utf8")), compatibility = JSON.parse(readFileSync(join(recording.directory, "steps.json"), "utf8"));
    assert.deepEqual(after.steps[0].step.timings, f.final);
    assert.deepEqual(compatibility.steps[0].timings, f.final);
    assert.equal(after.session.active, false); assert.equal(after.session.stopReason, "finished");
    assert.equal(after.session.totalSteps, 2); assert.equal(after.session.droppedSteps, 1);
    assert.deepEqual(after.snapshots, before.snapshots);
    assert.equal(after.steps[0].durationMs, before.steps[0].durationMs);
    assert.equal(f.context.step.recordingErrors, undefined);
    assert.equal(after.storage.bytes, statSync(reportPath).size + [...original.values()].reduce((sum, item) => sum + item.bytes.length, 0));
    assert.deepEqual(readdirSync(artifactDirectory).sort(), [...original.keys()].sort());
    for (const [name, previous] of original) {
      const path = join(artifactDirectory, name), info = statSync(path);
      assert.deepEqual(readFileSync(path), previous.bytes); assert.equal(info.ino, previous.ino); assert.equal(info.mtimeMs, previous.mtimeMs);
    }
    // The saved record owns its timing copy; mutating the caller cannot alter a later metadata write.
    f.final.spans[0].durationMs = 999;
    recording.saveSteps();
    assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).steps[0].step.timings.spans[0].durationMs, 10);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("final metadata saving retains a deep copy of Helper device diagnostics without reopening attachments", () => {
  const f = fixture(), recording = new DebugSessionRecording(f);
  try {
    recording.record(f.context, 1);
    const final: DebugTimings = { ...f.final, spans: [...f.final.spans, {
      id: 2, parentId: 1, phase: "helper_tree", startOffsetMs: 3, durationMs: 2, status: "failed",
      helperDeviceTiming: helperEvidence().timing, helperReportedComplete: false,
    }] };
    const expected = structuredClone(final); f.context.step.timings = final;
    recording.finalizeTiming(f.context, 1);
    const path = join(recording.directory, "report.json"), assets = readdirSync(join(recording.directory, "artifacts"));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).steps[0].step.timings, expected);
    assert.deepEqual(JSON.parse(readFileSync(join(recording.directory, "steps.json"), "utf8")).steps[0].timings, expected);
    final.spans[1].helperDeviceTiming!.completedAtMs = 999_999;
    recording.saveSession(1);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).steps[0].step.timings, expected);
    assert.deepEqual(readdirSync(join(recording.directory, "artifacts")), assets);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("timing metadata budget failure preserves the previous report and all attachments", () => {
  const f = fixture(), writer = new DebugEvidenceWriter(join(f.directory, f.state.id), f.state, { maxBytes: 8000 });
  try {
    // A previously completed record has no pending timing reservation. An
    // unexpected later expansion must still fail without changing saved proof.
    f.context.step.timings = { ...f.context.step.timings!, status: "success" };
    writer.record(f.state, 1, { step: f.context.step, finishedAt: f.context.finishedAt!, durationMs: 1, verified: null,
      before: { snapshotId: null, freshness: "missing", reason: null }, after: { snapshotId: null, freshness: "missing", reason: null } },
    { entry: null, freshness: "missing", reason: null }, { entry: f.context.after, freshness: "current", reason: null });
    const previous = readFileSync(writer.path), assets = readdirSync(join(f.directory, f.state.id, "artifacts"));
    f.context.step.timings = { ...f.final, spans: Array.from({ length: 200 }, (_, index) => ({ ...f.final.spans[0], id: index + 1 })) };
    assert.throws(() => writer.finalizeTiming(f.state, 1, f.context.step), /最终计时超过/);
    assert.deepEqual(readFileSync(writer.path), previous);
    assert.deepEqual(readdirSync(join(f.directory, f.state.id, "artifacts")), assets);
    f.context.step.timings = f.final;
    writer.finalizeTiming(f.state, 1, f.context.step);
    assert.deepEqual(JSON.parse(readFileSync(writer.path, "utf8")).steps[0].step.timings, f.final);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("the original 32 MiB budget reserves final timing before evicting attachments", () => {
  const f = fixture(), writer = new DebugEvidenceWriter(join(f.directory, f.state.id), f.state);
  try {
    const record = { step: f.context.step, finishedAt: f.context.finishedAt!, durationMs: 1, verified: null,
      before: { snapshotId: null, freshness: "missing" as const, reason: null },
      after: { snapshotId: null, freshness: "missing" as const, reason: null } };
    // Four distinct PNG attachments total 31.9 MiB: they fit before the final
    // 2048 timing spans, but cannot all coexist with those completed timings.
    for (let i = 1; i <= 4; i++) {
      const image = Buffer.alloc(Math.floor((i === 4 ? 7.9 : 8) * 1024 * 1024), i);
      Buffer.from("89504e470d0a1a0a", "hex").copy(image);
      f.context.after!.id = randomUUID(); f.context.after!.snapshot.screenshotDataUrl = "data:image/png;base64," + image.toString("base64");
      f.context.step.id = i;
      assert.deepEqual(writer.record(f.state, i, record, { entry: null, freshness: "missing", reason: null },
        { entry: f.context.after, freshness: "current", reason: null }), []);
    }
    const before = JSON.parse(readFileSync(writer.path, "utf8")), assets = readdirSync(join(f.directory, f.state.id, "artifacts"));
    assert.equal(before.limits.maxBytes, 32 * 1024 * 1024);
    assert.ok(before.snapshots.at(-1).tree && before.snapshots.at(-1).screenshot);
    assert.ok(before.snapshots.some((s: { screenshot: unknown }) => !s.screenshot), "history yields to pending final timing before the hard limit");
    // Fill every timing slot after the initial peek, including serialization of
    // a report near capacity. Finalization may neither evict nor reopen proof.
    f.context.step.timings = { ...f.final, durationMs: 10000, spans: Array.from({ length: DEBUG_TIMING_SPAN_LIMIT }, (_, i) => ({
      id: i + 1, parentId: null, phase: "serialization", startOffsetMs: i, durationMs: 1, status: "success",
    })) };
    writer.finalizeTiming(f.state, 4, f.context.step);
    const after = JSON.parse(readFileSync(writer.path, "utf8"));
    assert.deepEqual(after.snapshots, before.snapshots); assert.deepEqual(after.steps[0].logs, before.steps[0].logs);
    assert.deepEqual(after.steps.at(-1).step.timings, f.context.step.timings);
    assert.ok(after.storage.bytes <= 32 * 1024 * 1024);
    assert.deepEqual(readdirSync(join(f.directory, f.state.id, "artifacts")), assets);
    assert.equal(after.storage.bytes, statSync(writer.path).size + assets.reduce((sum, name) => sum + statSync(join(f.directory, f.state.id, "artifacts", name)).size, 0));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("final timing errors are recorded once without reopening evidence or invalidating step results", () => {
  const f = fixture(), recording = new DebugSessionRecording(f);
  try {
    recording.record(f.context, 1); recording.saveSteps();
    f.context.step.timings = f.final;
    const reportPath = join(recording.directory, "report.json");
    rmSync(reportPath); mkdirSync(reportPath);
    let saves = 0;
    recording.record = () => { throw new Error("recursive record"); };
    recording.saveSession = () => { throw new Error("recursive saveSession"); };
    recording.saveSteps = () => { saves++; throw new Error("compatibility write failed"); };
    recording.finalizeTiming(f.context, 1);
    assert.equal(saves, 1);
    assert.deepEqual(f.context.step.recordingErrors!.map(error => error.code), ["timing_report_write_failed", "timing_steps_write_failed"]);
    assert.equal(f.context.step.status, "done"); assert.equal(f.context.step.message, "captured");
    assert.equal(f.context.step.timings!.spans.length, 1);
    assert.equal(f.context.step.timings!.durationMs, 12);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("final timing cannot create a missing evidence record and legacy steps remain untouched", () => {
  const f = fixture(), writer = new DebugEvidenceWriter(join(f.directory, f.state.id), f.state);
  try {
    assert.throws(() => writer.finalizeTiming(f.state, 1, f.context.step), /尚未保存/);
    const recording = new DebugSessionRecording(f);
    delete f.context.step.timings;
    recording.saveSteps = () => { throw new Error("legacy step rewritten"); };
    recording.finalizeTiming(f.context, 1);
    assert.equal(f.context.step.recordingErrors, undefined);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
