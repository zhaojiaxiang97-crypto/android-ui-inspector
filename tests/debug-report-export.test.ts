import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportDebugReportEvidence } from "../electron/desktop/debug-report-export";
import { loadTestReport } from "../electron/desktop/test-report";
import { DebugSession } from "../electron/automation/debug-session";
import { makeNode } from "../benchmarks/fixtures";
import { LEGACY_DEBUG_REPORT_VERSION, type DebugSessionReport } from "../shared/debug-report";
import { debugReportExportRequestSchema } from "../shared/debug-report-export";
import { exportDigest, makeDebugReportExportFixture } from "./fixtures/debug-report-export";

const options = { appVersion: "0.1.2" };
const contents = (directory: string) => readdirSync(directory).filter(value => value !== ".DS_Store");
test("all selected evidence roundtrips after moving the folder, retains exact identities and redacts logs", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const original = readFileSync(f.file), originalLog = readFileSync(join(f.directory, f.report.steps[1].logs![0].file!.path));
    const result = await exportDebugReportEvidence(f.source(), f.request(), f.parent, options);
    assert.equal(result.error, null); assert.equal(result.canceled, false); assert.equal(result.stepCount, 3); assert.ok(result.directory);
    const manifest = JSON.parse(readFileSync(join(result.directory!, "manifest.json"), "utf8"));
    assert.equal(manifest.desktop.version, "0.1.2"); assert.equal(manifest.target.deviceSerial, f.report.session.serial);
    assert.equal(manifest.target.packageName, f.report.session.packageName); assert.equal(manifest.source.reportSha256, exportDigest(original));
    assert.deepEqual(manifest.selection.stepIds, [1, 2, 3]); assert.equal(manifest.report.sha256, exportDigest(readFileSync(join(result.directory!, "report.json"))));
    for (const file of manifest.files) {
      const data: Buffer = readFileSync(join(result.directory!, file.path)); assert.equal(data.length, file.size); assert.equal(exportDigest(data), file.sha256);
    }
    const moved = join(f.root, "moved-evidence"); renameSync(result.directory!, moved);
    const loaded = await loadTestReport(join(moved, "report.json"));
    assert.deepEqual(loaded.debug!.steps.map(entry => entry.step.id), [1, 2, 3]); assert.equal(loaded.images.filter(image => image.dataUrl).length, 3);
    assert.ok(loaded.debug!.snapshots.every(snapshot => snapshot.snapshot && !snapshot.treeError));
    assert.match(loaded.debug!.steps[1].logs![0].text!, /已隐藏/); assert.ok(!loaded.debug!.steps[1].logs![0].text!.includes("fixture-private"));
    const raw = JSON.parse(readFileSync(join(moved, "report.json"), "utf8")) as DebugSessionReport;
    assert.equal(raw.storage.bytes, manifest.report.size + manifest.files.reduce((sum: number, file: { size: number }) => sum + file.size, 0));
    assert.equal(JSON.stringify(manifest).includes(f.file), false); assert.deepEqual(readFileSync(f.file), original);
    assert.deepEqual(readFileSync(join(f.directory, f.report.steps[1].logs![0].file!.path)), originalLog);
  } finally { f.cleanup(); }
});

test("a current-step package excludes other steps, their snapshots and their log attachments", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const result = await exportDebugReportEvidence(f.source(), { ...f.request(), stepIds: [1] }, f.parent, options);
    assert.equal(result.error, null);
    const loaded = await loadTestReport(join(result.directory!, "report.json"));
    assert.deepEqual(loaded.debug!.steps.map(entry => entry.step.id), [1]); assert.equal(loaded.debug!.snapshots.length, 1);
    const manifest = JSON.parse(readFileSync(join(result.directory!, "manifest.json"), "utf8"));
    assert.equal(manifest.files.length, 2); assert.ok(!manifest.files.some((file: { path: string }) => file.path.endsWith(".txt")));
    assert.ok(!readFileSync(join(result.directory!, "report.json"), "utf8").includes("excluded-step-log"));
    assert.equal(loaded.debug!.session.totalSteps, 3); assert.equal(loaded.debug!.session.droppedSteps, 2);
  } finally { f.cleanup(); }
});

test("each attachment switch keeps the report importable and records explicit omission reasons", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    for (const excluded of ["includeTrees", "includeScreenshots", "includeLogs"] as const) {
      const result = await exportDebugReportEvidence(f.source(), { ...f.request(), [excluded]: false }, f.parent, options);
      assert.equal(result.error, null); const loaded = await loadTestReport(join(result.directory!, "report.json"));
      const manifest = JSON.parse(readFileSync(join(result.directory!, "manifest.json"), "utf8"));
      assert.ok(manifest.omissions.some((value: { reason: string }) => value.reason.includes("导出未包含")));
      if (excluded === "includeTrees") assert.ok(loaded.debug!.snapshots.every(value => value.snapshot === null && value.evidence.tree === null));
      if (excluded === "includeScreenshots") assert.equal(loaded.images.length, 0);
      if (excluded === "includeLogs") assert.equal(loaded.debug!.steps[1].logs![0].file, null);
    }
    const none = await exportDebugReportEvidence(f.source(), { ...f.request(), includeTrees: false, includeScreenshots: false, includeLogs: false }, f.parent, options);
    assert.equal(none.error, null); assert.deepEqual(contents(join(none.directory!, "artifacts")), []);
  } finally { f.cleanup(); }
});

test("missing original attachments are explicit while corrupt hashes, links and malformed identities refuse export", async () => {
  const missing = await makeDebugReportExportFixture();
  try {
    rmSync(join(missing.directory, missing.report.snapshots[0].tree!.path));
    const result = await exportDebugReportEvidence(missing.source(), { ...missing.request(), stepIds: [1] }, missing.parent, options);
    assert.equal(result.error, null); assert.match(result.warnings.join(" "), /附件缺失/);
    const loaded = await loadTestReport(join(result.directory!, "report.json"));
    assert.equal(loaded.debug!.snapshots[0].evidence.tree, null); assert.ok(loaded.images[0].dataUrl);
  } finally { missing.cleanup(); }
  for (const failure of ["hash", "link", "path", "identity", "image"] as const) {
    const f = await makeDebugReportExportFixture();
    try {
      const tree = f.report.snapshots[0].tree!, path = join(f.directory, tree.path);
      if (failure === "hash") writeFileSync(path, "changed");
      if (failure === "link") { renameSync(path, `${path}.real`); symlinkSync(`${path}.real`, path); }
      if (failure === "path") { tree.path = "../report.json"; f.save(); }
      if (failure === "identity") {
        const document = JSON.parse(readFileSync(path, "utf8")); document.snapshot.serial = "other-phone";
        f.report.snapshots[0].tree = f.artifact(Buffer.from(JSON.stringify(document)), "json"); f.save();
      }
      if (failure === "image") { f.report.snapshots[0].screenshot = f.artifact(Buffer.from("invalid PNG"), "png"); f.save(); }
      const result = await exportDebugReportEvidence(f.source(), f.request(), f.parent, options);
      assert.ok(result.error, failure); assert.equal(result.directory, null); assert.deepEqual(contents(f.parent), []);
    } finally { f.cleanup(); }
  }
});

test("only registered hashes and bounded selections are accepted; renderer paths never reach file reads", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    assert.equal(debugReportExportRequestSchema.safeParse({ ...f.request(), filePath: f.file }).success, false);
    assert.equal(debugReportExportRequestSchema.safeParse({ ...f.request(), stepIds: [1, 1] }).success, false);
    for (const request of [{ ...f.request(), reportSha256: "0".repeat(64) }, { ...f.request(), stepIds: [999] },
      { ...f.request(), filePath: f.file }]) {
      const result = await exportDebugReportEvidence(f.source(), request, f.parent, options);
      assert.ok(result.error); assert.deepEqual(contents(f.parent), []);
    }
    const source = f.source(), request = f.request(); writeFileSync(f.file, `${readFileSync(f.file, "utf8")}\n`);
    const changed = await exportDebugReportEvidence(source, request, f.parent, options);
    assert.match(changed.error!, /改变|摘要/); assert.deepEqual(contents(f.parent), []);
  } finally { f.cleanup(); }
});

test("cancellation before and during staging removes temporary packages and leaves source and neighbors unchanged", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const original = readFileSync(f.file), sibling = join(f.parent, "existing-result.txt"); writeFileSync(sibling, "existing result");
    const early = new AbortController(); early.abort();
    const first = await exportDebugReportEvidence(f.source(), f.request(), f.parent, { ...options, signal: early.signal });
    assert.equal(first.canceled, true); assert.equal(first.directory, null);
    const controller = new AbortController();
    // Abort at the first cancellation boundary after staging exists; filesystem watchers can arrive after a small export finishes.
    const signal = new Proxy(controller.signal, { get(target, property) {
      if (property === "throwIfAborted") return () => {
        if (contents(f.parent).some(name => name.startsWith(".debug-evidence-"))) controller.abort(new Error("fixture cancel"));
        target.throwIfAborted();
      };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await exportDebugReportEvidence(f.source(), f.request(), f.parent, { ...options, signal });
    assert.equal(controller.signal.aborted, true); assert.equal(result.canceled, true); assert.equal(result.directory, null); assert.equal(result.error, null);
    assert.deepEqual(contents(f.parent), ["existing-result.txt"]); assert.deepEqual(readFileSync(f.file), original);
    assert.equal(readFileSync(sibling, "utf8"), "existing result");
  } finally { f.cleanup(); }
});

test("cancellation during atomic completion removes the owned final folder", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    const original = readFileSync(f.file), controller = new AbortController();
    const signal = new Proxy(controller.signal, { get(target, property) {
      if (property === "throwIfAborted") return () => {
        const folders = contents(f.parent);
        if (!folders.some(name => name.startsWith(".debug-evidence-")) && folders.some(name => name.startsWith("Debug-evidence-"))) controller.abort();
        target.throwIfAborted();
      };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await exportDebugReportEvidence(f.source(), f.request(), f.parent, { ...options, signal });
    assert.equal(controller.signal.aborted, true); assert.equal(result.canceled, true); assert.equal(result.directory, null);
    assert.deepEqual(contents(f.parent), []); assert.deepEqual(readFileSync(f.file), original);
  } finally { f.cleanup(); }
});

test("the Windows completion branch never precreates a directory which Windows rename cannot replace", async () => {
  const f = await makeDebugReportExportFixture(), descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  let sawFinalWithStaging = false;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    const controller = new AbortController();
    const signal = new Proxy(controller.signal, { get(target, property) {
      if (property === "throwIfAborted") return () => {
        const folders = contents(f.parent);
        sawFinalWithStaging ||= folders.some(name => name.startsWith(".debug-evidence-")) && folders.some(name => name.startsWith("Debug-evidence-"));
        target.throwIfAborted();
      };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await exportDebugReportEvidence(f.source(), f.request(), f.parent, { ...options, signal });
    assert.equal(result.error, null); assert.equal(sawFinalWithStaging, false);
    assert.equal((await loadTestReport(join(result.directory!, "report.json"))).debug!.steps.length, 3);
    assert.deepEqual(contents(f.parent), [result.directory!.split(/[\\/]/).at(-1)!]);
  } finally { Object.defineProperty(process, "platform", descriptor); f.cleanup(); }
});

test("legacy version 1 exports without new report fields and two exports use distinct folders", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    f.report.schemaVersion = LEGACY_DEBUG_REPORT_VERSION; delete f.report.task; delete f.report.session.androidLogsEnabled;
    for (const entry of f.report.steps) delete entry.logs; f.save();
    const a = await exportDebugReportEvidence(f.source(), f.request(), f.parent, options);
    const b = await exportDebugReportEvidence(f.source(), f.request(), f.parent, options);
    assert.equal(a.error, null); assert.equal(b.error, null); assert.notEqual(a.directory, b.directory);
    const raw = JSON.parse(readFileSync(join(a.directory!, "report.json"), "utf8")) as DebugSessionReport;
    assert.equal(raw.schemaVersion, LEGACY_DEBUG_REPORT_VERSION); assert.equal(raw.task, undefined);
    assert.equal((await loadTestReport(join(a.directory!, "report.json"))).debug!.steps.length, 3);
    assert.match(a.warnings.join(" "), /没有保存步骤日志/);
  } finally { f.cleanup(); }
});

test("source report and attachments replaced during export are refused even when bytes and hashes remain identical", async () => {
  for (const replace of ["report", "tree"] as const) {
    const f = await makeDebugReportExportFixture();
    try {
      const source = f.source(), controller = new AbortController(); let replaced = false;
      const signal = new Proxy(controller.signal, { get(target, property) {
        if (property === "throwIfAborted") return () => {
          if (!replaced && contents(f.parent).some(name => name.startsWith(".debug-evidence-"))) {
            replaced = true;
            const file = replace === "report" ? f.file : join(f.directory, f.report.snapshots[0].tree!.path), bytes = readFileSync(file);
            renameSync(file, `${file}.previous`); writeFileSync(file, bytes);
          }
          target.throwIfAborted();
        };
        const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
      } });
      const result = await exportDebugReportEvidence(source, f.request(), f.parent, { ...options, signal });
      assert.equal(replaced, true); assert.match(result.error!, /导出期间改变/); assert.equal(result.directory, null);
      assert.deepEqual(contents(f.parent), []); assert.equal(exportDigest(readFileSync(f.file)), source.reportSha256);
    } finally { f.cleanup(); }
  }
});

test("an export above the report budget leaves no partial package and a smaller selection still roundtrips", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    f.report.limits.maxBytes = f.report.storage.bytes + 64; f.save();
    assert.ok((await loadTestReport(f.file)).debug);
    const result = await exportDebugReportEvidence(f.source(), f.request(), f.parent, options);
    assert.match(result.error!, /上限|32MiB/); assert.deepEqual(contents(f.parent), []);
    const smaller = await exportDebugReportEvidence(f.source(), { ...f.request(), stepIds: [1] }, f.parent, options);
    assert.equal(smaller.error, null); const loaded = await loadTestReport(join(smaller.directory!, "report.json"));
    assert.deepEqual(loaded.debug!.steps.map(entry => entry.step.id), [1]);
    const manifest = JSON.parse(readFileSync(join(smaller.directory!, "manifest.json"), "utf8"));
    assert.ok(manifest.report.size + manifest.files.reduce((sum: number, file: { size: number }) => sum + file.size, 0) <= f.report.limits.maxBytes);
  } finally { f.cleanup(); }
});

test("Android log include and exclude options retain schema-valid attribution without collecting a device", async () => {
  const f = await makeDebugReportExportFixture();
  try {
    f.report.session.androidLogsEnabled = true;
    const entry = f.report.steps[1], text = `${(Date.parse(entry.step.time) / 1000).toFixed(3)} 321 321 E Fixture: fixture-app-only failure\n`;
    entry.logs!.push({ ...entry.logs![0], source: "android", file: f.artifact(Buffer.from(text), "txt"), lineCount: 1,
      androidScope: { pid: 321, processStartTicks: "42", deviceStartedAt: Date.parse(entry.step.time), deviceFinishedAt: Date.parse(entry.finishedAt) } }); f.save();
    for (const includeLogs of [true, false]) {
      const result = await exportDebugReportEvidence(f.source(), { ...f.request(), stepIds: [2], includeLogs }, f.parent, options);
      assert.equal(result.error, null);
      const loaded = await loadTestReport(join(result.directory!, "report.json")), log = loaded.debug!.steps[0].logs!.find(value => value.source === "android")!;
      assert.equal(log.file !== null, includeLogs); assert.equal(log.attribution, includeLogs ? "confirmed" : "missing");
      assert.equal(log.androidScope !== null, includeLogs); if (!includeLogs) assert.match(log.reason!, /未包含错误日志/);
    }
  } finally { f.cleanup(); }
});

test("selected Checker exports keep fixed definitions and downgrade missing trees or excluded prerequisites", async () => {
  const f = await makeDebugReportExportFixture();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "inspector-task-export-"))), packageName = "com.example.export";
  const node = makeNode("0"); node.package = packageName; node.text = "ready";
  const frame = { width: 100, height: 100, rotation: 0 as const };
  const session = new DebugSession({ serial: "offline-export-fixture", packageName, directory, snapshotPath: join(directory, "current.json"), onEvent: () => {},
    observe: async () => ({ target: { packageName, component: `${packageName}/.Main`, activityName: ".Main", windowId: "fixture", activityRecordId: "fixture-activity" },
      snapshot: { serial: "offline-export-fixture", root: node, nodeCount: 1, xmlSize: 0, rawXml: null, screenshotDataUrl: null,
        error: null, warning: null, inspectionSource: "uiautomator", captureMode: "fast", hierarchyDumpMode: "full",
        captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } } }) });
  try {
    await session.request({ name: "capture_ui", input: { sessionId: session.state.id } });
    const definition = await session.request({ name: "define_debug_task", input: { sessionId: session.state.id, definition: { goal: "ready",
      checkpoints: [{ id: "ready", title: "准备页面", conditions: [{ id: "ready-page", selector: { text: "ready" }, state: "visible" }] }],
      finalConditions: [{ id: "ready-final", selector: { text: "ready" }, state: "visible" }] } } });
    const checkpoint = await session.request({ name: "check_debug_task", input: { sessionId: session.state.id, taskId: definition.taskId, checkpointId: "ready" } });
    assert.equal((checkpoint.taskResult as { status: string }).status, "passed");
    const final = await session.request({ name: "check_debug_task", input: { sessionId: session.state.id, taskId: definition.taskId } });
    assert.equal((final.taskResult as { status: string }).status, "passed"); session.stop(); await session.settled();
    const source = { filePath: session.state.reportPath!, reportSha256: exportDigest(readFileSync(session.state.reportPath!)) };
    const request = { ...f.request(), reportSha256: source.reportSha256 };
    const complete = await exportDebugReportEvidence(source, request, f.parent, options);
    assert.equal(complete.error, null); assert.equal((await loadTestReport(join(complete.directory!, "report.json"))).debug!.taskAssessment!.final!.status, "passed");
    for (const partial of [{ ...request, includeTrees: false }, { ...request, stepIds: [4] }]) {
      const result = await exportDebugReportEvidence(source, partial, f.parent, options); assert.equal(result.error, null);
      const raw = JSON.parse(readFileSync(join(result.directory!, "report.json"), "utf8")) as DebugSessionReport;
      assert.equal(raw.task!.checks.at(-1)!.status, "insufficient_evidence");
      assert.equal(raw.steps.at(-1)!.verified, false);
      assert.equal((await loadTestReport(join(result.directory!, "report.json"))).debug!.taskAssessment!.final!.status, "insufficient_evidence");
    }
    const sparse = await exportDebugReportEvidence(source, { ...request, stepIds: [1, 3, 4] }, f.parent, options);
    assert.match(sparse.error!, /任务定义步骤 #2|全部步骤/);
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); f.cleanup(); }
});
