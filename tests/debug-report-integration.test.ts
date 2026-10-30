import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import sharp from "sharp";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession } from "../electron/automation/debug-session";
import { loadTestReport } from "../electron/desktop/test-report";
import type { DebugSessionReport } from "../shared/debug-report";
import type { UiSnapshot } from "../shared/types";
import { businessMetadataFixture } from "./fixtures/debug-metadata";

const packageName = "com.example.offline";
const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "offline" };
async function picture(color: string) {
  const data = await sharp({ create: { width: 160, height: 320, channels: 4, background: color } }).png().toBuffer();
  return `data:image/png;base64,${data.toString("base64")}`;
}
function snapshot(image: string, text: string): UiSnapshot {
  const root = makeNode("0"), button = makeNode("0/0");
  root.package = button.package = packageName;
  root.clickable = false;
  root.bounds = { left: 0, top: 0, right: 160, bottom: 320, raw: "[0,0][160,320]" };
  button.bounds = { left: 10, top: 20, right: 90, bottom: 64, raw: "[10,20][90,64]" };
  button.text = text; button.resourceId = `${packageName}:id/button`;
  button.clickable = button.enabled = button.visibleToUser = true;
  root.children = [button];
  const frame = { width: 160, height: 320, rotation: 0 as const };
  return { serial: "offline-device", root, nodeCount: 2, xmlSize: 0, rawXml: null,
    screenshotDataUrl: image, error: null, warning: null, captureMode: "fast", inspectionSource: "uiautomator",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } };
}
function rawReport(session: DebugSession) {
  assert.ok(session.state.reportPath);
  return JSON.parse(readFileSync(session.state.reportPath, "utf8")) as DebugSessionReport;
}

test("offline debug report retains explicitly registered typed business values", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-business-report-"));
  const source = snapshot(await picture("#fafafa"), "Business card");
  source.inspectionSource = "debug-hybrid"; source.captureMode = "deep";
  source.root!.children[0].debugMetadata = structuredClone(businessMetadataFixture);
  const session = new DebugSession({ serial: source.serial, packageName, directory,
    snapshotPath: join(directory, "current.json"), onEvent: () => {},
    observe: async () => ({ snapshot: source, target }), input: async () => { throw new Error("This read-only check cannot dispatch inputs"); },
  });
  try {
    await session.request({ name: "capture_ui", input: { sessionId: session.state.id, mode: "deep" } });
    session.stop("Offline business metadata check"); await session.settled();
    const loaded = await loadTestReport(session.state.reportPath!);
    assert.deepEqual(loaded.debug!.snapshots[0].snapshot?.root!.children[0].debugMetadata, businessMetadataFixture);
    assert.equal(loaded.debug!.snapshots[0].snapshot?.screenshotDataUrl, null);
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("authorized offline session records successful actions and imports them without claiming task success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-debug-report-pipeline-"));
  const beforeImage = await picture("#fafafa"), afterImage = await picture("#ddeeff");
  let changed = false, captureFailure = false, inputs = 0;
  const session = new DebugSession({ serial: "offline-device", packageName, directory,
    snapshotPath: join(directory, "current.json"), onEvent: () => {},
    observe: async () => {
      if (captureFailure) throw new Error("Offline fixture observation failed");
      return { snapshot: snapshot(changed ? afterImage : beforeImage, changed ? "UPDATED CHILD" : "RED CHILD"), target };
    },
    input: async (_serial, _target, _action, _frame, _signal, onEvidence) => {
      inputs++; changed = true;
      onEvidence?.({ classification: "accepted", spawned: true, closed: true, exitCode: 0, signal: null,
        durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false });
    },
  });
  const sessionId = session.state.id;
  try {
    const initial = await session.request({ name: "capture_ui", input: { sessionId } });
    const action = await session.request({ name: "tap_node", input: { sessionId, snapshotId: initial.snapshotId, nodeId: "0/0" } });
    assert.equal(action.verified, false); assert.equal(inputs, 1);
    const check = await session.request({ name: "wait_for_ui", input: { sessionId, selector: { text: "UPDATED CHILD" }, timeoutMs: 1000 } });
    assert.equal(check.verified, true);
    captureFailure = true;
    const failed = await session.request({ name: "capture_ui", input: { sessionId } });
    assert.equal(failed.isError, true); assert.equal(inputs, 1);
    session.stop("Offline fixture finished"); await session.settled();
    const raw = rawReport(session);
    assert.equal(raw.session.active, false);
    assert.equal(raw.steps.length, 4);
    assert.equal(raw.steps[1].verified, false); assert.equal(raw.steps[2].verified, true);
    assert.equal(raw.steps[3].step.error?.phase, "capture");
    assert.notEqual(raw.steps[3].after.freshness, "current");
    const imported = await loadTestReport(session.state.reportPath!);
    assert.equal(imported.index.schemaVersion, "inspector-debug-index-1");
    assert.notEqual(imported.index.run.status, "passed"); assert.equal(imported.index.run.exitCode, null);
    const steps = imported.index.cases[0].attempts[0].steps;
    assert.equal(steps[1].status, "completed"); assert.equal(steps[2].status, "passed");
    assert.equal(steps[3].error?.phase, "capture");
    const record = imported.debug!.steps[1];
    for (const ref of [record.before, record.after]) {
      const saved = imported.debug!.snapshots.find(value => value.evidence.snapshotId === ref.snapshotId)!;
      assert.ok(saved.snapshot?.root); assert.equal(saved.snapshot.screenshotDataUrl, null);
      assert.ok(imported.images.some(value => value.artifactId === saved.screenshotArtifactId && value.dataUrl));
    }
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("stop during input preserves accepted pre-action evidence, uncertain delivery, and a readable stopped record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-debug-report-cancel-pipeline-"));
  const image = await picture("#f0f0f0"); let entered = false, observations = 0;
  const session = new DebugSession({ serial: "offline-device", packageName, directory,
    snapshotPath: join(directory, "current.json"), onEvent: () => {},
    observe: async () => { observations++; return { snapshot: snapshot(image, "RED CHILD"), target }; },
    input: async (_serial, _target, _action, _frame, signal) => {
      entered = true;
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  try {
    const initial = await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    const pending = session.request({ name: "tap_node", input: { sessionId: session.state.id, snapshotId: initial.snapshotId, nodeId: "0/0" } });
    for (let i = 0; !entered && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(entered, true);
    session.stop("Offline cancellation"); await pending; await session.settled();
    const raw = rawReport(session), last = raw.steps.at(-1)!;
    assert.equal(raw.session.active, false); assert.equal(last.step.dispatchState, "unknown");
    assert.ok(last.before.snapshotId); assert.equal(last.after.snapshotId, null); assert.equal(observations, 2);
    const imported = await loadTestReport(session.state.reportPath!);
    const before = imported.debug!.snapshots.find(value => value.evidence.snapshotId === last.before.snapshotId)!;
    assert.ok(before.snapshot?.root); assert.ok(before.screenshotArtifactId);
    assert.notEqual(imported.index.run.status, "passed");
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});

test("rolling records remain importable with bounded, referenced artifacts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-debug-report-retention-pipeline-"));
  const image = await picture("#eeeeee");
  const session = new DebugSession({ serial: "offline-device", packageName, directory,
    snapshotPath: join(directory, "current.json"), onEvent: () => {},
    observe: async () => ({ snapshot: snapshot(image, "RED CHILD"), target }) });
  try {
    for (let i = 0; i < 102; i++) await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    session.stop(); await session.settled();
    const raw = rawReport(session);
    assert.equal(raw.steps.length, 100); assert.equal(raw.session.totalSteps, 102); assert.equal(raw.session.droppedSteps, 2);
    assert.ok(raw.storage.bytes <= raw.limits.maxBytes);
    const files = new Set(raw.snapshots.flatMap(value => [value.tree?.path, value.screenshot?.path].filter((path): path is string => Boolean(path))));
    assert.equal(readdirSync(join(directory, session.state.id, "artifacts")).length, files.size);
    const imported = await loadTestReport(session.state.reportPath!);
    assert.equal(imported.debug!.steps.length, 100); assert.equal(imported.debug!.session.droppedSteps, 2);
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
});
