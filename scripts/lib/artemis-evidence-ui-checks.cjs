const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async function verifyArtemisEvidence({ window, evaluate, until, cli, output, dialog, item, app, deviceRequests }) {
  const report = { scope: "current main/preload/renderer with isolated synthetic device; no phone or installed app changes", checks: [], screenshots: [], passed: false };
  const check = name => { report.checks.push(name); console.log(`PASS: ${name}`); };
  const ready = selector => until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector, value) => evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : field.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(field,${JSON.stringify(value)});
    field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input',{bubbles:true}));
  })()`);
  const paint = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const layout = async (selector, name, width, height) => {
    window.setContentSize(width, height); await paint();
    if (name === 'template-checked') {
      await evaluate("document.querySelector('.task-editor-check').scrollIntoView({block:'end'})"); await paint();
      assert(await evaluate("(() => { const dialog=document.querySelector('dialog.debug-task-editor').getBoundingClientRect(); return ['.task-editor-check','[data-task-action=check]'].every(selector=>{const r=document.querySelector(selector).getBoundingClientRect(); return r.top>=dialog.top && r.bottom<=dialog.bottom && r.top>=0 && r.bottom<=innerHeight;}); })()"), 'Checker verdict and action can be read after scrolling at this window size');
    }
    const bounds = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}), r = el.getBoundingClientRect();
      return { left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewport:{width:innerWidth,height:innerHeight},
        overflow:document.documentElement.scrollWidth > innerWidth }; })()`);
    assert(bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.top >= 0
      && bounds.right <= bounds.viewport.width + 1 && bounds.bottom <= bounds.viewport.height + 1 && !bounds.overflow, JSON.stringify(bounds));
    const file = `${name}-${width}.png`; writeFileSync(join(output,file),(await window.webContents.capturePage()).toPNG());
    report.screenshots.push({file,...bounds});
  };
  const showTools = () => evaluate("if(document.querySelector('.workbench-utilities')) document.querySelector('.workbench-utilities').open=true");
  const selectCheck = async () => {
    await evaluate("[...document.querySelectorAll('.test-report-steps ol button')].find(x=>x.textContent.includes('check_debug_task')).click()");
    await ready('.debug-step-diff');
  };
  const exportParent = join(output,"exports"); mkdirSync(exportParent);
  const originalMessage = dialog.showMessageBox, originalOpen = dialog.showOpenDialog;
  try {
    report.checkpoint = "offline template";
    await click('[data-command="debug-task-template"]'); await ready('dialog.debug-task-editor[open]');
    assert.equal(await evaluate("document.querySelector('[data-task-action=define]').disabled"),true);
    await layout('dialog.debug-task-editor','template-empty',1440,900);
    window.webContents.sendInputEvent({type:"keyDown",keyCode:"Escape"}); window.webContents.sendInputEvent({type:"keyUp",keyCode:"Escape"});
    await until(() => evaluate("!document.querySelector('dialog.debug-task-editor[open]')"));
    const originalDeviceRequests = deviceRequests.length;
    item("capture").click(); await ready('.tree-row.selected');
    await evaluate("[...document.querySelectorAll('.tree-row')].find(x=>x.textContent.includes('Sample title')).click()");
    await showTools(); await click('[data-command="debug-task-template"]'); await ready('dialog.debug-task-editor[open]');
    await fill('[data-task-field="goal"]','Sample title remains visible'); await fill('[data-task-field="name"]','Native evidence task');
    await click('[data-task-action="use-selected-node"]');
    assert.equal(await evaluate("document.querySelector('[data-task-field=resourceId]').value"),'com.example.sanitized:id/title');
    await click('[data-task-action="save"]');
    await until(async () => (await evaluate("window.electronApi.loadDebugTaskTemplates()")).templates.length === 1);
    await until(() => evaluate("document.querySelector('[data-task-action=save-as-new]') !== null"));
    const stored = await evaluate("window.electronApi.loadDebugTaskTemplates()");
    assert.equal(stored.error,null); const template = stored.templates[0];
    assert.equal(template.definition.finalConditions[0].selector.resourceId,'com.example.sanitized:id/title');
    const requestsAfterCapture = deviceRequests.length;
    assert.equal(requestsAfterCapture,originalDeviceRequests+1);
    await click('[data-task-action="new"]'); await fill('[data-task-field="template-list"]',template.id); await click('[data-task-action="load"]');
    assert.equal(await evaluate("document.querySelector('[data-task-field=goal]').value"),template.definition.goal);
    await layout('dialog.debug-task-editor','template-draft',1440,900); await layout('dialog.debug-task-editor','template-draft',960,700);
    await click('[data-task-action="close"]');
    check("offline editor creates selectors from the selected control, saves and restores local templates without device work; native Escape closes");

    report.checkpoint = "authorized template check";
    dialog.showMessageBox = async () => ({response:1});
    await evaluate("document.querySelector('.debug-drawer').open=true; document.querySelector('.debug-drawer .snapshot-actions button').click()");
    await until(async () => (await evaluate("window.electronApi.getDebugSession()"))?.active === true);
    const grant = await evaluate("window.electronApi.getDebugSession()"); assert(grant.active);
    await ready('.debug-stop'); await showTools(); await click('[data-command="debug-task-template"]'); await ready('dialog.debug-task-editor[open]');
    await until(() => evaluate("document.querySelector('[data-task-field=template-list] option:not([disabled])') !== null"));
    await fill('[data-task-field="template-list"]',template.id); await click('[data-task-action="load"]'); await click('[data-task-action="define"]');
    await until(async () => Boolean((await evaluate("window.electronApi.getDebugSession()")).task));
    await ready('[data-task-action="check"]'); await until(() => evaluate("!document.querySelector('[data-task-action=check]').disabled"));
    await click('[data-task-action="check"]');
    await until(async () => (await evaluate("window.electronApi.getDebugSession()")).task?.checks[0]?.status === 'passed');
    const checked = await evaluate("window.electronApi.getDebugSession()");
    assert.equal(checked.task.definition.goal,template.definition.goal); assert.equal(checked.task.checks[0].conditions.length,1);
    const observed = checked.task.checks[0].observations; assert(observed.first.snapshotId !== observed.second.snapshotId);
    await until(() => evaluate("document.querySelector('.task-editor-session').textContent.includes('通过')"));
    await evaluate("document.querySelector('.task-editor-session').scrollIntoView({block:'nearest'})"); await paint();
    await layout('dialog.debug-task-editor','template-checked',1440,900); await layout('dialog.debug-task-editor','template-checked',960,700);
    await click('[data-task-action="close"]');
    check("template definition uses the current grant; the original Checker takes two fresh observations and exposes its separate verdict");

    report.checkpoint = "report diff";
    try { await cli('wait','--session',grant.id,'--text','missing-native-evidence-control','--timeout-ms','1000'); }
    catch (error) { assert.equal(JSON.parse(error.stderr).isError,true); }
    await cli('stop','--session',grant.id);
    const stopped = await evaluate("window.electronApi.getDebugSession()");
    const sourceBytes = readFileSync(stopped.reportPath), sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
    const sourceReport = JSON.parse(sourceBytes);
    await showTools(); await evaluate("document.querySelector('.debug-drawer').open=true; [...document.querySelectorAll('.debug-drawer .snapshot-actions button')].find(x=>x.textContent==='查看调试记录').click()");
    await ready('.test-report-dialog[open]'); await ready('.debug-report-step-detail');
    await selectCheck();
    assert.notEqual(await evaluate("document.querySelector('.debug-step-diff').dataset.diffStatus"),'unavailable');
    assert(await evaluate("document.querySelector('.debug-step-diff').textContent.includes('不改变 Checker')"));
    await evaluate("document.querySelector('.debug-step-diff').scrollIntoView({block:'start'})"); await paint();
    await layout('.test-report-dialog','report-diff',1440,900); await layout('.test-report-dialog','report-diff',960,700);
    check("saved ordinary observation identity reaches the loaded report; two Checker trees compare by resource identity without changing the verdict");

    report.checkpoint = "export and import";
    await evaluate("document.querySelector('details.debug-report-export').open=true"); await ready('[data-export-action="start"]');
    dialog.showOpenDialog = async () => ({canceled:true,filePaths:[]}); await click('[data-export-action="start"]');
    await ready('[data-export-state="canceled"]'); assert.equal(readdirSync(exportParent).length,0);
    dialog.showOpenDialog = async () => ({canceled:false,filePaths:[exportParent]});
    await fill('[data-export-scope]','all'); await click('[data-export-action="start"]'); await ready('[data-export-state="complete"]');
    const directories = readdirSync(exportParent); assert.equal(directories.length,1); const complete = join(exportParent,directories[0]);
    const exported = JSON.parse(readFileSync(join(complete,'report.json'),'utf8'));
    assert.equal(exported.steps.length,3); assert(exported.steps.some(entry=>entry.logs?.some(log=>log.file)));
    assert.equal(exported.task.checks[0].status,'passed'); assert(exported.snapshots.every(snapshot=>snapshot.tree));
    for (const snapshot of exported.snapshots) {
      const original = sourceReport.snapshots.find(value => value.snapshotId === snapshot.snapshotId);
      assert.equal(Boolean(snapshot.screenshot), Boolean(original.screenshot), 'export preserves actual screenshot availability');
    }
    const manifest = JSON.parse(readFileSync(join(complete,'manifest.json'),'utf8')); report.completeManifest=manifest;
    assert(JSON.stringify(manifest).includes(app.getVersion())); assert(JSON.stringify(manifest).includes('visual-fixture'));
    for (const snapshot of exported.snapshots.filter(value => !value.screenshot))
      assert(manifest.omissions.some(value => value.snapshotId === snapshot.snapshotId && value.kind === 'screenshot'));
    await evaluate("document.querySelector('.debug-report-export').scrollIntoView({block:'start'})"); await paint();
    await layout('.test-report-dialog','export-complete',1440,900); await layout('.test-report-dialog','export-complete',960,700);
    dialog.showOpenDialog = async () => ({canceled:false,filePaths:[join(complete,'report.json')]});
    await evaluate("[...document.querySelectorAll('.test-report-header button')].find(x=>x.textContent.includes('导入报告')).click()");
    await until(() => evaluate("!document.querySelector('.test-report-import-status') && !document.querySelector('[data-export-state=complete]') && document.querySelector('.debug-report-retention')?.textContent.includes('最近 3 步')"));
    await selectCheck(); assert(await evaluate("document.querySelector('.debug-task-summary').textContent.includes('通过')"));
    assert.notEqual(await evaluate("document.querySelector('.debug-step-diff').dataset.diffStatus"),'unavailable');
    check("cancel leaves no bundle; complete export preserves actual tree/picture availability, failure logs and device/version metadata, records missing attachments, then imports through the existing report reader");

    report.checkpoint = "export missing proof";
    await evaluate("document.querySelector('details.debug-report-export').open=true");
    assert.equal(await evaluate("document.querySelector('[data-export-scope]').value"),'current');
    assert.equal(await evaluate("document.querySelector('[data-export-include=trees]').checked"),true);
    await click('[data-export-include="trees"]');
    dialog.showOpenDialog = async () => ({canceled:false,filePaths:[exportParent]}); await click('[data-export-action="start"]');
    await ready('[data-export-state="complete"]');
    const next = readdirSync(exportParent).filter(name=>name!==directories[0]); assert.equal(next.length,1); const subset=join(exportParent,next[0]);
    const filtered = JSON.parse(readFileSync(join(subset,'report.json'),'utf8'));
    assert.equal(filtered.steps.length,1); assert.equal(filtered.steps[0].step.action,'check_debug_task');
    assert.equal(filtered.task.checks[0].status,'insufficient_evidence'); assert(filtered.snapshots.every(snapshot=>snapshot.tree===null));
    assert.equal(filtered.steps[0].logs?.some(log=>log.file) ?? false,false);
    dialog.showOpenDialog = async () => ({canceled:false,filePaths:[join(subset,'report.json')]});
    await evaluate("[...document.querySelectorAll('.test-report-header button')].find(x=>x.textContent.includes('导入报告')).click()");
    await until(() => evaluate("document.querySelector('.debug-report-retention')?.textContent.includes('最近 1 步')"));
    await ready('.debug-step-diff[data-diff-status="unavailable"]');
    assert(await evaluate("document.querySelector('.debug-task-summary').textContent.includes('证据不足')"));
    await evaluate("document.querySelector('.debug-step-diff').scrollIntoView({block:'start'})"); await paint();
    await layout('.test-report-dialog','export-no-tree',960,700);
    assert.equal(createHash('sha256').update(readFileSync(stopped.reportPath)).digest('hex'),sourceHash);
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(() => evaluate("!document.querySelector('.test-report-dialog[open]')"));
    check("current-step export excludes other logs; omitting tree proof downgrades the copied Checker result and reopens as insufficient evidence; source files stay unchanged");

    report.checkpoint = "template delete";
    await showTools(); await click('[data-command="debug-task-template"]'); await ready('dialog.debug-task-editor[open]');
    await until(() => evaluate("document.querySelector('[data-task-field=template-list] option:not([disabled])') !== null"));
    await fill('[data-task-field="template-list"]',template.id); await click('[data-task-action="delete"]');
    await until(async () => (await evaluate("window.electronApi.loadDebugTaskTemplates()")).templates.length===0);
    await click('[data-task-action="close"]');
    check("deleting a template uses the real local store and does not restart the stopped session");
    report.passed=true;
  } catch(error) {
    report.error=String(error); writeFileSync(join(output,'failure.png'),(await window.webContents.capturePage()).toPNG()); throw error;
  } finally {
    dialog.showMessageBox=originalMessage; dialog.showOpenDialog=originalOpen;
    writeFileSync(join(output,'artemis-evidence-result.json'),JSON.stringify(report,null,2)+'\n');
    console.log(`Artemis evidence checks: ${join(output,'artemis-evidence-result.json')}`);
  }
};
