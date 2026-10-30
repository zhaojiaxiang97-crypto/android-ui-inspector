import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** One ordinary UI baseline, first-image cancellation, recovery; no navigation/restarts. */
export async function desktopDeviceLifecycle({ evaluate, until, connection, output, report, recordCheck }) {
  await evaluate(`(() => {
    window.__deviceLifecycle={events:[],cancelNext:false};
    window.electronApi.onInspectionProgress(event=>window.__deviceLifecycle.events.push({kind:'progress',...event}));
    window.electronApi.onInspectionPreview(event=>{
      const state=window.__deviceLifecycle;
      state.events.push({kind:event.phase,requestId:event.requestId,at:performance.now(),
        nodeCount:event.snapshot?.nodeCount,pid:event.snapshot?.root?.attributes?.['debug-process-id'],
        updates:event.updates?.filter(update=>update.layerImageDataUrl).map(update=>({id:update.id,empty:update.layerImageEmpty,source:update.imageSource}))});
      if(state.cancelNext && event.phase==='layers' && event.updates?.some(update=>update.layerImageDataUrl)) {
        const button=Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='取消采集');
        if(!button) throw new Error('No UI cancel button at first image');
        state.cancelNext=false; state.cancelledId=event.requestId; state.cancelledAt=performance.now(); button.click();
      }
    });
  })()`);
  const capture = () => evaluate("document.querySelector('.capture-button:not([disabled])').click()");
  const completed = async label => {
    await until(() => evaluate("Boolean(document.querySelector('.capture-button:not([disabled])'))"), label, 30000);
    const error = await evaluate("document.querySelector('.error-placeholder p')?.textContent || document.querySelector('.snapshot-warning-message')?.textContent || null");
    assert.equal(error, null, error || "capture failed");
    assert.ok(await evaluate("document.querySelectorAll('.tree-row').length > 0"), "complete capture lost tree");
  };
  await until(() => evaluate("Boolean(document.querySelector('.capture-button:not([disabled])'))"), "device selection", 5000);
  await capture(); await completed("ordinary packaged baseline");
  const baseline = await evaluate("window.__deviceLifecycle.events");
  const baselineId = baseline.find(event => event.kind === "tree")?.requestId;
  assert.ok(baselineId && baseline.some(event => event.kind === "layers" && event.updates?.some(update => update.source?.includes("SDK"))), "default baseline has no SDK independent-image provenance");
  assert.ok(!baseline.some(event => /DDMS.*抓图/.test(event.stage || "")), "default UI fell back to DDMS images");
  recordCheck("packaged ordinary UI capture delivers actual SDK independent images");
  await evaluate("window.__deviceLifecycle.cancelNext=true"); await capture();
  await until(() => evaluate("Boolean(window.__deviceLifecycle.cancelledId) && !document.querySelector('.tree-row') && !document.querySelector('.layer-plane') && Boolean(document.querySelector('.capture-button:not([disabled])'))"), "first image UI cancel clears scene", 30000);
  const cancelledId = await evaluate("window.__deviceLifecycle.cancelledId");
  const cancelledCount = await evaluate("window.__deviceLifecycle.events.length");
  await capture(); await completed("packaged same-process UI recovery");
  const events = await evaluate("window.__deviceLifecycle.events");
  assert.ok(!events.slice(cancelledCount).some(event => event.requestId === cancelledId), "cancelled events reached recovery UI");
  const recoveryId = events.filter(event => event.kind === "tree" && event.requestId !== baselineId && event.requestId !== cancelledId).pop()?.requestId;
  assert.ok(recoveryId && recoveryId !== baselineId);
  const recovery = events.filter(event => event.requestId === recoveryId);
  assert.ok(recovery.some(event => event.updates?.some(update => update.source?.includes("SDK"))));
  assert.ok(!events.some(event => /DDMS.*抓图/.test(event.stage || "")));
  const pids = new Set(events.filter(event => event.pid).map(event => event.pid)); assert.equal(pids.size, 1);
  await evaluate("document.querySelector('.view-mode-toggle button:nth-child(2)').click()");
  await until(() => evaluate("Number(document.querySelector('.layer-webgl-canvas')?.dataset.layerTextureCount)>0"), "recovered native texture submission", 5000);
  const gpu = await evaluate("(() => {const canvas=document.querySelector('.layer-webgl-canvas'),gl=canvas?.getContext('webgl');if(!gl||gl.isContextLost())return null;gl.finish();return {version:Number(canvas.dataset.layerRenderVersion),committed:JSON.parse(canvas.dataset.layerCommittedNativeTextures||'[]').length};})()");
  assert.ok(gpu?.version > 0 && gpu.committed > 0);
  recordCheck("actual packaged UI cancels first image, recovers and submits native textures");
  report.deviceLifecycle = { baselineId, cancelledId, recoveryId, gpu, events, defaultEntry: true, performanceAcceptance: false };
  const screenshot = await connection.send("Page.captureScreenshot", {format:"png",captureBeyondViewport:false});
  writeFileSync(join(output,"device-lifecycle-recovery.png"),Buffer.from(screenshot.data,"base64"));
}
