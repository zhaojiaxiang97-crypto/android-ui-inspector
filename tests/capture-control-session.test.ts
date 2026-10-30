import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { DebugSession } from "../electron/automation/debug-session";
import { readHelperObservation } from "../electron/capture/helper-observation";
import { measureDebugPhase } from "../electron/automation/debug-timing";
import { executeControlBlock, closeControlSession, type ControlTarget } from "../scripts/capture-control-session";
import { matrixLimits, treatments, type ControlBlock } from "../scripts/capture-control-protocol";
import { DEBUG_EVIDENCE_LIMITS } from "../electron/automation/debug-evidence";
import type { DebugSessionReport } from "../shared/debug-report";
import { helperPayload, helperPackage, helperSerial, helperFrame, helperToken, helperServiceId } from "./fixtures/helper-protocol";

async function fixture(options: { failAt?: number; cancelAt?: number; limits?: Partial<DebugSessionReport["limits"]>; omitLimits?: boolean; delayAt?: number } = {}) {
  const evidence = process.env.INSPECTOR_CONTROL_OFFLINE_EVIDENCE;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const directory = realpathSync(mkdtempSync(join(evidence ?? tmpdir(), "capture-control-session-")));
  const png = await sharp({ create: { width: 10, height: 20, channels: 4, background: "#123456" } }).png().toBuffer();
  let reads = 0, inputs = 0;
  const controller = new AbortController();
  const target: ControlTarget = { serial: helperSerial, packageName: helperPackage, helperPid: 123, serviceId: helperServiceId,
    ...helperFrame, nodeCounts: { small: 2, large: 2 }, selectors: { small: helperPackage + ":id/page", large: helperPackage + ":id/page" } };
  const session = new DebugSession({ directory, snapshotPath: join(directory, "snapshot.json"), serial: helperSerial,
    packageName: helperPackage, androidLogs: false, onEvent: () => {}, recordingLimits: options.omitLimits ? undefined : { ...matrixLimits, ...options.limits },
    input: async () => { inputs++; throw Error("Offline fixture cannot input"); },
    observe: async (_s, _p, _mode, signal) => measureDebugPhase("observation", async () => {
      reads++; assert(signal);
      if (reads === options.failAt) throw Error("offline observation fault");
      if (reads === options.cancelAt) controller.abort(new Error("offline cancel"));
      if (reads === options.delayAt) await delay(1000, undefined, { signal });
      const payload = helperPayload(png.toString("base64"), 100 + reads * 10);
      payload.xml = payload.xml.replace('resource-id=""', `resource-id="${target.selectors.small}"`);
      const parsed = await readHelperObservation(12345, helperToken, helperPackage, helperFrame, signal, (async () => Response.json(payload)) as typeof fetch);
      return { snapshot: { serial: helperSerial, root: parsed.root, nodeCount: parsed.nodeCount, captureGeometry: parsed.captureGeometry,
        helperObservation: parsed.helperObservation, screenshotDataUrl: parsed.screenshotDataUrl, rawXml: payload.xml, xmlSize: Buffer.byteLength(payload.xml),
        error: null, warning: null, captureMode: "fast", inspectionSource: "accessibility-helper" }, target: {
        packageName: helperPackage, activityName: ".Main", component: helperPackage + "/.Main", windowId: "7", activityRecordId: "activity-1" } };
    }, { backend: "accessibility-helper" }) });
  const block = (treatment: ControlBlock["treatment"]): ControlBlock => ({ id: "offline-" + treatment, page: "small", segment: "diagnostic", treatment,
    period: 1, chunk: "offline-chunk", limits: options.omitLimits ? DEBUG_EVIDENCE_LIMITS : { ...matrixLimits, ...options.limits } });
  return { directory, target, session, block, controller, counts: () => ({ reads, inputs }),
    async dispose() { session.stop(); await session.settled();
      if (!evidence) rmSync(directory, { recursive: true, force: true }); } };
}
for (const treatment of ["A", "B", "C", "D"] as const) test(`${treatment} uses real same-process product capture/wait/reference and archives all three frames`, async () => {
  const h = await fixture(); const checkpoints: string[] = [];
  try {
    const result = await executeControlBlock(h.session, h.block(treatment), h.target, h.controller.signal, r => {
      checkpoints.push(r.status);
      if (r.requests.at(-1)?.status === "passed") {
        const report = JSON.parse(readFileSync(r.reportPath!, "utf8")) as DebugSessionReport;
        assert(report.steps.every(s => s.step.timings?.status === "success"));
      }
    });
    assert.equal(result.status, "passed", result.failure); assert.deepEqual(result.frames.map(f => f.role), treatments[treatment]);
    assert.equal(new Set(result.frames.map(f => f.snapshotId)).size, 3);
    assert.equal(new Set(result.frames.map(f => f.sessionId)).size, 1);
    assert.equal(result.requests.reduce((n, r) => n + r.attempts, 0), 3);
    assert.equal(result.requests.reduce((n, r) => n + r.complete, 0), 3);
    const reference = result.requests.find(r => r.referenceManifest);
    if (reference) {
      const journal = JSON.parse(readFileSync(reference.referenceManifest!, "utf8"));
      assert.equal(journal.ownerPid, process.pid); assert.equal(journal.waitVerified, false);
      assert(journal.wait.endedMs - journal.wait.startedMs >= 350);
    }
    const archived = await closeControlSession(h.session); assert.equal(archived.closed, true);
    assert(checkpoints.length >= 5); assert.deepEqual(h.counts(), { reads: 3, inputs: 0 });
  } finally { await h.dispose(); }
});
test("two original A blocks share exactly one six-frame sentinel session with lowered recording caps", async () => {
  const h = await fixture(); try {
    for (let i = 0; i < 2; i++) assert.equal((await executeControlBlock(h.session, { ...h.block("A"), id: `sentinel-${i}` }, h.target,
      h.controller.signal, () => {})).status, "passed");
    const r = JSON.parse(readFileSync(h.session.state.reportPath!, "utf8")) as DebugSessionReport;
    assert.equal(r.snapshots.length, 6); assert.equal(r.steps.length, 4); assert.deepEqual(r.limits, matrixLimits);
    assert(r.snapshots.every(s => s.tree && s.screenshot && s.warnings.length === 0));
    assert.deepEqual(h.counts(), { reads: 6, inputs: 0 });
  } finally { await h.dispose(); }
});
test("failure in R2 preserves R1 manifest, actual attempts and failed step without a retry", async () => {
  const h = await fixture({ failAt: 3 }); try {
    const result = await executeControlBlock(h.session, h.block("C"), h.target, h.controller.signal, () => {});
    assert.equal(result.status, "failed"); assert.equal(result.requests.reduce((n, r) => n + r.attempts, 0), 3);
    assert.equal(result.requests.reduce((n, r) => n + r.complete, 0), 2);
    const manifest = JSON.parse(readFileSync(result.requests[1].referenceManifest!, "utf8"));
    assert.equal(manifest.status, "failed"); assert.equal(manifest.frames[0].complete, true);
    assert.equal(manifest.frames[1].snapshotId, null); assert.equal(manifest.frames[1].afterFreshness, "previous");
    const archive = await closeControlSession(h.session);
    const report = JSON.parse(readFileSync(archive.reportPath, "utf8")) as DebugSessionReport;
    assert.equal(report.steps[2].step.status, "failed"); assert.equal(report.steps[2].after.snapshotId, manifest.frames[0].snapshotId);
    assert.deepEqual(h.counts(), { reads: 3, inputs: 0 });
  } finally { await h.dispose(); }
});
test("cancelled first request is indexed and cannot continue the remaining pair", async () => {
  const h = await fixture({ cancelAt: 1 }); try {
    const r = await executeControlBlock(h.session, h.block("A"), h.target, h.controller.signal, () => {});
    assert.equal(r.status, "cancelled"); assert.equal(r.requests.length, 1); assert.equal(h.counts().reads, 1);
    assert((await closeControlSession(h.session)).closed);
  } finally { await h.dispose(); }
});
test("operation timeout settles the product operation before the session closes", async () => {
  const h = await fixture({ delayAt: 1 }); try {
    const r = await executeControlBlock(h.session, h.block("D"), h.target, AbortSignal.timeout(30), () => {});
    assert.equal(r.status, "cancelled"); assert.equal(h.counts().reads, 1); assert(!h.session.hasPendingWork);
    assert((await closeControlSession(h.session)).closed);
  } finally { await h.dispose(); }
});
test("lower attachment cap fails visibly without image rewriting or a second operation", async () => {
  const h = await fixture({ limits: { maxImageBytes: 1 } }); try {
    const r = await executeControlBlock(h.session, h.block("A"), h.target, h.controller.signal, () => {});
    assert.equal(r.status, "failed"); assert.equal(h.counts().reads, 1); assert.equal(r.requests.length, 1);
    assert((JSON.parse(readFileSync(h.session.state.reportPath!, "utf8")) as DebugSessionReport).snapshots.some(s => !s.screenshot));
  } finally { await h.dispose(); }
});
test("ordinary application session keeps original default limits", async () => {
  const h = await fixture({ omitLimits: true }); try {
    const r = await executeControlBlock(h.session, h.block("A"), h.target, h.controller.signal, () => {});
    assert.equal(r.status, "passed", r.failure);
    assert.deepEqual((JSON.parse(readFileSync(r.reportPath!, "utf8")) as DebugSessionReport).limits, DEBUG_EVIDENCE_LIMITS);
  } finally { await h.dispose(); }
});
test("a rejected actual first-dispatch guard leaves zero reads and the original reason", async () => {
  const h = await fixture(); try {
    const result = await executeControlBlock(h.session, h.block("A"), h.target, h.controller.signal, () => {}, () => { throw Error("fixed dispatch missed"); });
    assert.equal(result.status, "failed"); assert.match(result.failure!, /fixed dispatch missed/);
    assert.deepEqual(h.counts(), { reads: 0, inputs: 0 }); assert.equal(result.requests[0].attempts, 0);
    assert((await closeControlSession(h.session)).closed);
  } finally { await h.dispose(); }
});
test("expiry during R1/R2 gap retains the first frame and starts no second observation", async () => {
  const h = await fixture(); try {
    const running = executeControlBlock(h.session, h.block("D"), h.target, h.controller.signal, () => {});
    for (let i = 0; i < 500 && h.session.state.steps[0]?.status !== "done"; i++) await delay(2);
    assert.equal(h.session.state.steps[0]?.status, "done");
    h.session.state.expiresAt = new Date(Date.now() - 1).toISOString();
    const result = await running; assert.equal(result.status, "failed"); assert.equal(result.failureCode, "grant_expired");
    assert.deepEqual(h.counts(), { reads: 1, inputs: 0 }); assert.equal(result.requests.length, 1);
    const manifest = JSON.parse(readFileSync(result.requests[0].referenceManifest!, "utf8"));
    assert.equal(manifest.frames.length, 1); assert.equal(manifest.frames[0].complete, true); assert.equal(manifest.status, "failed");
    assert((await closeControlSession(h.session)).closed);
  } finally { await h.dispose(); }
});
