import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { DebugSession } from "../electron/automation/debug-session";
import { captureReferenceBudget } from "../electron/automation/debug-capture-reference";
import { DebugEvidenceWriter, DEBUG_EVIDENCE_LIMITS, DEBUG_FINAL_TIMING_RESERVE_BYTES } from "../electron/automation/debug-evidence";
import { readHelperObservation } from "../electron/capture/helper-observation";
import { loadTestReport } from "../electron/desktop/test-report";
import { exportDebugReportEvidence } from "../electron/desktop/debug-report-export";
import { debugCommand } from "../shared/debug-protocol";
import { measureDebugPhase } from "../electron/automation/debug-timing";
import type { DebugSessionReport } from "../shared/debug-report";
import type { Observation } from "../electron/automation/debug-step-context";
import { helperFrame, helperPackage, helperPayload, helperSerial, helperToken } from "./fixtures/helper-protocol";

async function fixture(options: {
  observe?: (read: number, signal: AbortSignal, original: () => Promise<Observation>) => Promise<Observation>;
} = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "inspector-capture-reference-")));
  const png = await sharp({ create: { width: 10, height: 20, channels: 4, background: "#123456" } }).png().toBuffer();
  let reads = 0, inputs = 0;
  const pids: number[] = [];
  const session = new DebugSession({ serial: helperSerial, packageName: helperPackage, directory,
    snapshotPath: join(directory, "current.json"), onEvent: () => {}, androidLogs: false,
    observe: async (_serial, _package, mode, signal, backend) => {
      assert.equal(mode, "fast"); assert.equal(backend, "accessibility-helper"); assert(signal); reads++; pids.push(process.pid);
      const original = async (): Promise<Observation> => {
        const payload = helperPayload(png.toString("base64"), 100 + reads * 10);
        payload.xml = payload.xml.replace('resource-id=""', `resource-id="${helperPackage}:id/page"`);
        const parsed = await readHelperObservation(12345, helperToken, helperPackage, helperFrame, signal,
          (async () => Response.json(payload)) as typeof fetch);
        return { snapshot: { serial: helperSerial, root: parsed.root, nodeCount: parsed.nodeCount,
          captureGeometry: parsed.captureGeometry, helperObservation: parsed.helperObservation, screenshotDataUrl: parsed.screenshotDataUrl,
          xmlSize: Buffer.byteLength(payload.xml), rawXml: payload.xml, error: null, warning: null,
          captureMode: "fast", inspectionSource: "accessibility-helper" },
        target: { packageName: helperPackage, activityName: ".Main", component: helperPackage + "/.Main",
          windowId: "7", activityRecordId: "activity-1" } };
      };
      return measureDebugPhase("observation", () => options.observe ? options.observe(reads, signal, original) : original(),
        { backend: "accessibility-helper" });
    }, input: async () => { inputs++; throw new Error("offline fixture must never input"); } });
  const args = (runId = randomUUID()) => ({ sessionId: session.state.id, runId,
    selector: { resourceId: helperPackage + ":id/page" }, expectedNodeCount: 2, timeoutMs: 3000 });
  const recording = (session as unknown as { recording: {
    directory: string; evidence: DebugEvidenceWriter; saveSession: (n: number) => void; saveSteps: () => void;
    finalizeTiming: (...args: unknown[]) => void;
  } }).recording;
  return { session, directory, recording, args, pids, counts: () => ({ reads, inputs }),
    report: () => JSON.parse(readFileSync(session.state.reportPath!, "utf8")) as DebugSessionReport,
    async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 500; i++) { if (condition()) return; await delay(5); }
  throw new Error("offline state did not arrive");
}

test("reference pair uses the same process and complete product steps; R1 final timing is durable before R2", async () => {
  let h: Awaited<ReturnType<typeof fixture>>;
  h = await fixture({ observe: async (read, _signal, original) => {
    if (read === 2) {
      const report = h.report(), steps = JSON.parse(readFileSync(join(h.recording.directory, "steps.json"), "utf8"));
      assert.equal(report.steps.length, 1); assert.equal(report.steps[0].step.status, "done");
      assert.equal(report.steps[0].step.timings?.status, "success");
      assert.deepEqual(report.steps[0].step.timings, steps.steps[0].timings);
      assert.ok(report.snapshots[0].tree && report.snapshots[0].screenshot);
    }
    return original();
  } });
  try {
    const result = await h.session.captureReferencePair(h.args());
    assert.equal(result.status, "passed", JSON.stringify(result.failure)); assert.equal(result.completeSuccess, true);
    assert.equal(result.waitVerified, false); assert.deepEqual(result.frames.map(f => f.role), ["R1", "R2"]);
    assert.deepEqual(result.frames.map(f => f.stepId), [1, 2]);
    assert.notEqual(result.frames[0].snapshotId, result.frames[1].snapshotId);
    assert(result.wait!.endedMs! - result.wait!.startedMs >= 350);
    assert(result.frames[1].requestStartedMs - result.frames[0].requestReturnedMs! >= 350);
    assert.deepEqual(h.pids, [process.pid, process.pid]); assert.deepEqual(h.counts(), { reads: 2, inputs: 0 });
    const report = h.report(); assert.equal(report.limits.maxBytes, 33554432);
    assert(report.steps.every(s => s.step.action === "capture_ui" && s.verified === null && !s.step.assertionConfirmation));
    assert(report.storage.bytes + DEBUG_FINAL_TIMING_RESERVE_BYTES < report.limits.maxBytes);
    assert.deepEqual(JSON.parse(readFileSync(result.manifestPath, "utf8")), result);
  } finally { await h.dispose(); }
});

test("the pair holds the session during its gap and rejects external captures, input, plans and another pair", async () => {
  const h = await fixture();
  try {
    const run = h.session.captureReferencePair(h.args());
    await until(() => h.session.state.steps[0]?.status === "done" && h.session.state.busy === true);
    assert(h.session.hasPendingWork);
    for (const command of [
      { name: "capture_ui", input: { sessionId: h.session.state.id, mode: "fast", backend: "accessibility-helper" } },
      { name: "press_back", input: { sessionId: h.session.state.id, snapshotId: randomUUID() } },
      { name: "start_debug_plan", input: { sessionId: h.session.state.id, runId: randomUUID(), definition: {
        version: 1, title: "must not interleave", backend: "accessibility-helper", timeoutMs: 1000,
        startConditions: [{ selector: { resourceId: helperPackage + ":id/page" }, state: "visible" }],
        finalConditions: [{ selector: { resourceId: helperPackage + ":id/page" }, state: "visible" }],
        steps: [{ id: "wait", kind: "wait", condition: { selector: { resourceId: helperPackage + ":id/page" }, state: "visible" }, timeoutMs: 1000 }],
      } } },
    ]) await assert.rejects(h.session.request(command), /参考对正在执行/);
    await assert.rejects(h.session.captureReferencePair(h.args()), /正在执行/);
    const status = await h.session.request({ name: "get_debug_session", input: {} }); assert.equal(status.busy, true);
    assert.equal((await run).status, "passed"); await h.session.settled();
    assert.equal(h.session.hasPendingWork, false); assert.deepEqual(h.counts(), { reads: 2, inputs: 0 });
  } finally { await h.dispose(); }
});

test("caller cancellation during 350ms gap keeps R1 and never starts R2", async () => {
  const h = await fixture(), caller = new AbortController();
  try {
    const run = h.session.captureReferencePair(h.args(), caller.signal);
    await until(() => h.session.state.steps[0]?.status === "done"); caller.abort(new Error("cancel reference"));
    const r = await run; assert.equal(r.status, "cancelled"); assert.equal(r.completeSuccess, false);
    assert.equal(r.frames.length, 1); assert.equal(h.report().steps.length, 1);
    assert.equal(h.report().steps[0].step.timings?.status, "success");
    assert.deepEqual(h.counts(), { reads: 1, inputs: 0 });
    assert.equal(JSON.parse(readFileSync(r.manifestPath, "utf8")).status, "cancelled");
  } finally { await h.dispose(); }
});

test("already-aborted callers leave a failed manifest without observations", async () => {
  const h = await fixture(), caller = new AbortController(); caller.abort();
  try {
    const r = await h.session.captureReferencePair(h.args(), caller.signal);
    assert.equal(r.status, "cancelled"); assert.equal(r.frames.length, 0);
    assert.equal(JSON.parse(readFileSync(r.manifestPath, "utf8")).completeSuccess, false);
    assert.deepEqual(h.counts(), { reads: 0, inputs: 0 });
  } finally { await h.dispose(); }
});

test("a session stop during the pair cancels the gap and settled waits for its archive", async () => {
  const h = await fixture();
  try {
    const run = h.session.captureReferencePair(h.args()); await until(() => h.session.state.steps[0]?.status === "done");
    await h.session.request({ name: "stop_debug_session", input: { sessionId: h.session.state.id } });
    await h.session.settled(); const r = await run;
    assert.equal(r.status, "cancelled"); assert.equal(h.session.state.active, false);
    assert.equal(h.session.hasPendingWork, false); assert.deepEqual(h.counts(), { reads: 1, inputs: 0 });
    assert.equal(JSON.parse(readFileSync(r.manifestPath, "utf8")).status, "cancelled");
  } finally { await h.dispose(); }
});

test("one total deadline includes R1, persistence, 350ms and R2 rather than resetting per frame", async () => {
  const budgets: boolean[] = [];
  const h = await fixture({ observe: async (read, signal, original) => {
    budgets.push(signal.aborted); await delay(read === 1 ? 100 : 900, undefined, { signal }); return original();
  } });
  try {
    const r = await h.session.captureReferencePair({ ...h.args(), timeoutMs: 1000 });
    assert.equal(r.status, "timed_out"); assert.equal(r.failure?.code, "duration_limit");
    assert.equal(r.frames.length, 2); assert.equal(r.frames[0].complete, true); assert.equal(r.frames[1].complete, false);
    assert.equal(h.report().steps[1].step.status, "failed");
    assert.equal(r.frames[1].afterFreshness, "previous"); assert.equal(r.frames[1].snapshotId, null);
    assert.equal(r.frames[1].afterSnapshotId, r.frames[0].snapshotId);
    assert.deepEqual(budgets, [false, false]); assert.equal(h.counts().inputs, 0);
  } finally { await h.dispose(); }
});

test("cancellation inside R1 awaits the owned capture cleanup before releasing the pair", async () => {
  let release!: () => void;
  const h = await fixture({ observe: async (_read, _signal, original) => {
    await new Promise<void>(r => { release = r; }); return original();
  } }), caller = new AbortController();
  try {
    const run = h.session.captureReferencePair(h.args(), caller.signal);
    await until(() => Boolean(release)); caller.abort(); assert(h.session.hasPendingWork);
    await assert.rejects(h.session.captureReferencePair(h.args()), /正在执行/);
    release(); const r = await run; await h.session.settled();
    assert.equal(r.status, "cancelled"); assert.equal(h.session.hasPendingWork, false);
    assert.deepEqual(h.counts(), { reads: 1, inputs: 0 });
    assert.equal(h.report().steps[0].step.status, "failed");
  } finally { release?.(); await h.dispose(); }
});

test("capacity reservation includes both maximum frames and final timing within the original 32MiB", async () => {
  const h = await fixture();
  try {
    h.recording.saveSession(0); const report = h.report();
    const reserve = captureReferenceBudget(report, 2);
    assert.equal(reserve.finalTimingReservePerFrame, DEBUG_FINAL_TIMING_RESERVE_BYTES);
    assert(reserve.requiredBytes >= 2 * (DEBUG_EVIDENCE_LIMITS.maxTreeBytes + DEBUG_EVIDENCE_LIMITS.maxImageBytes + DEBUG_FINAL_TIMING_RESERVE_BYTES));
    report.storage.bytes = report.limits.maxBytes - reserve.requiredBytes;
    assert.equal(captureReferenceBudget(report, 2).requiredBytes, reserve.requiredBytes);
    report.storage.bytes++;
    assert.throws(() => captureReferenceBudget(report, 2), /原容量/);
    report.limits.maxBytes = 33554433; assert.throws(() => captureReferenceBudget(report, 2), /原上限/);
  } finally { await h.dispose(); }
});

test("insufficient capacity blocks R1 and preserves the original quota", async () => {
  const h = await fixture();
  try {
    h.recording.evidence = new DebugEvidenceWriter(h.recording.directory, h.session.state, { maxBytes: 300_000 });
    const r = await h.session.captureReferencePair(h.args());
    assert.equal(r.status, "failed"); assert.equal(r.failure?.code, "capacity_reserved");
    assert.equal(r.frames.length, 0); assert.equal(h.report().limits.maxBytes, 300_000);
    assert.deepEqual(h.counts(), { reads: 0, inputs: 0 });
  } finally { await h.dispose(); }
});

test("a finalized timing write warning blocks R2 even if the capture itself succeeded", async () => {
  const h = await fixture();
  const original = h.recording.finalizeTiming.bind(h.recording);
  h.recording.finalizeTiming = (...args) => {
    original(...args); h.session.state.steps.at(-1)!.recordingErrors = [
      { category: "recording", phase: "recording", code: "timing_report_write_failed", message: "offline injected timing failure" },
    ];
  };
  try {
    const r = await h.session.captureReferencePair(h.args());
    assert.equal(r.status, "failed"); assert.equal(r.failure?.code, "recording_warning");
    assert.deepEqual(h.counts(), { reads: 1, inputs: 0 }); assert.equal(r.frames.length, 1);
    assert.equal(r.completeSuccess, false);
  } finally { await h.dispose(); }
});

test("a starting report/compatibility recording failure blocks both captures", async () => {
  const h = await fixture();
  try {
    h.recording.saveSteps = () => { throw new Error("offline compatibility write failure"); };
    const r = await h.session.captureReferencePair(h.args());
    assert.equal(r.status, "failed"); assert.equal(r.frames.length, 0);
    assert.deepEqual(h.counts(), { reads: 0, inputs: 0 });
    assert.match(r.failure!.message, /compatibility write failure/);
  } finally { await h.dispose(); }
});

test("R2 failure keeps the product failed step, previous R1 and a complete reimportable archive", async () => {
  const h = await fixture({ observe: async (read, _signal, original) => {
    if (read === 2) throw new Error("offline second capture failure"); return original();
  } });
  const destination = realpathSync(mkdtempSync(join(tmpdir(), "inspector-reference-export-")));
  try {
    const r = await h.session.captureReferencePair(h.args()); assert.equal(r.status, "failed");
    assert.deepEqual(r.frames.map(f => f.stepId), [1, 2]);
    assert.equal(r.frames[1].afterFreshness, "previous"); assert.equal(r.frames[1].snapshotId, null);
    h.session.stop(); await h.session.settled();
    const bytes = readFileSync(h.session.state.reportPath!);
    const exported = await exportDebugReportEvidence({ filePath: h.session.state.reportPath!,
      reportSha256: createHash("sha256").update(bytes).digest("hex") }, {
      requestId: randomUUID(), sourceId: h.session.state.id, reportSha256: createHash("sha256").update(bytes).digest("hex"),
      stepIds: [1, 2], includeTrees: true, includeScreenshots: true, includeLogs: true,
    }, destination, { appVersion: "offline-reference-test", signal: AbortSignal.timeout(5000) });
    assert(exported.directory && !exported.error && !exported.canceled, JSON.stringify(exported));
    rmSync(join(h.directory, h.session.state.id), { recursive: true });
    const reloaded = await loadTestReport(join(exported.directory, "report.json"));
    assert.deepEqual(reloaded.debug!.steps.map(s => s.step.id), [1, 2]);
    assert.equal(reloaded.debug!.steps[1].step.status, "failed"); assert.equal(reloaded.debug!.steps[1].after.freshness, "previous");
    assert(reloaded.images.every(i => i.dataUrl && !i.error));
    const keep = process.env.INSPECTOR_REFERENCE_OFFLINE_EVIDENCE;
    if (keep) {
      mkdirSync(keep, { recursive: true });
      const fs = await import("node:fs"); const retained = join(keep, "failed-reference");
      fs.cpSync(exported.directory, retained, { recursive: true, errorOnExist: true, force: false });
      writeFileSync(join(keep, "failed-reference-manifest.json"), JSON.stringify({ offlineOnly: true, ...r }, null, 2), { flag: "wx" });
    }
  } finally { await h.dispose(); rmSync(destination, { recursive: true, force: true }); }
});

test("duplicate run IDs never replay or overwrite a previous manifest", async () => {
  const h = await fixture();
  try {
    const args = h.args(), first = await h.session.captureReferencePair(args), before = readFileSync(first.manifestPath);
    await assert.rejects(h.session.captureReferencePair(args), /EEXIST/);
    assert.deepEqual(readFileSync(first.manifestPath), before); assert.deepEqual(h.counts(), { reads: 2, inputs: 0 });
  } finally { await h.dispose(); }
});

test("tampering with the gap journal stops R2 without overwriting the foreign bytes", async () => {
  const h = await fixture();
  try {
    const args = h.args(), run = h.session.captureReferencePair(args);
    await until(() => h.session.state.steps[0]?.status === "done");
    const path = join(h.recording.directory, `reference-${args.runId}.json`);
    writeFileSync(path, "foreign journal");
    await assert.rejects(run, /reference_manifest_write_failed/);
    assert.equal(readFileSync(path, "utf8"), "foreign journal"); assert.equal(h.counts().reads, 1);
  } finally { await h.dispose(); }
});

test("foreign/expired grants and client protocol attempts do not invoke the fixture", async () => {
  const h = await fixture();
  try {
    await assert.rejects(h.session.captureReferencePair({ ...h.args(), sessionId: randomUUID() }), /有效授权/);
    h.session.state.expiresAt = new Date(Date.now() + 100).toISOString();
    await assert.rejects(h.session.captureReferencePair(h.args()), /授权不足/);
    assert.equal(debugCommand.safeParse({ name: "capture_reference_pair", input: h.args() }).success, false);
    assert.deepEqual(h.counts(), { reads: 0, inputs: 0 });
  } finally { await h.dispose(); }
});

test("deadline expiry in the persisted R1 gap never starts a second capture", async () => {
  const h = await fixture({ observe: async (_read, signal, original) => {
    await delay(800, undefined, { signal }); return original();
  } });
  try {
    const r = await h.session.captureReferencePair({ ...h.args(), timeoutMs: 1000 });
    assert.equal(r.status, "timed_out"); assert.equal(r.failure?.code, "duration_limit");
    assert.equal(r.frames.length, 1); assert.equal(r.frames[0].complete, true);
    assert.equal(h.report().steps[0].step.timings?.status, "success");
    assert.deepEqual(h.counts(), { reads: 1, inputs: 0 });
  } finally { await h.dispose(); }
});

test("a real writer attachment-capacity warning preserves failure instead of starting R2", async () => {
  const h = await fixture();
  try {
    h.recording.evidence = new DebugEvidenceWriter(h.recording.directory, h.session.state, { maxImageBytes: 1 });
    const r = await h.session.captureReferencePair(h.args());
    assert.equal(r.status, "failed"); assert.equal(r.failure?.code, "recording_warning");
    assert(h.report().snapshots.some(s => !s.screenshot && s.warnings.length > 0));
    assert.deepEqual(h.counts(), { reads: 1, inputs: 0 });
  } finally { await h.dispose(); }
});

test("node-count mismatches and incomplete Helper evidence do not become reference frames", async () => {
  const mismatch = await fixture();
  try {
    const r = await mismatch.session.captureReferencePair({ ...mismatch.args(), expectedNodeCount: 69 });
    assert.equal(r.status, "failed"); assert.equal(r.failure?.code, "capture_identity");
    assert.deepEqual(mismatch.counts(), { reads: 1, inputs: 0 });
  } finally { await mismatch.dispose(); }
  const incomplete = await fixture({ observe: async (_read, _signal, original) => {
    const observation = await original();
    (observation.snapshot.helperObservation as unknown as { complete: boolean }).complete = false;
    return observation;
  } });
  try {
    const r = await incomplete.session.captureReferencePair(incomplete.args());
    assert.equal(r.status, "failed"); assert.equal(r.completeSuccess, false);
    assert.deepEqual(incomplete.counts(), { reads: 1, inputs: 0 });
  } finally { await incomplete.dispose(); }
});

test("two individually valid captures from different Helper services cannot pass the pair", async () => {
  const h = await fixture({ observe: async (read, _signal, original) => {
    const result = await original();
    if (read === 2) result.snapshot.helperObservation!.serviceInstanceId = randomUUID();
    return result;
  } });
  try {
    const r = await h.session.captureReferencePair(h.args());
    assert.equal(r.status, "failed"); assert.equal(r.failure?.code, "conditions_not_proved");
    assert.equal(r.waitVerified, false); assert.equal(r.frames.length, 2);
    assert.deepEqual(h.counts(), { reads: 2, inputs: 0 });
  } finally { await h.dispose(); }
});
