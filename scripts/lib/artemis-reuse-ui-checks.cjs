const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async function verifyArtemisReuse({ window, evaluate, until, cli, output, dialog, item, app, deviceRequests }) {
  const report = { scope: "current main/preload/renderer, isolated synthetic device and private profile; no phone or installed app changes", checks: [], screenshots: [], passed: false };
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
  const layout = async (selector, name, width, height, contentSelector) => {
    window.setContentSize(width, height); await paint();
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`); await paint();
    if (contentSelector) {
      await evaluate(`document.querySelector(${JSON.stringify(contentSelector)}).scrollIntoView({block:'start'})`); await paint();
      const visible = await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(contentSelector)}),r=el.getBoundingClientRect(); return r.width>0 && r.top>=0 && r.top<innerHeight-40 && r.right<=innerWidth+1})()`);
      assert(visible, `Feature content is not visible: ${contentSelector}`);
    }
    const bounds = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}), r=el.getBoundingClientRect();
      return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewport:{width:innerWidth,height:innerHeight},
        overflow:document.documentElement.scrollWidth>innerWidth}; })()`);
    assert(bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.top >= 0
      && bounds.right <= bounds.viewport.width + 1 && bounds.bottom <= bounds.viewport.height + 1 && !bounds.overflow, JSON.stringify(bounds));
    if (name.startsWith('run-comparison')) {
      const usable = await evaluate(`(() => { const panel=document.querySelector('.test-report-dialog'),header=panel.querySelector('.test-report-header').getBoundingClientRect(),steps=panel.querySelector('.test-report-layout').getBoundingClientRect(),r=panel.getBoundingClientRect();
        return {headerVisible:header.top>=r.top && header.bottom<=r.bottom,stepHeight:steps.height,stepsVisible:steps.top>=r.top && steps.bottom<=r.bottom+1,scrollTop:panel.scrollTop} })()`);
      assert(usable.headerVisible && usable.stepsVisible && usable.stepHeight>=120 && usable.scrollTop===0,JSON.stringify(usable));
      bounds.reportControls=usable;
    }
    const file = `${name}-${width}.png`; writeFileSync(join(output,file),(await window.webContents.capturePage()).toPNG()); report.screenshots.push({file,...bounds});
  };
  const showTools = () => evaluate("if(document.querySelector('.workbench-utilities')) document.querySelector('.workbench-utilities').open=true");
  const openEditor = async () => { await showTools(); await click('[data-command="debug-task-template"]'); await ready('dialog.debug-task-editor[open]'); };
  const idle = () => until(() => evaluate("!document.querySelector('[data-task-action=import]').disabled"));
  const message = text => until(() => evaluate(`document.querySelector('.task-editor-message')?.textContent.includes(${JSON.stringify(text)})`));
  const originalOpen = dialog.showOpenDialog, originalSave = dialog.showSaveDialog, originalMessage = dialog.showMessageBox;
  const shared = join(output,"task-library.json"), invalid = join(output,"invalid-library.json"), exports = join(output,"exports"); mkdirSync(exports);
  const firstRequests = deviceRequests.length;
  try {
    report.checkpoint = "template and fragments";
    item("capture").click(); await ready('.tree-row.selected');
    await evaluate("[...document.querySelectorAll('.tree-row')].find(x=>x.textContent.includes('Sample title')).click()");
    const capturedRequests = deviceRequests.length; assert.equal(capturedRequests,firstRequests+1);
    await openEditor(); await idle();
    await fill('[data-task-field=goal]','Sample title remains visible'); await fill('[data-task-field=name]','Shared native task');
    await click('[data-task-action=use-selected-node]');
    await evaluate("[...document.querySelectorAll('.task-editor-draft button')].find(x=>x.textContent==='添加阶段').click()");
    await fill('[aria-label="阶段1名称"]','Title checkpoint'); await click('.task-editor-stage [data-task-action=use-selected-node]');
    await click('.task-editor-final [data-task-action=save-condition-fragment]'); await fill('[data-task-field=fragment-name]','Title condition');
    await click('[data-task-action=fragment-save]'); await message('命名片段已保存在本机');
    await click('[data-task-action=save-stage-fragment]'); await fill('[data-task-field=fragment-name]','Title stage');
    await click('[data-task-action=fragment-save]'); await message('命名片段已保存在本机');
    const fragments = (await evaluate("window.electronApi.loadDebugTaskFragments()")).fragments; assert.equal(fragments.length,2);
    await click('[data-task-action=show-templates]'); await click('[data-task-action=save]'); await message('模板已保存在本机');
    const saved = (await evaluate("window.electronApi.loadDebugTaskTemplates()")).templates[0]; assert.equal(saved.definition.checkpoints.length,1);
    assert.equal(saved.definition.finalConditions[0].selector.resourceId,'com.example.sanitized:id/title');
    await click('[data-task-action=show-fragments]'); await fill('[data-task-field=fragment-list]',fragments.find(x=>x.kind==='condition').id);
    await click('[data-task-action=fragment-insert]'); assert.equal(await evaluate("document.querySelectorAll('.task-editor-final [data-condition-id]').length"),2);
    await fill('[data-task-field=fragment-list]',fragments.find(x=>x.kind==='stage').id); await click('[data-task-action=fragment-insert]');
    assert.equal(await evaluate("document.querySelectorAll('.task-editor-stage').length"),2);
    const ids = await evaluate("[...document.querySelectorAll('[data-condition-id]')].map(x=>x.dataset.conditionId)"); assert.equal(new Set(ids).size,ids.length);
    await layout('dialog.debug-task-editor','fragment-library',1440,900); await layout('dialog.debug-task-editor','fragment-library',960,700);
    check("actual local store saves both fragment kinds; insertion preserves content and creates unique IDs without device requests");

    report.checkpoint = "sharing";
    dialog.showSaveDialog = async () => ({canceled:true,filePath:null}); await click('[data-task-action=export]'); await message('已取消导出'); assert.equal(existsSync(shared),false);
    dialog.showSaveDialog = async () => ({canceled:false,filePath:shared}); await click('[data-task-action=export]'); await message('已导出 1 份模板、2 份片段');
    const bytes = readFileSync(shared), bundle = JSON.parse(bytes); assert.equal(bundle.version,1); assert.equal(bundle.templates.length,1); assert.equal(bundle.fragments.length,2);
    await fill('[data-task-field=goal]','Unsaved draft survives sharing');
    dialog.showOpenDialog = async () => ({canceled:false,filePaths:[shared]}); await click('[data-task-action=import]'); await message('本机同名内容已保留');
    assert.equal(await evaluate("document.querySelector('[data-task-field=goal]').value"),'Unsaved draft survives sharing');
    writeFileSync(invalid,JSON.stringify({...bundle,version:99})); dialog.showOpenDialog = async () => ({canceled:false,filePaths:[invalid]});
    await click('[data-task-action=import]'); await ready('.task-editor-message [role=alert]');
    assert.equal((await evaluate("window.electronApi.loadDebugTaskTemplates()")).templates.length,1);
    assert.deepEqual(readFileSync(shared),bytes);
    for (const item of fragments) await evaluate(`window.electronApi.deleteDebugTaskFragment(${JSON.stringify(item.id)})`);
    await evaluate(`window.electronApi.deleteDebugTaskTemplate(${JSON.stringify(saved.id)})`);
    dialog.showOpenDialog = async () => ({canceled:true,filePaths:[]}); await click('[data-task-action=import]'); await message('已取消导入');
    dialog.showOpenDialog = async () => ({canceled:false,filePaths:[shared]}); await click('[data-task-action=import]'); await message('已导入 1 份模板、2 份片段');
    const imported = (await evaluate("window.electronApi.loadDebugTaskTemplates()")).templates[0]; assert.notEqual(imported.id,saved.id);
    assert.deepEqual(imported.definition,saved.definition); assert.equal((await evaluate("window.electronApi.loadDebugTaskFragments()")).fragments.length,2);
    assert.equal(await evaluate("document.querySelector('[data-task-field=goal]').value"),'Unsaved draft survives sharing');
    await click('[data-task-action=show-templates]'); await fill('[data-task-field=template-list]',imported.id); await click('[data-task-action=load]');
    await layout('dialog.debug-task-editor','shared-template',1440,900); await layout('dialog.debug-task-editor','shared-template',960,700);
    assert.equal(deviceRequests.length,capturedRequests);
    check("native JSON export/cancel, conflict-preserving import, invalid-version rejection and empty-library round trip preserve the unsaved draft and saved content");

    report.checkpoint = "selector navigation";
    await fill('[data-task-field=goal]','Draft retained when locating a candidate');
    await click('[data-task-action=close]');
    await evaluate("[...document.querySelectorAll('.tree-row')].find(x=>x.textContent.includes('Continue')).click()");
    assert(await evaluate("document.querySelector('.tree-row.selected').textContent.includes('Continue')")); await openEditor();
    await evaluate("document.querySelector('.task-editor-final [data-selector-diagnostic]').open=true");
    await ready('.task-editor-final [data-selector-action=select]');
    assert.equal(await evaluate("document.querySelectorAll('.task-editor-final [data-selector-match=exact]').length"),1);
    await layout('dialog.debug-task-editor','selector-match',1440,900,'.task-editor-final [data-selector-diagnostic] summary');
    await layout('dialog.debug-task-editor','selector-match',960,700,'.task-editor-final [data-selector-diagnostic] summary');
    window.show(); window.focus(); await until(() => window.isFocused());
    window.webContents.focus();
    await evaluate("document.querySelector('.task-editor-final [data-selector-action=select]').focus()");
    assert(await evaluate("document.activeElement?.dataset.selectorAction==='select'"));
    await evaluate("window.__reuseKeys=[]; for(const type of ['keydown','keypress','keyup','click']) document.addEventListener(type,event=>window.__reuseKeys.push({type,key:event.key,target:event.target.dataset.selectorAction,prevented:event.defaultPrevented}),true)");
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'}); window.webContents.sendInputEvent({type:'char',keyCode:'Enter'}); window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
    await until(() => evaluate("!document.querySelector('dialog.debug-task-editor[open]')"));
    assert(await evaluate("document.querySelector('.tree-row.selected').textContent.includes('Sample title')"));
    assert(await evaluate("document.querySelector('.selection-overlay .selection-label')?.textContent.includes('Sample title')"));
    await layout('.app-shell','workbench-selected',1440,900);
    await openEditor(); assert.equal(await evaluate("document.querySelector('[data-task-field=goal]').value"),'Draft retained when locating a candidate');
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(() => evaluate("!document.querySelector('dialog.debug-task-editor[open]')"));
    assert.equal(deviceRequests.length,capturedRequests);
    check("keyboard candidate selection navigates the current tree and canvas, closes the modal and retains the unsaved draft on reopen; native Escape still closes");

    report.checkpoint = "two independent runs";
    dialog.showMessageBox = async () => ({response:1}); const runs=[];
    for (let index=0;index<2;index++) {
      await showTools(); await evaluate("document.querySelector('.debug-drawer').open=true; document.querySelector('.debug-drawer .snapshot-actions button').click()");
      await until(async () => (await evaluate("window.electronApi.getDebugSession()"))?.active === true);
      const grant = await evaluate("window.electronApi.getDebugSession()"); await openEditor(); await click('[data-task-action=show-templates]');
      await fill('[data-task-field=template-list]',imported.id); await click('[data-task-action=load]'); await click('[data-task-action=define]');
      await until(async () => Boolean((await evaluate("window.electronApi.getDebugSession()")).task)); await ready('[data-task-field=checkpoint]');
      const task = (await evaluate("window.electronApi.getDebugSession()")).task;
      for (const checkpoint of [task.definition.checkpoints[0].id,'']) {
        await idle(); await fill('[data-task-field=checkpoint]',checkpoint); await click('[data-task-action=check]');
        await until(async () => (await evaluate("window.electronApi.getDebugSession()")).task.checks.some(check => check.checkpointId === (checkpoint || null) && check.status === 'passed'));
      }
      await idle(); await click('[data-task-action=close]'); await cli('stop','--session',grant.id);
      const stopped=await evaluate("window.electronApi.getDebugSession()"); runs.push({sessionId:grant.id,taskId:task.id,reportPath:stopped.reportPath});
    }
    assert.notEqual(runs[0].taskId,runs[1].taskId); report.runs=runs;
    await showTools(); await evaluate("document.querySelector('.debug-drawer').open=true; [...document.querySelectorAll('.debug-drawer .snapshot-actions button')].find(x=>x.textContent==='查看调试记录').click()");
    await ready('.test-report-dialog[open]'); await ready('.debug-task-summary');
    await evaluate("document.querySelector('.debug-task-run-comparison').open=true");
    dialog.showOpenDialog = async () => ({canceled:false,filePaths:[runs[0].reportPath]}); await click('[data-comparison-action=import]'); await ready('[data-comparison-result=same_task]');
    const phases=await evaluate("[...document.querySelectorAll('[data-comparison-phase]')].map(row=>[...row.querySelectorAll('[data-comparison-status]')].map(x=>x.dataset.comparisonStatus))");
    assert.equal(phases.length,2); assert(phases.every(row=>row.length===2 && row.every(status=>status==='passed')));
    await layout('.test-report-dialog','run-comparison',1440,900,'.debug-task-run-comparison summary');
    await layout('.test-report-dialog','run-comparison',960,700,'.debug-task-run-comparison summary');
    await evaluate("document.querySelector('.test-report-live').open=true; document.querySelector('.debug-report-export').open=true");
    await layout('.test-report-dialog','run-comparison-tools-open',960,700,'.debug-task-run-comparison summary');
    await evaluate("document.querySelector('[data-comparison-phase-kind=final]').scrollIntoView({block:'end'})");
    const navigationLayout=await evaluate("(() => {const panel=document.querySelector('.test-report-dialog'),r=panel.getBoundingClientRect(),header=panel.querySelector('.test-report-header').getBoundingClientRect();return {scrollTop:panel.scrollTop,headerVisible:header.top>=r.top && header.bottom<=r.bottom,stepHeight:panel.querySelector('.test-report-layout').getBoundingClientRect().height}})()");
    assert(navigationLayout.scrollTop===0 && navigationLayout.headerVisible && navigationLayout.stepHeight>=120,JSON.stringify(navigationLayout));
    report.combinedTools=navigationLayout;
    await evaluate("document.querySelector('.test-report-live').open=false; document.querySelector('.debug-report-export').open=false");
    check("two real authorized Checker runs with different task UUIDs align the same complete stage definition and show loader-verified results through the comparison IPC");

    report.checkpoint = "comparison source preservation";
    dialog.showOpenDialog = async () => ({canceled:true,filePaths:[]}); await click('[data-comparison-action=import]'); await ready('[data-comparison-state=canceled]');
    assert.equal(await evaluate("document.querySelectorAll('[data-comparison-phase]').length"),2);
    dialog.showOpenDialog = async () => ({canceled:false,filePaths:[invalid]}); await click('[data-comparison-action=import]'); await ready('[data-comparison-state=failed]');
    assert.equal(await evaluate("document.querySelectorAll('[data-comparison-phase]').length"),2);
    await click('[data-comparison-action=close]'); await evaluate("document.querySelector('.debug-report-export').open=true");
    await fill('[data-export-scope]','all'); dialog.showOpenDialog = async () => ({canceled:false,filePaths:[exports]});
    await click('[data-export-action=start]'); await ready('[data-export-state=complete]');
    const destination=join(exports,readdirSync(exports)[0]); const exported=JSON.parse(readFileSync(join(destination,'report.json'),'utf8'));
    assert.equal(exported.session.id,runs[1].sessionId); assert.equal(exported.task.id,runs[1].taskId);
    assert.equal(JSON.parse(readFileSync(join(destination,'manifest.json'),'utf8')).desktop.version,app.getVersion());
    const sourceHash=createHash('sha256').update(readFileSync(runs[1].reportPath)).digest('hex'); report.primarySourceHash=sourceHash;
    dialog.showOpenDialog = async () => ({canceled:false,filePaths:[runs[0].reportPath]});
    await evaluate("[...document.querySelectorAll('.test-report-header button')].find(x=>x.textContent.includes('导入报告')).click()");
    await until(() => evaluate("!document.querySelector('.test-report-import-status') && !document.querySelector('[data-comparison-result]') && !document.querySelector('[data-export-state=complete]')"));
    check("comparison cancel/error keeps the old comparison; primary evidence export keeps its original source, and replacing the primary clears comparison state");
    report.checkpoint = "combined tools and missing evidence";
    const missingDirectory=join(output,'missing-tree-report'); cpSync(destination,missingDirectory,{recursive:true});
    const missing=JSON.parse(readFileSync(join(missingDirectory,'report.json'),'utf8')),tree=missing.snapshots.find(item=>item.tree)?.tree;
    assert(tree); unlinkSync(join(missingDirectory,tree.path));
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[join(missingDirectory,'report.json')]});
    await evaluate("[...document.querySelectorAll('.test-report-header button')].find(x=>x.textContent.includes('导入报告')).click()");
    await ready('.debug-report-read-errors'); await until(()=>evaluate("!document.querySelector('.test-report-import-status')"));
    await evaluate("document.querySelector('.debug-task-run-comparison').open=true");
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[runs[0].reportPath]}); await click('[data-comparison-action=import]'); await ready('[data-comparison-result=same_task]');
    assert.equal(await evaluate("document.querySelector('[data-comparison-summary-status]').dataset.comparisonSummaryStatus"),'insufficient_evidence');
    await evaluate("document.querySelector('.test-report-live').open=true; document.querySelector('.debug-report-export').open=true; document.querySelector('.debug-report-read-errors').open=true");
    await layout('.test-report-dialog','run-comparison-errors-open',960,700,'.debug-task-run-comparison summary');
    await evaluate("document.querySelector('[data-comparison-phase-kind=final]').scrollIntoView({block:'end'}); document.querySelector('[data-comparison-phase-kind=final] summary').focus()");
    await layout('.test-report-dialog','run-comparison-final-errors',960,700);
    assert.equal(await evaluate("document.querySelector('.test-report-dialog').scrollTop"),0);
    check("expanded live tools, export and missing-evidence errors keep header and close controls visible, reserve the step area and scroll comparison internally");
    report.passed=true;
  } catch (error) {
    report.error=String(error);
    report.failureState=await evaluate("({keys:window.__reuseKeys,focus:document.activeElement?.outerHTML,selected:document.querySelector('.tree-row.selected')?.textContent,diagnostic:document.querySelector('.task-editor-final [data-selector-diagnostic]')?.textContent,editorOpen:Boolean(document.querySelector('dialog.debug-task-editor[open]'))})").catch(() => null);
    throw error;
  }
  finally {
    dialog.showOpenDialog=originalOpen; dialog.showSaveDialog=originalSave; dialog.showMessageBox=originalMessage;
    writeFileSync(join(output,'artemis-reuse-result.json'),JSON.stringify(report,null,2)); console.log(`Artemis reuse evidence: ${output}`);
  }
};
