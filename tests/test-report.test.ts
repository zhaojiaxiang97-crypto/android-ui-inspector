import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { loadTestReport } from "../electron/desktop/test-report";
import { failedReportAttempt, firstReportStep, testReportStatusLabel } from "../shared/test-report";
import type { TestReportIndex } from "../shared/test-report";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1d0AAAAASUVORK5CYII=", "base64");
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inspector-report-import-"));
  const summary = join(directory, "summary");
  mkdirSync(summary); mkdirSync(join(directory, "artifacts"));
  writeFileSync(join(directory, "artifacts", "page.png"), png);
  const raw = { schemaVersion: "report-1", run: { id: "run", status: "passed", exitCode: 0, startedAt: "2026-10-08T14:00:00Z", finishedAt: "2026-10-08T14:00:01Z",
    runner: { name: "e2e", version: "0.18.0" }, serialGroups: [], errors: [], usage: { modelTokens: 0 }, results: [{
      id: "case", titlePath: ["安全导航"], targetId: "android", status: "passed", selected: true,
      source: { file: "tests/navigation.e2e.ts", line: 1, column: 1 }, attempts: [{ id: "attempt", index: 0, status: "passed", durationMs: 1000, cleanup: "complete", secondaryErrors: [],
        steps: [{ id: "step", api: "app.screenshot", label: "进入前", status: "passed", durationMs: 300, source: { file: "tests/navigation.e2e.ts", line: 2, column: 1 } }],
        artifacts: [{ id: "image", kind: "screenshot", mediaType: "image/png", producer: { kind: "step", stepId: "step" }, path: "page.png", size: png.length, sha256: digest(png) }],
      }],
    }] } };
  const index: TestReportIndex = { schemaVersion: "inspector-e2e-index-1", generatedAt: "2026-10-08T15:00:00Z", reportSha256: "",
    run: { id: "run", status: "passed", exitCode: 0, startedAt: raw.run.startedAt, finishedAt: raw.run.finishedAt, runner: raw.run.runner, modelTokens: 0, errors: [] },
    cases: [{ id: "case", title: "安全导航", targetId: "android", status: "passed", selected: true, source: raw.run.results[0].source, attempts: [{
      id: "attempt", index: 0, status: "passed", durationMs: 1000, cleanup: "complete", error: null, secondaryErrors: [], failure: null,
      steps: [{ id: "step", api: "app.screenshot", label: "进入前", status: "passed", durationMs: 300, source: raw.run.results[0].attempts[0].steps[0].source, error: null }],
      artifacts: [{ id: "image", kind: "screenshot", stepId: "step", failureEvidence: false, availability: "verified", href: "../artifacts/page.png", sha256: digest(png) }],
    }] }],
  };
  const file = join(summary, "index.json");
  const save = () => {
    const bytes = JSON.stringify(raw); writeFileSync(join(directory, "report.json"), bytes);
    index.reportSha256 = digest(bytes); writeFileSync(file, JSON.stringify(index));
  };
  save();
  return { directory, file, raw, index, save, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("local import verifies source, reads PNG as data URL, and never writes reports", async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.file);
    const result = await loadTestReport(f.file);
    assert.equal(result.index.run.status, "passed");
    assert.equal(result.images[0].dataUrl, `data:image/png;base64,${png.toString("base64")}`);
    assert.equal(result.images[0].error, null);
    assert.deepEqual(readFileSync(f.file), before);
  } finally { f.cleanup(); }
});

test("changed source or fabricated index status/step/error is rejected", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.directory, "report.json"), "{}");
    await assert.rejects(loadTestReport(f.file), /原始报告已变化/);
    f.save();
    f.index.run.status = "failed"; writeFileSync(f.file, JSON.stringify(f.index));
    await assert.rejects(loadTestReport(f.file), /不一致/);
    f.index.run.status = "passed";
    f.index.cases[0].attempts[0].steps[0].label = "伪造节点"; writeFileSync(f.file, JSON.stringify(f.index));
    await assert.rejects(loadTestReport(f.file), /不一致/);
  } finally { f.cleanup(); }
});

test("missing/changed image stays a visible error, not a fabricated screenshot", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.directory, "artifacts", "page.png"), "changed");
    let result = await loadTestReport(f.file);
    assert.equal(result.images[0].dataUrl, null); assert.match(result.images[0].error!, /变化/);
    rmSync(join(f.directory, "artifacts", "page.png"));
    result = await loadTestReport(f.file);
    assert.equal(result.images[0].dataUrl, null); assert.match(result.images[0].error!, /缺失/);
  } finally { f.cleanup(); }
});

test("image traversal, links outside evidence and remote paths are not loaded", async () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "inspector-report-outside-"));
  try {
    writeFileSync(join(outside, "secret.png"), png);
    rmSync(join(f.directory, "artifacts", "page.png"));
    symlinkSync(join(outside, "secret.png"), join(f.directory, "artifacts", "page.png"));
    let result = await loadTestReport(f.file);
    assert.equal(result.images[0].dataUrl, null); assert.match(result.images[0].error!, /越过/);
    for (const path of ["../secret.png", "/secret.png", "https://example.invalid/image.png"]) {
      f.raw.run.results[0].attempts[0].artifacts[0].path = path; f.save();
      result = await loadTestReport(f.file);
      assert.equal(result.images[0].dataUrl, null);
    }
  } finally { f.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test("invalid schema, unknown version, oversized file and linked source are rejected", async () => {
  const f = fixture();
  try {
    writeFileSync(f.file, JSON.stringify({ ...f.index, schemaVersion: "other" }));
    await assert.rejects(loadTestReport(f.file));
    writeFileSync(f.file, Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(loadTestReport(f.file), /过大/);
    f.save();
    const source = join(f.directory, "report.json");
    writeFileSync(join(f.directory, "linked.json"), readFileSync(source)); rmSync(source);
    symlinkSync(join(f.directory, "linked.json"), source);
    await assert.rejects(loadTestReport(f.file), /链接/);
  } finally { f.cleanup(); }
});

test("duplicate case IDs cannot alias another case in the report viewer", async () => {
  const f = fixture();
  try {
    const rawCase = structuredClone(f.raw.run.results[0]);
    const indexedCase = structuredClone(f.index.cases[0]);
    rawCase.attempts[0].id = "second-attempt";
    indexedCase.attempts[0].id = "second-attempt";
    f.raw.run.results.push(rawCase); f.index.cases.push(indexedCase); f.save();
    await assert.rejects(loadTestReport(f.file), /编号重复/);
  } finally { f.cleanup(); }
});

test("new recording states cannot relax legacy provenance or its index size limit", async () => {
  const f = fixture();
  try {
    const index = JSON.parse(JSON.stringify(f.index));
    index.run.status = "recorded";
    writeFileSync(f.file, JSON.stringify(index));
    await assert.rejects(loadTestReport(f.file));
    const renamed = join(f.directory, "summary", "report.json");
    writeFileSync(renamed, JSON.stringify(f.index) + " ".repeat(8 * 1024 * 1024));
    await assert.rejects(loadTestReport(renamed), /过大/);
  } finally { f.cleanup(); }
});

test("failure selection covers body failures and cleanup failures, never infers a live node", () => {
  const f = fixture();
  try {
    const attempt = f.index.cases[0].attempts[0];
    assert.equal(firstReportStep(attempt), "step"); assert.equal(failedReportAttempt(attempt), false);
    attempt.steps.push({ ...attempt.steps[0], id: "failure", status: "failed", error: { code: "ASSERTION_FAILED" } });
    assert.equal(firstReportStep(attempt), "failure"); assert.equal(failedReportAttempt(attempt), true);
    attempt.steps = []; attempt.error = { message: "准备失败" };
    assert.equal(firstReportStep(attempt), null); assert.equal(failedReportAttempt(attempt), true);
    attempt.error = null; attempt.secondaryErrors = [{ message: "清理失败" }];
    assert.equal(failedReportAttempt(attempt), true);
    assert.equal(testReportStatusLabel("anything"), "未知");
  } finally { f.cleanup(); }
});

test("report route only opens local file dialog; no device requests or HTML execution", () => {
  const main = readFileSync("electron/main.ts", "utf8");
  const route = main.slice(main.indexOf('ipcMain.handle("import-test-report"'), main.indexOf('ipcMain.handle("save-snapshot"'));
  assert.match(route, /event\.sender !== mainWindow\?\.webContents/);
  assert.match(route, /senderFrame !== event\.sender\.mainFrame/);
  assert.match(route, /dialog\.showOpenDialog/);
  assert.doesNotMatch(route, /inspectDevice|inspectPreferredDevice|debugSession|execFile|stopMcpSharing/);
  const panel = readFileSync("src/features/reports/TestReportPanel.tsx", "utf8");
  assert.doesNotMatch(panel, /inspectDevice|startDebugSession|showSnapshot|captureGroup|dangerouslySetInnerHTML|<iframe/);
  assert.match(panel, /showModal\(\)/);
  // Modal cancellation stays controlled; rendered checks cover close/reset/late IPC behavior.
  assert.match(panel, /onCancel=\{event => \{ event\.preventDefault\(\);/);
  assert.doesNotMatch(panel, /onClose=\{onClose\}/);
  assert.match(readFileSync("electron/preload.ts", "utf8"), /importTestReport: \(\) => ipcRenderer\.invoke\("import-test-report"\)/);
});
