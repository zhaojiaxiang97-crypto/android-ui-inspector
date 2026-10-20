import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { makeNode } from "../benchmarks/fixtures";
import { loadTestReport } from "../electron/desktop/test-report";
import { DEBUG_REPORT_VERSION, DEBUG_SNAPSHOT_VERSION, type DebugSessionReport, type DebugSnapshotDocument } from "../shared/debug-report";
import { testReportStatusLabel } from "../shared/test-report";

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inspector-debug-report-"));
  mkdirSync(join(directory, "artifacts"));
  const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#245588" } }).png().toBuffer();
  const sessionId = uuid(1), snapshotId = uuid(2), time = "2026-10-11T09:00:00.000Z";
  const tree: DebugSnapshotDocument = { schemaVersion: DEBUG_SNAPSHOT_VERSION, snapshotId, capturedAt: time,
    content: "tree-properties-without-layer-bitmaps", snapshot: { serial: "offline-fixture", root: makeNode("0"), nodeCount: 1,
      xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null, inspectionSource: "uiautomator", captureMode: "fast" } };
  const artifact = (bytes: Buffer, extension: string) => {
    const sha256 = digest(bytes), path = `artifacts/${sha256}.${extension}`;
    writeFileSync(join(directory, path), bytes);
    return { path, sha256, size: bytes.length };
  };
  const report: DebugSessionReport = { schemaVersion: DEBUG_REPORT_VERSION,
    session: { id: sessionId, serial: "offline-fixture", packageName: "com.example.benchmark", startedAt: time, updatedAt: time,
      active: false, stopReason: "已手动结束", totalSteps: 1, droppedSteps: 0 },
    limits: { maxSteps: 100, maxSnapshots: 200, maxImages: 100, maxBytes: 32 * 1024 * 1024, maxTreeBytes: 2 * 1024 * 1024, maxImageBytes: 10 * 1024 * 1024 },
    storage: { bytes: 0 },
    steps: [{ step: { id: 1, time, action: "capture_ui", input: { sessionId, mode: "fast", backend: "uiautomator" }, status: "done", message: "采集完成", afterId: snapshotId },
      finishedAt: time, durationMs: 100, verified: null,
      before: { snapshotId: null, freshness: "missing", reason: "尚无快照" }, after: { snapshotId, freshness: "current", reason: null } }],
    snapshots: [{ snapshotId, capturedAt: time, source: "uiautomator", tree: artifact(Buffer.from(JSON.stringify(tree)), "json"), screenshot: artifact(image, "png"), warnings: [] }],
  };
  const file = join(directory, "report.json");
  const save = () => writeFileSync(file, JSON.stringify(report));
  const replaceTree = () => { report.snapshots[0].tree = artifact(Buffer.from(JSON.stringify(tree)), "json"); save(); };
  save();
  return { directory, file, report, tree, image, artifact, save, replaceTree, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("raw debug report uses its own provenance, exact snapshot references and verified local PNG without writes", async () => {
  const f = await fixture();
  try {
    const original = readFileSync(f.file), treeBefore = readFileSync(join(f.directory, f.report.snapshots[0].tree!.path));
    const result = await loadTestReport(f.file);
    assert.equal(result.index.schemaVersion, "inspector-debug-index-1");
    assert.equal(result.index.reportSha256, digest(original));
    assert.equal(result.index.run.status, "recorded"); assert.equal(result.index.run.exitCode, null);
    assert.equal(result.index.run.runner.name, "Android UI Inspector");
    assert.equal(result.index.cases[0].attempts[0].steps[0].status, "completed");
    assert.equal(result.debug!.snapshots[0].snapshot!.root!.id, "0");
    assert.equal(result.debug!.steps[0].after.snapshotId, f.tree.snapshotId);
    assert.equal(result.images[0].artifactId, digest(f.image));
    assert.equal(result.images[0].dataUrl, `data:image/png;base64,${f.image.toString("base64")}`);
    assert.equal(result.index.cases[0].attempts[0].artifacts[0].stepId, null);
    assert.deepEqual(readFileSync(f.file), original);
    assert.deepEqual(readFileSync(join(f.directory, f.report.snapshots[0].tree!.path)), treeBefore);
  } finally { f.cleanup(); }
});

test("operation completion and an explicit page assertion stay distinct; shared PNG is deduplicated", async () => {
  const f = await fixture();
  try {
    const original = f.report.steps[0], reference = original.after;
    f.report.steps.push({ ...structuredClone(original), step: { ...original.step, id: 2, action: "tap_node", input: { sessionId: f.report.session.id, snapshotId: f.tree.snapshotId, nodeId: "0" },
      beforeId: f.tree.snapshotId, dispatchState: "sent", message: "已派发，尚未验证" }, verified: false, before: reference,
      after: { ...reference, freshness: "previous", reason: "没有新观察" } });
    f.report.steps.push({ ...structuredClone(original), step: { ...original.step, id: 3, action: "wait_for_ui", input: { sessionId: f.report.session.id, selector: { text: "标题" }, state: "visible", timeoutMs: 1000 },
      beforeId: f.tree.snapshotId, message: "页面断言符合" }, verified: true, before: reference });
    f.report.session.totalSteps = 3; f.report.session.active = true; f.save();
    const result = await loadTestReport(f.file);
    assert.equal(result.index.run.status, "recording");
    assert.deepEqual(result.index.cases[0].attempts[0].steps.map(step => step.status), ["completed", "completed", "passed"]);
    assert.match(result.index.cases[0].attempts[0].steps[2].label, /仅页面断言/);
    assert.equal(result.images.length, 1);
    assert.equal(result.debug!.steps[1].after.freshness, "previous");
    assert.equal(testReportStatusLabel("completed"), "操作完成");
  } finally { f.cleanup(); }
});

test("unknown fields, duplicate IDs, unknown references and cross-session inputs reject the manifest", async () => {
  const f = await fixture();
  try {
    const initial = structuredClone(f.report);
    const mutations: Array<(report: DebugSessionReport) => void> = [
      report => { (report as unknown as Record<string, unknown>).claimedPass = true; },
      report => { report.snapshots.push(structuredClone(report.snapshots[0])); },
      report => { report.steps.push(structuredClone(report.steps[0])); report.session.totalSteps = 2; },
      report => { report.steps[0].after.snapshotId = uuid(99); report.steps[0].step.afterId = uuid(99); },
      report => { report.steps[0].step.input.sessionId = uuid(99); },
      report => { report.steps[0].step.afterId = uuid(99); },
      report => { report.steps[0].before.snapshotId = f.tree.snapshotId; },
      report => { report.steps[0].verified = true; },
      report => { report.limits.maxSteps = 101; },
      report => { report.session.droppedSteps = 1; },
    ];
    for (const mutation of mutations) {
      Object.assign(f.report, structuredClone(initial)); mutation(f.report); f.save();
      await assert.rejects(loadTestReport(f.file));
    }
  } finally { f.cleanup(); }
});

test("debug normalized indexes and redirected raw report links cannot impersonate original provenance", async () => {
  const f = await fixture(), other = await fixture();
  try {
    const loaded = await loadTestReport(f.file);
    writeFileSync(join(f.directory, "index.json"), JSON.stringify(loaded.index));
    await assert.rejects(loadTestReport(join(f.directory, "index.json")));
    rmSync(f.file); symlinkSync(other.file, f.file);
    await assert.rejects(loadTestReport(f.file), /链接|原始/);
  } finally { f.cleanup(); other.cleanup(); }
});

test("missing, changed or malformed artifacts remain visible evidence errors with no whole-run success", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.directory, f.report.snapshots[0].tree!.path), "changed");
    rmSync(join(f.directory, f.report.snapshots[0].screenshot!.path));
    const result = await loadTestReport(f.file);
    assert.equal(result.debug!.snapshots[0].snapshot, null);
    assert.match(result.debug!.snapshots[0].treeError!, /变化|大小/);
    assert.equal(result.images[0].dataUrl, null); assert.match(result.images[0].error!, /缺失/);
    assert.equal(result.index.run.status, "recorded"); assert.equal(result.index.run.errors.length, 2);
  } finally { f.cleanup(); }
});

test("valid PNG header and matching hash do not bypass real pixel decoding", async () => {
  const f = await fixture();
  try {
    f.report.snapshots[0].screenshot = f.artifact(f.image.subarray(0, 36), "png"); f.save();
    const result = await loadTestReport(f.file);
    assert.equal(result.images[0].dataUrl, null); assert.ok(result.images[0].error);
  } finally { f.cleanup(); }
});

test("a small compressed PNG cannot expand beyond the fixed decoded pixel limit", async () => {
  const f = await fixture();
  try {
    const oversized = await sharp({ create: { width: 4097, height: 4097, channels: 3, background: "#ffffff" } }).png().toBuffer();
    assert.ok(oversized.length < 10 * 1024 * 1024);
    f.report.snapshots[0].screenshot = f.artifact(oversized, "png"); f.save();
    const result = await loadTestReport(f.file);
    assert.equal(result.images[0].dataUrl, null); assert.match(result.images[0].error!, /pixel|像素|尺寸/i);
  } finally { f.cleanup(); }
});

test("safe artifact syntax and regular local files reject traversal and links for trees and images", async () => {
  const f = await fixture(), outside = await fixture();
  try {
    const original = structuredClone(f.report.snapshots[0]);
    for (const unsafe of ["../report.json", "/tmp/private.json", "https://example.invalid/tree.json", "artifacts/../report.json", "artifacts\\tree.json"]) {
      f.report.snapshots[0].tree!.path = unsafe; f.save(); await assert.rejects(loadTestReport(f.file));
    }
    f.report.snapshots[0] = original; f.save();
    const treePath = join(f.directory, original.tree!.path), imagePath = join(f.directory, original.screenshot!.path);
    rmSync(treePath); symlinkSync(join(outside.directory, outside.report.snapshots[0].tree!.path), treePath);
    rmSync(imagePath); symlinkSync(join(outside.directory, outside.report.snapshots[0].screenshot!.path), imagePath);
    const result = await loadTestReport(f.file);
    assert.match(result.debug!.snapshots[0].treeError!, /链接|越过/);
    assert.match(result.images[0].error!, /链接|越过/); assert.equal(result.images[0].dataUrl, null);
  } finally { f.cleanup(); outside.cleanup(); }
});

test("tree documents cannot substitute snapshot/session identity or an unrelated app", async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.tree);
    const mutations: Array<(tree: DebugSnapshotDocument) => void> = [
      tree => { tree.snapshot.serial = "another-phone"; },
      tree => { tree.snapshotId = uuid(99); },
      tree => { tree.capturedAt = "2026-10-11T09:00:01.000Z"; },
      tree => { tree.snapshot.root!.package = "com.other.app"; },
      tree => { tree.snapshot.inspectionSource = "debug-view"; },
    ];
    for (const mutation of mutations) {
      Object.assign(f.tree, structuredClone(original)); mutation(f.tree); f.replaceTree();
      await assert.rejects(loadTestReport(f.file), /身份|目标App|来源/);
    }
  } finally { f.cleanup(); }
});

test("authorized child cannot disguise a foreign root; an authorized root can retain system children", async () => {
  const f = await fixture();
  try {
    const root = f.tree.snapshot.root!;
    root.children = [makeNode("0/0")]; f.tree.snapshot.nodeCount = 2;
    root.package = "com.foreign.app"; f.replaceTree();
    await assert.rejects(loadTestReport(f.file), /目标App/);
    root.package = f.report.session.packageName; root.children[0].package = "com.android.systemui"; f.replaceTree();
    const result = await loadTestReport(f.file);
    assert.equal(result.debug!.snapshots[0].treeError, null);
    assert.equal(result.debug!.snapshots[0].snapshot!.root!.children[0].package, "com.android.systemui");
  } finally { f.cleanup(); }
});

test("embedded screenshots, layer bitmaps and duplicate tree nodes cannot bypass separate file bounds", async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.tree);
    const mutations: Array<(tree: DebugSnapshotDocument) => void> = [
      tree => { tree.snapshot.screenshotDataUrl = `data:image/png;base64,${f.image.toString("base64")}`; },
      tree => { tree.snapshot.root!.layerImageDataUrl = "data:image/png;base64,secret"; },
      tree => { (tree.snapshot as unknown as Record<string, unknown>).alternateScreen = "data:image/png;base64,secret"; },
      tree => { tree.snapshot.root!.children.push(makeNode("0")); tree.snapshot.nodeCount = 2; },
    ];
    for (const mutation of mutations) {
      Object.assign(f.tree, structuredClone(original)); mutation(f.tree); f.replaceTree();
      const result = await loadTestReport(f.file);
      assert.equal(result.debug!.snapshots[0].snapshot, null); assert.ok(result.debug!.snapshots[0].treeError);
    }
  } finally { f.cleanup(); }
});

test("literal data URLs in real text and attributes stay ordinary properties without loading pictures", async () => {
  const f = await fixture();
  try {
    f.tree.snapshot.root!.text = "data:image/png;base64,ordinary-control-text";
    f.tree.snapshot.root!.contentDesc = "data:application/json,an-example";
    f.tree.snapshot.root!.attributes = { value: "data:image/png;base64,an-example-property" }; f.replaceTree();
    const result = await loadTestReport(f.file);
    assert.equal(result.debug!.snapshots[0].treeError, null);
    assert.equal(result.debug!.snapshots[0].snapshot!.root!.text, f.tree.snapshot.root!.text);
    assert.equal(result.debug!.snapshots[0].snapshot!.root!.attributes!.value, f.tree.snapshot.root!.attributes!.value);
    assert.equal(result.images.length, 1);
  } finally { f.cleanup(); }
});

test("freshness cannot promote old or future evidence into an action result and input kind cannot be substituted", async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.report);
    const mutations: Array<(report: DebugSessionReport) => void> = [
      report => { report.steps[0].step.time = "2026-10-11T09:00:01.000Z"; report.steps[0].finishedAt = "2026-10-11T09:00:02.000Z"; },
      report => { report.steps[0].step.time = "2026-10-11T08:59:58.000Z"; report.steps[0].finishedAt = "2026-10-11T08:59:59.000Z"; },
      report => { report.steps[0].after.freshness = "previous"; report.steps[0].after.reason = null; },
      report => { report.steps[0].step.status = "failed"; report.steps[0].step.action = "wait_for_ui";
        report.steps[0].step.input = { sessionId: report.session.id, selector: { text: "标题" } }; report.steps[0].verified = true; },
      report => { report.steps[0].step.action = "tap_node"; report.steps[0].step.input = { sessionId: report.session.id, snapshotId: f.tree.snapshotId, nodeId: "0" };
        report.steps[0].step.resolvedInput = { action: { kind: "back" }, frame: { width: 2, height: 2, rotation: 0 } }; },
    ];
    for (const mutation of mutations) {
      Object.assign(f.report, structuredClone(original)); mutation(f.report); f.save();
      await assert.rejects(loadTestReport(f.file));
    }
  } finally { f.cleanup(); }
});

test("declared smaller file bounds are honored and oversized manifests are bounded before parsing", async () => {
  const f = await fixture();
  try {
    f.report.limits.maxTreeBytes = f.report.snapshots[0].tree!.size - 1;
    f.report.limits.maxImageBytes = f.image.length - 1; f.save();
    let result = await loadTestReport(f.file);
    assert.match(result.debug!.snapshots[0].treeError!, /上限/); assert.match(result.images[0].error!, /上限/);
    writeFileSync(f.file, Buffer.alloc(32 * 1024 * 1024 + 1));
    await assert.rejects(loadTestReport(f.file), /过大/);
  } finally { f.cleanup(); }
});

test("aggregate tree reads stop at 16MiB even when each separate tree fits its file limit", async () => {
  const f = await fixture();
  try {
    f.report.snapshots = [];
    for (let i = 0; i < 9; i++) {
      const tree = structuredClone(f.tree); tree.snapshotId = uuid(i + 2);
      tree.snapshot.root!.attributes = { payload: "x".repeat(1900 * 1024) };
      f.report.snapshots.push({ snapshotId: tree.snapshotId, capturedAt: tree.capturedAt, source: "uiautomator",
        tree: f.artifact(Buffer.from(JSON.stringify(tree)), "json"), screenshot: null, warnings: ["此快照未保存图片"] });
    }
    f.save();
    const result = await loadTestReport(f.file);
    assert.equal(result.debug!.snapshots.filter(item => item.snapshot).length, 8);
    assert.ok(result.debug!.snapshots.some(item => /上限/.test(item.treeError ?? "")));
    assert.deepEqual(result.debug!.snapshots.map(item => item.evidence.snapshotId), f.report.snapshots.map(item => item.snapshotId));
  } finally { f.cleanup(); }
});

test("structured operation and recording errors survive normalization and do not invent cleanup success", async () => {
  const f = await fixture();
  try {
    f.report.steps[0].step.status = "failed";
    f.report.steps[0].step.error = { category: "capture", code: "helper-http", phase: "capture", message: "HTTP 401" };
    f.report.steps[0].step.recordingErrors = [{ category: "recording", code: "file-write", phase: "recording", message: "留证空间不足" }];
    f.save();
    const result = await loadTestReport(f.file), attempt = result.index.cases[0].attempts[0];
    assert.equal(attempt.steps[0].error!.code, "helper-http");
    assert.equal(attempt.secondaryErrors[0]!.code, "file-write"); assert.equal(attempt.cleanup, "unknown");
    assert.equal(attempt.steps[0].status, "failed"); assert.equal(result.index.run.status, "recorded");
  } finally { f.cleanup(); }
});
