import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { DebugSession } from "../electron/automation/debug-session";
import { loadTestReport } from "../electron/desktop/test-report";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const serial = "helper-fixture", packageName = "com.example.helper";
const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "window", activityRecordId: "activity" };
const condition = { selector: { resourceId: `${packageName}:id/result` }, state: "visible", visibility: "partial" };
const image = sharp({ create: { width: 100, height: 200, channels: 3, background: "blue" } }).png().toBuffer();
function harness(configure: (snapshot: ReturnType<typeof helperEvidenceSnapshot>, read: number, signal: AbortSignal) => void | Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "partial-wait-stability-")); let reads = 0, inputs = 0;
  const session = new DebugSession({ serial, packageName, directory, snapshotPath: join(directory, "current.json"), onEvent() {},
    observe: async (_s, _p, _m, signal) => {
      assert(signal);
      const snapshot = helperEvidenceSnapshot({ startedAt: ++reads * 100 }); await configure(snapshot, reads, signal);
      snapshot.screenshotDataUrl = `data:image/png;base64,${(await image).toString("base64")}`;
      signal.throwIfAborted(); return { snapshot, target };
    }, input: async (_s, _t, _a, _f, _signal, onEvidence) => { inputs++; onEvidence?.({ classification: "accepted", spawned: true,
      closed: true, exitCode: 0, signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }); } });
  return { session, counts: () => ({ reads, inputs }), async capture() {
    return session.request({ name: "capture_ui", input: { sessionId: session.state.id, mode: "fast", backend: "accessibility-helper" } });
  }, async wait(timeoutMs = 3000) { return session.request({ name: "wait_for_ui", input: { sessionId: session.state.id, ...condition, timeoutMs } }); },
  async dispose() { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); } };
}

test("a transient partial identity change discards both frames and verifies a new stable pair", async () => {
  const h = harness((snapshot, read) => { snapshot.root!.id = read < 3 ? "0/0" : "0/1"; });
  try {
    await h.capture(); const result = await h.wait();
    assert.equal(result.verified, true); assert.deepEqual(h.counts(), { reads: 5, inputs: 0 });
    const report = await loadTestReport(h.session.state.reportPath!);
    const entry = report.debug!.steps.at(-1)!; assert.equal(entry.verified, true);
    const proof = entry.step.assertionConfirmation!;
    const first = report.debug!.snapshots.find(item => item.evidence.snapshotId === proof.first.snapshotId)!.snapshot!;
    const second = report.debug!.snapshots.find(item => item.evidence.snapshotId === proof.second.snapshotId)!.snapshot!;
    assert.equal(first.root!.id, "0/1"); assert.equal(second.root!.id, "0/1");
    assert.equal(first.helperObservation!.timing.startedAtMs, 400); assert.equal(second.helperObservation!.timing.startedAtMs, 500);
  } finally { await h.dispose(); }
});

test("repeated partial identity changes stop after one fresh-pair restart", async () => {
  const h = harness((snapshot, read) => { snapshot.root!.id = `0/${read}`; });
  try {
    await h.capture(); assert.equal((await h.wait()).isError, true);
    assert.deepEqual(h.counts(), { reads: 5, inputs: 0 }); assert.equal(h.session.state.steps.at(-1)!.assertionConfirmation, undefined);
  } finally { await h.dispose(); }
});

test("identity restart does not retry changed source, windows or ambiguous targets", async () => {
  for (const change of ["service", "window", "ambiguous"] as const) {
    const h = harness((snapshot, read) => {
      if (read < 3) return;
      snapshot.root!.id = "0/1";
      if (change === "service") snapshot.helperObservation!.serviceInstanceId = randomUUID();
      if (change === "window") {
        snapshot.helperObservation!.windowId = "8";
        for (const windows of [snapshot.helperObservation!.windowsBefore, snapshot.helperObservation!.windowsAfter]) windows[0].id = "8";
        snapshot.root!.attributes!["window-id"] = "8";
      }
      if (change === "ambiguous") { snapshot.root!.children = [{ ...structuredClone(snapshot.root!), id: "duplicate", children: [] }]; snapshot.nodeCount++; }
    });
    try { await h.capture(); assert.equal((await h.wait()).isError, true, change); assert.equal(h.counts().reads, 3); assert.equal(h.counts().inputs, 0); }
    finally { await h.dispose(); }
  }
});

test("a partial action expectation restarts only reads and never dispatches its input twice", async () => {
  const h = harness((snapshot, read) => { snapshot.root!.id = read < 4 ? "0/0" : "0/1"; });
  try {
    await h.capture(); const input = { sessionId: h.session.state.id, requestId: randomUUID(), backend: "accessibility-helper",
      target: { selector: condition.selector }, action: { kind: "tap" }, expect: condition, timeoutMs: 3000 };
    const result = await h.session.request({ name: "perform_ui_step", input });
    assert.equal(result.verified, true); assert.deepEqual(h.counts(), { reads: 6, inputs: 1 });
    assert.equal((await h.session.request({ name: "perform_ui_step", input })).replayed, true);
    assert.deepEqual(h.counts(), { reads: 6, inputs: 1 });
    assert.equal((await loadTestReport(h.session.state.reportPath!)).debug!.steps.at(-1)!.verified, true);
  } finally { await h.dispose(); }
});

test("identity restart keeps the original deadline and cancellation", async () => {
  for (const cancel of [false, true]) {
    const h = harness(async (snapshot, read, signal) => {
      snapshot.root!.id = read < 3 ? "0/0" : "0/1";
      if (read !== 4) return;
      if (cancel) h.session.stop();
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      });
    });
    try {
      await h.capture(); assert.equal((await h.wait(1000)).isError, true);
      assert.deepEqual(h.counts(), { reads: 4, inputs: 0 });
      assert.equal(h.session.state.steps.at(-1)!.assertionConfirmation, undefined);
    } finally { await h.dispose(); }
  }
});
