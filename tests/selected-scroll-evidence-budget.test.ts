import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { makeNode } from "../benchmarks/fixtures";
import { exportDebugReportEvidence } from "../electron/desktop/debug-report-export";
import { loadTestReport } from "../electron/desktop/test-report";
import { DEBUG_SNAPSHOT_VERSION, type DebugReportStep } from "../shared/debug-report";
import { debugSnapshotPriorities } from "../shared/debug-evidence-priority";
import { inspectRegressionEvidence } from "../scripts/automation-ui-regression";
import { makeDebugReportExportFixture } from "./fixtures/debug-report-export";

const MiB = 1024 * 1024, width = 1024, height = 960;
let images: Promise<Buffer[]> | undefined;
function noiseImages() {
  return images ??= (async () => {
    const result: Buffer[] = [];
    for (let seed = 1; seed <= 9; seed++) {
      const pixels = Buffer.alloc(width * height * 3);
      let state = seed;
      for (let i = 0; i < pixels.length; i++) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5; pixels[i] = state & 255;
      }
      result.push(await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer());
    }
    return result;
  })();
}

async function scrollExportFixture(selectedCount: 4 | 6) {
  const f = await makeDebugReportExportFixture(), pngs = await noiseImages();
  const { id: sessionId, serial, packageName } = f.report.session;
  const at = (second: number) => new Date(Date.parse(f.report.session.startedAt) + second * 1000).toISOString();
  f.report.snapshots = []; f.report.steps = []; f.report.session.totalSteps = 4;
  f.report.session.updatedAt = at(12);
  for (let i = 0; i < 3 + selectedCount; i++) {
    const snapshotId = randomUUID(), capturedAt = at(i), root = makeNode("0"); root.package = packageName;
    const tree = Buffer.from(JSON.stringify({ schemaVersion: DEBUG_SNAPSHOT_VERSION, content: "tree-properties-without-layer-bitmaps",
      snapshotId, capturedAt, snapshot: { serial, root, nodeCount: 1, xmlSize: 0, rawXml: null, screenshotDataUrl: null,
        error: null, warning: null, inspectionSource: "uiautomator", captureMode: "fast" } }));
    f.report.snapshots.push({ snapshotId, capturedAt, source: "uiautomator", warnings: [],
      tree: f.artifact(tree, "json"), screenshot: f.artifact(pngs[i], "png") });
    if (i < 3) f.report.steps.push({ step: { id: i + 1, time: at(i), action: "wait_for_ui",
      input: { sessionId, selector: { text: "fixture" }, state: "visible", timeoutMs: 1000 },
      status: "failed", message: "historical failure", afterId: snapshotId,
      error: { category: "timeout", code: "timeout", phase: "verify", message: "fixture timeout" } },
      finishedAt: at(i + 1), durationMs: 1000, verified: false,
      before: { snapshotId: null, freshness: "missing", reason: "no earlier observation" },
      after: { snapshotId, freshness: "current", reason: null } });
  }
  const selected = f.report.snapshots.slice(3).map(item => item.snapshotId);
  const scrolling: DebugReportStep = { step: { id: 4, time: at(3), action: "scroll_until", status: "done", message: "fixture end reached",
    input: { sessionId, requestId: randomUUID(), backend: "uiautomator", target: { selector: { resourceId: packageName + ":id/list" } },
      direction: "down", until: { kind: "end_marker", selector: { resourceId: packageName + ":id/end" } }, maxScrolls: 6, timeoutMs: 10000 },
    beforeId: selected[0], afterId: selected.at(-1), dispatchState: "sent", verified: true,
    scrollTask: { stopReason: "end_reached", observationIds: selected,
      confirmation: { firstSnapshotId: selected.at(-2)!, secondSnapshotId: selected.at(-1)!, kind: "end_marker" },
      iterations: Array.from({ length: selectedCount - 2 }, (_, i) => ({ index: i + 1, startedAt: at(3 + i), durationMs: 1,
        beforeId: selected[i], afterId: selected[i + 1], dispatchState: "sent", progress: "changed",
        resolvedInput: { action: { kind: "swipe", fromX: 50, fromY: 100, toX: 50, toY: 50, durationMs: 350 },
          frame: { width, height, rotation: 0 } } })) } },
    finishedAt: at(12), durationMs: 9000, verified: true,
    before: { snapshotId: selected[0], freshness: "current", reason: null },
    after: { snapshotId: selected.at(-1)!, freshness: "current", reason: null } };
  f.report.steps.push(scrolling); f.save();
  return { ...f, selected, scrolling, selectedBytes: pngs.slice(3, 3 + selectedCount).reduce((sum, value) => sum + value.length, 0) };
}

test("only explicitly selected scroll references get export priority, including observation-only and iteration-only references", async () => {
  const f = await scrollExportFixture(4);
  try {
    const middle = f.selected[1], selected = new Set([4]);
    assert.equal(debugSnapshotPriorities(f.report).get(middle), 1);
    assert.equal(debugSnapshotPriorities(f.report, new Set([1])).get(middle), 1);
    assert.equal(debugSnapshotPriorities(f.report, selected).get(middle), 5);
    assert.ok(f.report.snapshots.slice(0, 3).every(item => debugSnapshotPriorities(f.report, selected).get(item.snapshotId)! < 5));
    const progress = f.scrolling.step.scrollTask!, iterations = progress.iterations;
    progress.iterations = [];
    assert.equal(debugSnapshotPriorities(f.report, selected).get(middle), 5, "observation reference is retained");
    progress.iterations = iterations; progress.observationIds = progress.observationIds.filter(id => id !== middle);
    assert.equal(debugSnapshotPriorities(f.report, selected).get(middle), 5, "iteration reference is retained independently");
  } finally { f.cleanup(); }
});

test("selected four-frame scroll exports and independently reloads below budget even when all report PNGs exceed 16 MiB", async () => {
  const f = await scrollExportFixture(4);
  try {
    const original = readFileSync(f.file);
    assert.ok(f.selectedBytes > 10 * MiB && f.selectedBytes < 12 * MiB);
    assert.ok(f.report.snapshots.reduce((sum, value) => sum + value.screenshot!.size, 0) > 16 * MiB);
    const ordinary = await loadTestReport(f.file), middle = f.report.snapshots.find(item => item.snapshotId === f.selected[1])!;
    assert.ok(ordinary.images.find(item => item.artifactId === middle.screenshot!.sha256)!.error, "default loading still leaves intermediate history low");
    const preferred = await loadTestReport(f.file, { preferredDebugStepIds: new Set([4]) });
    for (const snapshot of preferred.debug!.snapshots.filter(item => f.selected.includes(item.evidence.snapshotId))) {
      assert.ok(snapshot.snapshot && !snapshot.treeError);
      assert.ok(preferred.images.find(item => item.artifactId === snapshot.screenshotArtifactId)!.dataUrl);
    }
    const exported = await exportDebugReportEvidence(f.source(), { ...f.request(), stepIds: [4] }, f.parent, { appVersion: "fixture" });
    assert.equal(exported.error, null); assert.ok(exported.directory);
    const loaded = await loadTestReport(join(exported.directory, "report.json"));
    assert.equal(loaded.debug!.steps.length, 1); assert.equal(loaded.debug!.steps[0].verified, true);
    assert.equal(loaded.debug!.snapshots.length, 4); assert.equal(loaded.images.length, 4);
    assert.ok(loaded.debug!.snapshots.every(item => item.snapshot && !item.treeError));
    assert.ok(loaded.images.every(item => item.dataUrl && !item.error));
    assert.deepEqual(loaded.debug!.steps[0].step.scrollTask, f.scrolling.step.scrollTask);
    assert.deepEqual(readFileSync(f.file), original, "export never rewrites the source report");
  } finally { f.cleanup(); }
});

test("selected scroll that itself exceeds 16 MiB still refuses a complete export", async () => {
  const f = await scrollExportFixture(6);
  try {
    assert.ok(f.selectedBytes > 16 * MiB && f.selectedBytes < 32 * MiB);
    const original = readFileSync(f.file);
    const exported = await exportDebugReportEvidence(f.source(), { ...f.request(), stepIds: [4] }, f.parent, { appVersion: "fixture" });
    assert.equal(exported.directory, null); assert.match(exported.error!, /加载上限/);
    assert.deepEqual(readdirSync(f.parent), []); assert.deepEqual(readFileSync(f.file), original);
  } finally { f.cleanup(); }
});

test("visual-only scroll references survive selected export and missing or oversized visual evidence never becomes complete", async () => {
  for (const count of [4, 6] as const) {
    const f = await scrollExportFixture(count);
    try {
      const reference = f.report.snapshots[0], first = f.scrolling.step.scrollTask!.iterations[0];
      assert.ok(!f.selected.includes(reference.snapshotId));
      f.scrolling.step.input.visualConfirmation = { snapshotId: reference.snapshotId, description: "fixture visual reference" };
      first.resolvedInput!.targetNodeId = "0";
      first.resolvedInput!.visualConfirmation = { referenceSnapshotId: reference.snapshotId, currentSnapshotId: first.beforeId!,
        description: "fixture visual reference", region: { left: 0, top: 0, width, height }, sha256: "a".repeat(64), overlapNodeIds: [] };
      f.save();
      assert.equal(debugSnapshotPriorities(f.report, new Set([4])).get(reference.snapshotId), 5);
      const exportOne = () => exportDebugReportEvidence(f.source(), { ...f.request(), stepIds: [4] }, f.parent, { appVersion: "fixture" });
      const result = await exportOne();
      if (count === 6) { assert.equal(result.directory, null); assert.match(result.error!, /加载上限/); continue; }
      assert.equal(result.error, null);
      const path = join(result.directory!, "report.json"), loaded = await loadTestReport(path);
      assert.equal(loaded.debug!.snapshots.length, 5); assert.equal(loaded.images.length, 5);
      assert.ok(loaded.images.every(image => image.dataUrl && !image.error));
      const identity = { sessionId: f.report.session.id, serial: f.report.session.serial, packageName: f.report.session.packageName };
      assert.equal((await inspectRegressionEvidence(path, [4], identity, loadTestReport, 4)).complete, true);
      reference.screenshot = null; f.save();
      const missing = await exportOne(); assert.equal(missing.error, null);
      const incomplete = await inspectRegressionEvidence(join(missing.directory!, "report.json"), [4], identity, loadTestReport, 4);
      assert.equal(incomplete.complete, false); assert.equal(incomplete.missingScreenshots, 1);
    } finally { f.cleanup(); }
  }
});
