const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async function verifyArtemis({ window, evaluate, until, cli, output, dialog, item, overrideProbe }) {
  const report = { scope: "current main/preload/renderer, isolated synthetic device; no phone or installed app changes", checks: [], screenshots: [], passed: false };
  const check = name => { report.checks.push(name); console.log(`PASS: ${name}`); };
  const ready = selector => until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const layout = async (selector, name, width, height) => {
    window.setContentSize(width, height);
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    if (name === "progress") {
      await evaluate("document.querySelector('.debug-session-progress').scrollIntoView({block:'nearest'})");
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const progressBounds = await evaluate(`(() => { const p = document.querySelector('.debug-session-progress').getBoundingClientRect(),
        d = document.querySelector('.debug-session-progress dl').getBoundingClientRect(),
        m = document.querySelector('.workbench-utilities-body').getBoundingClientRect();
        return { top:p.top, bottom:p.bottom, verdictBottom:d.bottom, menuTop:m.top, menuBottom:m.bottom,
          readable:p.top >= m.top && p.bottom <= m.bottom && d.bottom <= m.bottom && p.right <= innerWidth }; })()`);
      assert(progressBounds.readable, "Progress should be readable inside the tool drawer: " + JSON.stringify(progressBounds));
      report.progressLayouts ??= []; report.progressLayouts.push({width, ...progressBounds});
    }
    const bounds = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)}), r = el.getBoundingClientRect();
      return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height,
        viewport:{width:innerWidth,height:innerHeight}, overflow:document.documentElement.scrollWidth > innerWidth };
    })()`);
    assert(bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.top >= 0
      && bounds.right <= bounds.viewport.width + 1 && bounds.bottom <= bounds.viewport.height + 1 && !bounds.overflow, JSON.stringify(bounds));
    const file = `${name}-${width}.png`;
    writeFileSync(join(output, file), (await window.webContents.capturePage()).toPNG());
    report.screenshots.push({ file, ...bounds });
  };
  const showTools = () => evaluate("if (document.querySelector('.workbench-utilities')) document.querySelector('.workbench-utilities').open = true");
  const closeTools = () => evaluate("if (document.querySelector('.workbench-utilities')) document.querySelector('.workbench-utilities').open = false");
  const oldDialog = dialog.showMessageBox;
  try {
    report.checkpoint = "diagnosis";
    await click('[data-command="connection-diagnosis"]');
    await ready('.connection-diagnostic-dialog[open]');
    await click('.connection-diagnostic-actions button');
    await ready('.connection-diagnostic-result.ready');
    assert.equal(await evaluate("document.querySelectorAll('.connection-diagnostic-checks > li').length"), 9);
    assert(await evaluate("[...document.querySelectorAll('.connection-diagnostic-checks > li')].filter(x => /Helper|SDK/.test(x.textContent)).every(x => x.textContent.includes('可选'))"));
    await layout('.connection-diagnostic-dialog', 'diagnosis', 1440, 900);
    await layout('.connection-diagnostic-dialog', 'diagnosis', 960, 700);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await until(() => evaluate("!document.querySelector('.connection-diagnostic-dialog')"));
    check("shared diagnosis uses real desktop IPC; optional Helper/SDK do not block; native Escape closes");

    report.checkpoint = "preview";
    item("capture").click();
    await ready('.tree-row.selected');
    const tree = await evaluate("({text:[...document.querySelectorAll('.tree-row')].map(x=>x.textContent), selected:document.querySelector('.tree-row.selected').dataset.treeId, screenshot:document.querySelector('.screenshot-stage img')?.src})");
    await showTools(); await click('[data-command="live-preview"]'); await closeTools();
    await until(() => evaluate("document.querySelector('.live-preview-image img')?.naturalWidth > 0"));
    const first = await evaluate("window.electronApi.getLivePreview()");
    assert.equal(first.state.status, "running"); assert(first.frame.sequence > 0);
    item("refresh").click();
    await until(() => item("refresh").enabled);
    assert.equal((await evaluate("window.electronApi.getLivePreview()")).state.sessionId, first.state.sessionId);
    assert.equal((await evaluate("window.electronApi.getLivePreview()")).state.status, "running");
    await layout('.live-preview-panel', 'preview', 1440, 900);
    await layout('.live-preview-panel', 'preview', 960, 700);
    await click('.live-preview-status-row button');
    await until(() => evaluate("document.querySelector('.live-preview-status-row button')?.textContent === '继续'"));
    const paused = await evaluate("window.electronApi.getLivePreview()");
    const oldTreeTime = await evaluate("document.querySelector('.live-preview-times > div:last-child time').dateTime");
    await delay(2200);
    assert.equal((await evaluate("window.electronApi.getLivePreview()")).frame.sequence, paused.frame.sequence);
    assert.deepEqual(await evaluate("({text:[...document.querySelectorAll('.tree-row')].map(x=>x.textContent), selected:document.querySelector('.tree-row.selected').dataset.treeId, screenshot:document.querySelector('.screenshot-stage img')?.src})"), tree);
    item("capture").click();
    await until(() => evaluate(`Boolean(document.querySelector('.tree-row')) && document.querySelector('.live-preview-times > div:last-child time')?.dateTime !== ${JSON.stringify(oldTreeTime)}`));
    const afterCapture = await evaluate("window.electronApi.getLivePreview()");
    assert.equal(afterCapture.state.status, "paused"); assert.equal(afterCapture.frame.capturedAt, paused.frame.capturedAt);
    await click('.live-preview-status-row button');
    await until(async () => (await evaluate("window.electronApi.getLivePreview()")).frame?.sequence > paused.frame.sequence);
    await click('.live-preview-close');
    await until(() => evaluate("!document.querySelector('.live-preview-panel')"));
    assert.equal((await evaluate("window.electronApi.getLivePreview()")).state.status, "stopped");
    check("device-list refresh retains preview; preview pauses without replacing tree/selection, yields to capture, resumes and closes");

    await showTools(); await click('[data-command="live-preview"]'); await closeTools();
    await until(() => evaluate("document.querySelector('.live-preview-image img')?.naturalWidth > 0"));
    const originalProbe = await evaluate("window.electronApi.probeAdb()");
    overrideProbe({ ...originalProbe, devices: [{ ...originalProbe.devices[0], serial: "other-synthetic-device" }] });
    item("refresh").click();
    await until(() => item("refresh").enabled);
    await until(() => evaluate("!document.querySelector('.live-preview-panel')"));
    const switched = await evaluate("window.electronApi.getLivePreview()");
    assert.equal(switched.state.status, "stopped"); assert.equal(switched.state.serial, "visual-fixture");
    overrideProbe(undefined);
    item("refresh").click(); await until(() => item("refresh").enabled);
    assert.equal(await evaluate("Boolean(document.querySelector('.live-preview-panel'))"), false);
    check("disappearance of the chosen device closes preview; fallback device and reconnection never auto-start it");

    report.checkpoint = "progress and logs";
    await showTools(); await evaluate("document.querySelector('.debug-drawer').open = true");
    const option = '.debug-session-log-option input';
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(option)}).checked`), false);
    await click(option);
    let confirmationHasLogs = false;
    dialog.showMessageBox = async (_window, options) => { confirmationHasLogs = options.detail.includes("本次另保存目标 App"); return { response: 1 }; };
    await evaluate("[...document.querySelectorAll('.debug-drawer .snapshot-actions button')].find(x=>x.textContent.includes('开启自动调试')).click()");
    await ready('.debug-stop');
    const grant = await evaluate("window.electronApi.getDebugSession()");
    assert.equal(grant.androidLogsEnabled, true); assert.equal(confirmationHasLogs, true);
    await cli("capture", "--session", grant.id, "--mode", "fast");
    let failure;
    try { await cli("wait", "--session", grant.id, "--text", "no-such-artemis-control", "--timeout-ms", "1000"); }
    catch (error) { failure = JSON.parse(error.stderr); }
    assert.equal(failure?.isError, true);
    await until(async () => !(await evaluate("window.electronApi.getDebugSession()")).busy);
    await showTools(); await evaluate("document.querySelector('.debug-drawer').open = true");
    assert(await evaluate("document.querySelector('.debug-session-progress').textContent.includes('未声明任务')"));
    await layout('.workbench-utilities-body', 'progress', 1440, 900);
    await layout('.workbench-utilities-body', 'progress', 960, 700);
    await cli("stop", "--session", grant.id);
    const stopped = await evaluate("window.electronApi.getDebugSession()");
    assert.equal(stopped.active, false);
    const saved = JSON.parse(readFileSync(stopped.reportPath, "utf8"));
    const failedStep = saved.steps.find(x => x.step.status === "failed");
    assert(failedStep?.logs?.some(log => log.source === "session" && log.status === "available" && log.file), "Failed step did not retain session error logs");
    assert(failedStep.logs.some(log => log.source === "android" && log.status === "unavailable"), "Synthetic device must report unavailable Android logs");
    report.savedLogStep = { stepId: failedStep.step.id, logs: failedStep.logs };
    await evaluate("[...document.querySelectorAll('.debug-drawer .snapshot-actions button')].find(x=>x.textContent==='查看调试记录').click()");
    await ready('.test-report-dialog[open]');
    await until(() => evaluate("Boolean(document.querySelector('.debug-report-step-detail'))"));
    await layout('.test-report-dialog', 'failure-report', 1440, 900);
    await layout('.test-report-dialog', 'failure-report', 960, 700);
    await evaluate("document.querySelector('.debug-report-logs').scrollIntoView({block:'start'})");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert(await evaluate("document.querySelector('.debug-report-logs pre')?.textContent.includes('timeout')"));
    await layout('.test-report-dialog', 'failure-logs', 960, 700);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await until(() => evaluate("!document.querySelector('.test-report-dialog[open]')"));
    check("Android logs need explicit opt-in; failed wait keeps evidence/logs and separate verdict; stopped report reopens");

    report.checkpoint = "stale events";
    const next = await evaluate("window.electronApi.startDebugSession('visual-fixture')");
    assert(next.active && next.id !== grant.id);
    window.webContents.send("debug-session-event", { state: { ...stopped, stopReason: "old-session-must-not-replace", progress: { ...stopped.progress, reason: "old-session-must-not-replace" } } });
    await delay(80);
    assert.equal(await evaluate("document.querySelector('.debug-session-progress').textContent.includes('old-session-must-not-replace')"), false);
    assert.equal((await evaluate("window.electronApi.getDebugSession()")).id, next.id);
    await cli("stop", "--session", next.id);
    check("retired session events cannot replace the new progress state");
    report.passed = true;
  } catch (error) {
    report.error = String(error);
    writeFileSync(join(output, "failure.png"), (await window.webContents.capturePage()).toPNG());
    throw error;
  } finally {
    dialog.showMessageBox = oldDialog;
    writeFileSync(join(output, "artemis-result.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`Artemis checks: ${join(output, "artemis-result.json")}`);
  }
};
