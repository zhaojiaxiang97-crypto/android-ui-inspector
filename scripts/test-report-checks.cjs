// Isolated Electron fixture: actual report IPC and React UI, never a phone operation.
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage } = require("electron");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const evidence = require("./lib/packaged-check-evidence.cjs");

const project = resolve(__dirname, "..");
const base = join(project, ".benchmarks", "test-report-ui"); mkdirSync(base, { recursive: true });
const output = mkdtempSync(join(base, "run-"));
const resources = process.argv.find(value => value.startsWith("--app-resources="))?.slice("--app-resources=".length);
const candidate = process.argv.find(value => value.startsWith("--candidate="))?.slice(12);
if (resources) evidence.parseArgs([`--app-resources=${resources}`, `--candidate=${candidate ?? ""}`]);
const appPath = resources ? join(resolve(resources), "app.asar") : project;
app.setAppPath(appPath); app.setPath("userData", join(output, "profile"));
process.argv.push("--visual-fixture", "--visual-fixture-state=empty");
const reportFile = process.argv.find(value => value.startsWith("--report="))?.slice("--report=".length);
const debugReportFile = process.argv.find(value => value.startsWith("--debug-report="))?.slice("--debug-report=".length);
const taskReportFile = process.argv.find(value => value.startsWith("--task-report="))?.slice("--task-report=".length);
const missingTaskReportFile = process.argv.find(value => value.startsWith("--missing-task-report="))?.slice("--missing-task-report=".length);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fixture = join(output, "fixture"); mkdirSync(join(fixture, "summary"), { recursive: true }); mkdirSync(join(fixture, "artifacts"));
const bitmap = Buffer.alloc(4 * 100 * 160, 160);
for (let i = 3; i < bitmap.length; i += 4) bitmap[i] = 255;
const png = nativeImage.createFromBitmap(bitmap, { width: 100, height: 160 }).toPNG();
writeFileSync(join(fixture, "artifacts", "page.png"), png);
const err = { code: "ASSERTION_FAILED", message: "合成失败：标题未变化", details: { expected: "目标页", observed: "原页面" } };
const steps = [{ id: "s1", api: "locator.tap", label: "安全入口", status: "passed", durationMs: 200, source: { file: "synthetic.e2e.ts", line: 8, column: 1 } },
  { id: "s2", api: "expect.toHaveText", label: "页面标题", status: "failed", durationMs: 500, source: { file: "synthetic.e2e.ts", line: 9, column: 1 }, error: err }];
const raw = { schemaVersion: "report-1", run: { id: "synthetic-run", status: "failed", exitCode: 1, startedAt: "2026-10-08T15:00:00Z", finishedAt: "2026-10-08T15:00:01Z", runner: { name: "e2e", version: "0.18.0" },
  serialGroups: [], errors: [], results: [{ id: "case", titlePath: ["合成失败（只测本地界面）"], targetId: "fixture", status: "failed", selected: true, source: steps[0].source,
    attempts: [{ id: "attempt", index: 0, status: "failed", durationMs: 700, cleanup: "complete", steps, error: err, secondaryErrors: [], failure: { screenshot: "image" },
      artifacts: [{ id: "image", kind: "screenshot", mediaType: "image/png", path: "page.png", sha256: hash(png), size: png.length, producer: { kind: "attempt" } }] }] }] } };
const source = JSON.stringify(raw); writeFileSync(join(fixture, "report.json"), source);
const index = { schemaVersion: "inspector-e2e-index-1", generatedAt: raw.run.finishedAt, reportSha256: hash(source), run: { id: raw.run.id, status: "failed", exitCode: 1, startedAt: raw.run.startedAt, finishedAt: raw.run.finishedAt, runner: raw.run.runner, modelTokens: null, errors: [] },
  cases: [{ id: "case", title: raw.run.results[0].titlePath[0], targetId: "fixture", status: "failed", selected: true, source: steps[0].source, attempts: [{ id: "attempt", index: 0, status: "failed", durationMs: 700, cleanup: "complete", error: err, secondaryErrors: [], failure: { screenshot: "image" },
    steps: steps.map(step => ({ ...step, error: step.error ?? null })), artifacts: [{ id: "image", kind: "screenshot", stepId: null, failureEvidence: true, availability: "verified", href: "../artifacts/page.png", sha256: hash(png) }] }] }] };
const synthetic = join(fixture, "summary", "index.json"); writeFileSync(synthetic, JSON.stringify(index));
const bad = join(output, "invalid.json"); writeFileSync(bad, '{"schemaVersion":"unknown"}');
let chosen = reportFile ? resolve(reportFile) : synthetic;
let cancel = false;
let dialogCalls = 0;
let holdNextDialog = false, failNextDialog = false, releaseDialog;
dialog.showOpenDialog = async () => {
  dialogCalls++;
  if (failNextDialog) { failNextDialog = false; throw new Error("Synthetic native chooser failure"); }
  const reply = { canceled: cancel, filePaths: cancel ? [] : [chosen] };
  if (holdNextDialog) { holdNextDialog = false; return new Promise(resolve => { releaseDialog = () => { releaseDialog = undefined; resolve(reply); }; }); }
  return reply;
};
require(join(appPath, "dist-electron", "main.cjs"));
const report = { passed: false, appPath, checks: [], output, phoneOperations: 0, mockedFileChooser: true, viewports: [],
  fixtureOnly: true, installedAcceptance: false, coverage: "candidate main/preload/renderer with synthetic empty-device/file-chooser fixture" };
const timer = setTimeout(() => { console.error("Report UI timed out"); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const window = BrowserWindow.getAllWindows()[0];
  const evaluate = code => window.webContents.executeJavaScript(code);
  const pause = () => new Promise(resolve => setTimeout(resolve, 40));
  async function until(code) { for (let i = 0; i < 250; i++) { if (await evaluate(code)) return; await pause(); } throw new Error(`UI did not settle: ${code}`); }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const painted = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  async function importChosen() {
    const before = dialogCalls; await click(".test-report-header button");
    await until("!document.querySelector('.test-report-header button').disabled");
    assert.equal(dialogCalls, before + 1);
  }
  try {
    if (resources) {
      report.resourceIdentity = evidence.resourceIdentity(resolve(resources));
      report.candidate = report.resourceIdentity.candidate ?? null;
      assert.equal(report.candidate, candidate, "Candidate identifier mismatch");
    }
    await until("Boolean(window.electronApi?.importTestReport) && Boolean(document.querySelector('.home-view'))");
    Menu.getApplicationMenu().getMenuItemById("test-report").click();
    await until("document.querySelector('.test-report-dialog').open");
    assert.equal(await evaluate("document.querySelector('.test-report-empty').textContent.includes('无需连接手机')"), true);
    report.checks.push("no-device empty report entry");
    await importChosen(); await until("Boolean(document.querySelector('.test-report-summary'))");
    if (reportFile) {
      assert.equal(await evaluate("document.querySelectorAll('.test-report-steps li').length"), 14);
      await evaluate("[...document.querySelectorAll('.test-report-steps li button')].find(b=>b.textContent.includes('playback-settings')).click()");
      await until("Boolean(document.querySelector('.test-report-images img')?.complete && document.querySelector('.test-report-images img')?.naturalWidth)");
      assert.equal(await evaluate("document.querySelector('.test-report-images img').src.startsWith('data:image/png;base64,')"), true);
      await painted();
      writeFileSync(join(output, "real-report.png"), (await window.webContents.capturePage()).toPNG());
      report.checks.push("existing Kuaishou report, 14 steps, verified local screenshot through actual IPC");
    }
    chosen = synthetic; await importChosen();
    await until("document.querySelector('.test-report-detail h3')?.textContent === '页面标题'");
    assert.equal(await evaluate("document.querySelector('.test-report-steps [aria-current=step]')?.dataset.status"), "failed");
    assert.equal(await evaluate("document.querySelector('.test-report-detail').textContent.includes('synthetic.e2e.ts:9') && document.querySelector('.test-report-detail').textContent.includes('标题未变化')"), true);
    await until("Boolean(document.querySelector('.test-report-images img')?.naturalWidth)");
    report.checks.push("failed step auto-selection, source line, error, attempt-level screenshot");
    for (const [width, height] of [[1440, 900], [960, 700]]) {
      window.setContentSize(width, height);
      await until(`innerWidth === ${width}`);
      assert.equal(await evaluate("document.querySelector('.test-report-dialog').scrollWidth <= document.querySelector('.test-report-dialog').clientWidth + 1"), true);
      await painted();
      writeFileSync(join(output, `failure-${width}.png`), (await window.webContents.capturePage()).toPNG());
      report.viewports.push({ width, height, noHorizontalOverflow: true });
    }
    await evaluate("document.querySelector('.test-report-steps li button').click()");
    assert.equal(await evaluate("document.querySelector('.test-report-no-image')?.textContent.includes('此步骤没有关联截图')"), true);
    report.checks.push("step switch, no fabricated screenshot");
    cancel = true; await importChosen(); cancel = false;
    assert.equal(await evaluate("document.querySelector('.test-report-summary').textContent.includes('synthetic-run')"), true);
    chosen = bad; await importChosen(); await until("Boolean(document.querySelector('.test-report-dialog > .test-report-error[role=alert]'))");
    assert.equal(await evaluate("document.querySelector('.test-report-summary').textContent.includes('synthetic-run')"), true);
    report.checks.push("cancel/invalid index keep prior report");
    chosen = synthetic; holdNextDialog = true;
    const beforePending = dialogCalls; await click(".test-report-header button");
    await until("document.querySelector('.test-report-header button').disabled");
    const duplicate = await evaluate("window.electronApi.importTestReport()");
    assert.match(duplicate.error, /已有报告导入/); assert.equal(dialogCalls, beforePending + 1);
    await click(".test-report-header button[aria-label='关闭测试报告']");
    await until("!document.querySelector('.test-report-dialog').open");
    Menu.getApplicationMenu().getMenuItemById("test-report").click();
    await until("document.querySelector('.test-report-dialog').open && !document.querySelector('.test-report-header button').disabled");
    await click(".test-report-header button");
    await until("document.querySelector('.test-report-dialog > [role=alert]')?.textContent.includes('已有报告导入')");
    assert.equal(dialogCalls, beforePending + 1);
    assert(releaseDialog, "Deferred native chooser missing"); releaseDialog();
    await pause(); await painted();
    assert.equal(await evaluate("document.querySelector('.test-report-dialog > [role=alert]')?.textContent.includes('已有报告导入')"), true);
    assert.equal(await evaluate("document.querySelector('.test-report-summary').textContent.includes('synthetic-run')"), true);
    await importChosen(); assert.equal(await evaluate("Boolean(document.querySelector('.test-report-dialog > [role=alert]'))"), false);
    report.checks.push("actual IPC rejects concurrent chooser; close/reopen resets wait and isolates abandoned reply");
    failNextDialog = true; await importChosen();
    await until("document.querySelector('.test-report-dialog > [role=alert]')?.textContent.includes('Synthetic native chooser failure')");
    assert.equal(await evaluate("document.querySelector('.test-report-summary').textContent.includes('synthetic-run')"), true);
    await importChosen(); assert.equal(await evaluate("Boolean(document.querySelector('.test-report-dialog > [role=alert]'))"), false);
    report.checks.push("native chooser rejection releases IPC guard and retains prior report");
    await click(".test-report-header button[aria-label='关闭测试报告']");
    await until("!document.querySelector('.test-report-dialog').open");
    assert.equal(await evaluate("Boolean(document.querySelector('.inspection-active'))"), false);
    if (process.platform === "darwin") {
      const item = Menu.getApplicationMenu().getMenuItemById("test-report"); assert(item.enabled); item.click();
      await until("document.querySelector('.test-report-dialog').open");
      await click(".test-report-header button[aria-label='关闭测试报告']");
    }
    report.checks.push("close restores home; native menu entry independent of device");
    Menu.getApplicationMenu().getMenuItemById("test-report").click();
    await until("document.querySelector('.test-report-dialog').open");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await until("document.querySelector('.test-report-dialog').contains(document.activeElement)");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await until("!document.querySelector('.test-report-dialog').open");
    report.checks.push("keyboard focus stays in dialog; Escape closes it");
    if (debugReportFile) {
      Menu.getApplicationMenu().getMenuItemById("test-report").click();
      await until("document.querySelector('.test-report-dialog').open");
      chosen = resolve(debugReportFile); await importChosen();
      await until("Boolean(document.querySelector('.debug-report-retention'))");
      assert.equal(await evaluate("document.querySelector('.test-report-summary [data-status]').dataset.status === 'passed'"), false);
      await evaluate("[...document.querySelectorAll('.test-report-steps li button')].find(b => b.textContent.includes('tap_node')).click()");
      await until("document.querySelectorAll('.debug-report-image-frame img').length === 2 && [...document.querySelectorAll('.debug-report-image-frame img')].every(img => img.naturalWidth === 160)");
      await until("Boolean(document.querySelector('.debug-report-input-marker[data-confirmed=true][data-kind=tap]'))");
      assert.equal(await evaluate("document.querySelector('.debug-report-step-detail').textContent.includes('尚未验收')"), true);
      assert.equal(await evaluate("document.querySelector('.debug-report-step-detail').textContent.includes('com.example.offline:id/button')"), true);
      for (const [width, height] of [[1440, 900], [960, 700]]) {
        window.setContentSize(width, height); await until(`innerWidth === ${width}`); await painted();
        assert.equal(await evaluate("document.querySelector('.test-report-dialog').scrollWidth <= document.querySelector('.test-report-dialog').clientWidth + 1"), true);
        writeFileSync(join(output, `debug-step-${width}.png`), (await window.webContents.capturePage()).toPNG());
        await evaluate("(() => { const detail = document.querySelector('.test-report-detail'), observations = document.querySelector('.debug-report-observations'); detail.scrollTop += observations.getBoundingClientRect().top - detail.getBoundingClientRect().top - 12; })()");
        await painted();
        writeFileSync(join(output, `debug-observations-${width}.png`), (await window.webContents.capturePage()).toPNG());
        if (width === 960) {
          await evaluate("document.querySelector('.debug-report-observation[data-observation=after]').scrollIntoView({ block: 'start' })");
          await painted(); writeFileSync(join(output, "debug-after-960.png"), (await window.webContents.capturePage()).toPNG());
        }
        await evaluate("document.querySelector('.test-report-detail').scrollTop = 0");
      }
      const filter = value => evaluate(`(() => { const input = document.querySelector('input[aria-label="筛选步骤"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await filter("wait_for_ui"); await until("document.querySelectorAll('.test-report-steps li').length === 2");
      await filter("#3"); await until("document.querySelectorAll('.test-report-steps li').length === 1");
      await click(".test-report-steps li button");
      assert.equal(await evaluate("document.querySelector('.test-report-steps [aria-current=step]').dataset.status"), "passed");
      assert.equal(await evaluate("document.querySelector('.test-report-summary [data-status]').dataset.status === 'passed'"), false);
      await filter(""); await until("document.querySelectorAll('.test-report-steps li').length === 4");
      await evaluate("[...document.querySelectorAll('.test-report-steps li button')].find(b => b.dataset.status === 'failed').click()");
      assert.equal(await evaluate("Boolean(document.querySelector('.debug-report-observation[data-observation=after][data-freshness=previous]'))"), true);
      assert.equal(await evaluate("Boolean(document.querySelector('.debug-report-input-marker'))"), false);
      report.checks.push("debug provenance, before/after images, confirmed action marker, historical target properties, step filter, prior observation and no task-pass claim");

      await click(".test-report-header button[aria-label='关闭测试报告']");
      await until("!document.querySelector('.test-report-dialog').open");
      ipcMain.removeHandler("probe-adb");
      ipcMain.handle("probe-adb", () => ({ adbPath: "visual-fixture", adbVersion: "offline fixture", error: null,
        devices: [{ serial: "fixture-device", state: "device", model: "Offline Fixture", androidVersion: "15", product: "offline", transportId: null }] }));
      report.mockedDeviceProbe = true;
      await click(".home-primary-action"); await until("document.querySelector('.home-view')?.dataset.state === 'connected'");
      await click(".debug-drawer summary"); await until("document.querySelector('.debug-drawer').open");
      const originalMessageBox = dialog.showMessageBox;
      let authorized;
      try {
        // Only the unpackaged visual fixture can supply this synthetic observation.
        report.mockedAuthorizationDialog = true;
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
        await until("[...document.querySelectorAll('.debug-drawer button')].some(b => b.textContent === '开启自动调试…' && !b.disabled)");
        await evaluate("[...document.querySelectorAll('.debug-drawer button')].find(b => b.textContent === '开启自动调试…').click()");
        await until("[...document.querySelectorAll('.debug-drawer strong')].some(b => b.textContent === 'com.example.sanitized')");
        authorized = await evaluate("window.electronApi.getDebugSession()");
      } finally { dialog.showMessageBox = originalMessageBox; }
      assert(authorized?.active, "Synthetic authorization missing");
      const cli = resources ? join(resolve(resources), "cli", "android-ui.cjs") : join(project, "dist-electron", "cli.cjs");
      const runCli = (...args) => promisify(execFile)(process.execPath, [cli, ...args,
        "--snapshot-file", join(app.getPath("userData"), "mcp", "current.json")],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 15000, maxBuffer: 1024 * 1024 });
      const cliResult = await runCli("capture", "--session", authorized.id);
      assert.equal(JSON.parse(cliResult.stdout).isError, undefined);
      let currentSteps = 1;
      if (taskReportFile) {
        const taskFile = join(output, "fixture-task.json");
        writeFileSync(taskFile, JSON.stringify({ goal: "确认离线样例的固定标题", checkpoints: [],
          finalConditions: [{ id: "title", selector: { text: "Sample title" }, state: "visible" }] }));
        const defined = JSON.parse((await runCli("task-define", "--session", authorized.id, "--task-file", taskFile)).stdout);
        assert.equal(typeof defined.taskId, "string");
        const checked = JSON.parse((await runCli("task-check", "--session", authorized.id, "--task-id", defined.taskId)).stdout);
        assert.equal(checked.taskResult.status, "passed");
        assert.notEqual(checked.taskResult.observations.first.snapshotId, checked.taskResult.observations.second.snapshotId);
        currentSteps = 3;
      }
      await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === '测试报告').click()");
      await until("document.querySelector('.test-report-dialog').open");
      await until("[...document.querySelectorAll('.test-report-header button')].some(b => b.textContent === '查看当前调试记录')");
      const currentRecord = () => evaluate("[...document.querySelectorAll('.test-report-header button')].find(b => b.textContent === '查看当前调试记录').click()");
      await currentRecord(); await until(`document.querySelector('.test-report-summary')?.textContent.includes(${JSON.stringify(authorized.id)})`);
      assert.equal(await evaluate("document.querySelectorAll('.test-report-steps li').length"), currentSteps);
      if (taskReportFile) {
        await until("document.querySelector('.debug-task-summary')?.dataset.taskStatus === 'passed'");
        assert.equal(await evaluate("document.querySelector('.debug-task-goal').textContent.includes('确认离线样例的固定标题')"), true);
        report.checks.push("actual source main and standalone CLI define/check fixed task; two new observations, no device input, task proof reaches the report UI");
      }
      await evaluate("window.electronApi.stopMcpSharing()");
      await currentRecord(); await until("document.querySelector('.test-report-summary [data-status]')?.dataset.status === 'recorded'");
      assert.equal(await evaluate("document.querySelectorAll('.test-report-steps li').length"), currentSteps);
      report.checks.push("actual fixture authorization and CLI capture; current-record IPC and report UI remain readable after stop; no phone operations");
      chosen = synthetic; await importChosen();
      assert.equal(await evaluate("document.querySelector('.test-report-summary').textContent.includes('synthetic-run')"), true);
      await click(".test-report-header button[aria-label='关闭测试报告']");
      await until("!document.querySelector('.test-report-dialog').open");
      if (await evaluate("Boolean(document.querySelector('.workbench-utilities'))")) {
        await click(".workbench-utilities > summary"); await until("document.querySelector('.workbench-utilities').open");
      }
      if (!await evaluate("document.querySelector('.debug-drawer').open")) await click(".debug-drawer summary");
      await until("document.querySelector('.debug-drawer').open");
      await evaluate("[...document.querySelectorAll('.debug-drawer button')].find(b => b.textContent === '查看调试记录').click()");
      await until(`document.querySelector('.test-report-dialog').open && document.querySelector('.test-report-summary')?.textContent.includes(${JSON.stringify(authorized.id)})`);
      assert.equal(await evaluate("document.querySelector('.test-report-summary [data-status]').dataset.status"), "recorded");
      assert.equal(await evaluate("document.querySelectorAll('.test-report-steps li').length"), currentSteps);
      report.checks.push("dedicated debug-record entry loads the current session directly over a previously imported report");
      await click(".test-report-header button[aria-label='关闭测试报告']");
      await until("!document.querySelector('.test-report-dialog').open");
    }
    if (taskReportFile) {
      await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === '测试报告').click()");
      await until("document.querySelector('.test-report-dialog').open");
      chosen = resolve(taskReportFile); await importChosen();
      await until("document.querySelector('.debug-task-summary')?.dataset.taskStatus === 'passed'");
      assert.equal(await evaluate("document.querySelector('.debug-task-goal').textContent.includes('从准备状态到达完成状态')"), true);
      assert.equal(await evaluate("document.querySelector('.test-report-summary [data-status]').dataset.status"), "recorded");
      assert.equal(await evaluate("document.querySelectorAll('.test-report-steps li').length"), 5);
      await click(".debug-task-checkpoints > summary");
      assert.equal(await evaluate("document.querySelector('[data-task-checkpoint=ready]').dataset.taskStatus"), "passed");
      for (const [stepId, status] of [[2, "insufficient_evidence"], [4, "failed"], [5, "passed"]]) {
        await evaluate(`[...document.querySelectorAll('.test-report-steps li button')].find(b => b.querySelector('span')?.textContent.startsWith('#${stepId}. ')).click()`);
        await until(`document.querySelector('.debug-task-check-detail')?.dataset.taskStatus === '${status}'`);
        assert.equal(await evaluate("Boolean(document.querySelector('.debug-report-input-marker'))"), false);
        if (stepId > 2) {
          await until("document.querySelectorAll('[data-task-observation] img').length === 2 && [...document.querySelectorAll('[data-task-observation] img')].every(img => img.naturalWidth === 160)");
          assert.equal(await evaluate("document.querySelector('[data-task-observation=first] h4').textContent.includes('第1次') && document.querySelector('[data-task-observation=second] h4').textContent.includes('第2次')"), true);
        }
      }
      for (const [width, height] of [[1440, 900], [960, 700]]) {
        window.setContentSize(width, height); await until(`innerWidth === ${width}`); await painted();
        assert.equal(await evaluate("document.querySelector('.test-report-dialog').scrollWidth <= document.querySelector('.test-report-dialog').clientWidth + 1"), true);
        await evaluate("document.querySelector('.test-report-detail').scrollTop = 0"); await painted();
        writeFileSync(join(output, `task-acceptance-${width}.png`), (await window.webContents.capturePage()).toPNG());
        await evaluate("(() => { const detail = document.querySelector('.test-report-detail'), check = document.querySelector('.debug-task-check-detail'); detail.scrollTop += check.getBoundingClientRect().top - detail.getBoundingClientRect().top - 12; })()");
        await painted(); writeFileSync(join(output, `task-check-${width}.png`), (await window.webContents.capturePage()).toPNG());
      }
      report.checks.push("version 2 fixed goal, ordered stage, final and historical pass/fail/insufficient evidence through actual import IPC; observations remain distinct and no input marker");
      if (missingTaskReportFile) {
        chosen = resolve(missingTaskReportFile); await importChosen();
        await until("document.querySelector('.debug-task-summary')?.dataset.taskStatus === 'insufficient_evidence'");
        assert.equal(await evaluate("document.querySelector('.debug-report-read-errors')?.open"), false);
        assert.equal(await evaluate("document.querySelector('.test-report-layout').getBoundingClientRect().height >= 250"), true);
        if (!await evaluate("document.querySelector('.debug-task-checkpoints').open")) await click(".debug-task-checkpoints > summary");
        await click(".debug-task-final [data-task-check-step]");
        await until("document.querySelector('.debug-task-check-detail')?.dataset.taskStatus === 'insufficient_evidence'");
        assert.equal(await evaluate("document.querySelector('.debug-task-summary').textContent.includes('证据不足')"), true);
        assert.equal(await evaluate("document.querySelector('.debug-report-step-detail').textContent.includes('两次新观察均满足所有声明的页面条件')"), false);
        await evaluate("document.querySelector('.test-report-detail').scrollTop = 0");
        await painted(); writeFileSync(join(output, "task-missing-evidence.png"), (await window.webContents.capturePage()).toPNG());
        await evaluate("(() => { const detail = document.querySelector('.test-report-detail'), check = document.querySelector('.debug-task-check-detail'); detail.scrollTop += check.getBoundingClientRect().top - detail.getBoundingClientRect().top - 12; })()");
        await painted(); writeFileSync(join(output, "task-missing-check.png"), (await window.webContents.capturePage()).toPNG());
        await click(".debug-report-read-errors > summary");
        assert.equal(await evaluate("document.querySelector('.debug-report-read-errors').open && document.querySelector('.debug-report-read-errors pre').textContent.includes('tree-unavailable')"), true);
        await click(".debug-report-read-errors > summary");
        report.checks.push("missing saved tree downgrades the declared final pass to insufficient evidence in the actual report UI");
      }
      await click(".test-report-header button[aria-label='关闭测试报告']");
      await until("!document.querySelector('.test-report-dialog').open");
    }
    if (resources) { evidence.verifyUnchanged(report.resourceIdentity, resolve(resources)); report.resourcesUnchanged = true; }
    report.passed = true;
    writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
    console.log(`Report UI passed: ${output}`); clearTimeout(timer); app.exit(0);
  } catch (error) {
    report.error = error.message; writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(output, "failed.png"), (await window.webContents.capturePage()).toPNG());
    console.error(error); clearTimeout(timer); app.exit(1);
  }
});
