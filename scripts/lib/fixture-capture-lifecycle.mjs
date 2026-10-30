import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function fixtureCaptureLifecycle({ evaluate, until, connection, output, report, recordCheck }) {
  await evaluate(`(() => {
    window.__lifecycleEvents = [];
    window.electronApi.onInspectionProgress(event => window.__lifecycleEvents.push({ kind:'progress', ...event }));
    window.electronApi.onInspectionPreview(event => window.__lifecycleEvents.push({ kind:event.phase, requestId:event.requestId,
      fixtureId:event.snapshot?.root?.attributes?.['fixture-request-id'],
      updates:event.updates?.map(update => ({ id:update.id, empty:update.layerImageEmpty, source:update.imageSource })) }));
  })()`);
  await until(() => evaluate("Boolean(document.querySelector('.capture-button:not([disabled])'))"), "fixture device ready", 5000);
  const capture = () => evaluate("document.querySelector('.capture-button:not([disabled])').click()");
  const firstImage = () => until(() => evaluate("window.__lifecycleEvents.some(event => event.kind === 'layers' && event.updates?.some(update => update.source?.includes('SDK')))"), "fixture image preview", 5000);
  await capture(); await firstImage();
  await until(() => evaluate("Boolean(document.querySelector('.tree-row'))"), "partial tree rendered", 5000);
  await evaluate("document.querySelector('.view-mode-toggle button:nth-child(2)').click()");
  await until(() => evaluate("Number(document.querySelector('.layer-webgl-canvas')?.dataset.layerTextureCount) > 0"), "partial WebGL texture", 2000);
  const shot = async name => { const result = await connection.send("Page.captureScreenshot", { format:"png", captureBeyondViewport:false });
    writeFileSync(join(output, name), Buffer.from(result.data, "base64")); };
  await shot("lifecycle-preview.png");
  const oldId = await evaluate("window.__lifecycleEvents.find(event => event.kind === 'tree').requestId");
  const cancelEventCount = await evaluate("window.__lifecycleEvents.length");
  await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '取消采集').click()");
  await until(() => evaluate("!document.querySelector('.tree-row') && !document.querySelector('.layer-plane') && Boolean(document.querySelector('.capture-button:not([disabled])'))"), "cancel clears tree and scene", 5000);
  recordCheck("cancel clears actual React tree and WebGL scene");
  // Recover immediately, before the old fixture's deliberate delayed disposal finishes.
  await capture();
  await until(() => evaluate(`window.__lifecycleEvents.some(event => event.kind === 'tree' && event.requestId !== ${JSON.stringify(oldId)})`), "recovery new tree", 5000);
  await until(() => evaluate(`window.__lifecycleEvents.some(event => event.kind === 'layers' && event.requestId !== ${JSON.stringify(oldId)} && event.updates?.some(update => update.source?.includes('SDK')))`), "recovery SDK preview", 5000);
  await until(() => evaluate("Boolean(document.querySelector('.capture-button:not([disabled])'))"), "recovery complete", 5000);
  const events = await evaluate("window.__lifecycleEvents");
  const newId = events.find(event => event.kind === "tree" && event.requestId !== oldId).requestId;
  assert.ok(!events.some(event => event.stage?.includes("迟到")), "late fixture progress escaped main-process cancellation gate");
  assert.ok(!events.slice(cancelEventCount).some(event => event.requestId === oldId), "old events reached renderer after cancellation");
  const newTreeIndex = events.findIndex(event => event.kind === "tree" && event.requestId === newId);
  assert.ok(!events.slice(newTreeIndex).some(event => event.requestId === oldId), "old IPC events reached recovery");
  assert.ok(events.filter(event => event.kind === "tree").every(event => event.fixtureId === event.requestId));
  assert.equal(await evaluate(`document.querySelector('.tree-pane').textContent.includes(${JSON.stringify(oldId)})`), false);
  await evaluate(`Array.from(document.querySelectorAll('.tree-row')).find(row => row.textContent.includes(${JSON.stringify(newId)})).click()`);
  await evaluate("document.querySelector('.inspector-image').scrollIntoView({ block:'end', behavior:'instant' })");
  await until(() => evaluate("Array.from(document.querySelectorAll('.inspector-image-note')).some(note => note.textContent.includes('SDK 模拟独立图'))"), "SDK provenance shown", 2000);
  recordCheck("recovery shows only new request and SDK fixture image provenance");
  const emptyId = events.find(event => event.requestId === newId && event.kind === "layers").updates.find(update => update.empty === true).id;
  await evaluate(`document.querySelector('.tree-row[data-tree-id="${emptyId}"]').click()`);
  await evaluate("document.querySelector('.inspector-image').scrollIntoView({ block:'end', behavior:'instant' })");
  await until(() => evaluate("document.querySelector('.inspector-image-state[data-state=captured][data-empty=true]')?.textContent.includes('全透明')"), "transparent captured state", 2000);
  assert.equal(await evaluate(`document.querySelector('.layer-plane[data-layer-node-id="${emptyId}"]')?.dataset.layerTexture`), "false");
  await until(() => evaluate("Number(document.querySelector('.layer-webgl-canvas')?.dataset.layerTextureCount) > 0"), "recovery visible texture retained", 2000);
  const gpu = await evaluate(`(() => {
    const canvas = document.querySelector('.layer-webgl-canvas'), gl = canvas?.getContext('webgl');
    if (!gl || gl.isContextLost()) return null;
    gl.finish(); return { renderVersion: Number(canvas.dataset.layerRenderVersion),
      committed: JSON.parse(canvas.dataset.layerCommittedNativeTextures || '[]') };
  })()`);
  assert.ok(gpu?.renderVersion > 0 && gpu.committed.length > 0, "recovery has no submitted native texture");
  assert.equal(await evaluate("(() => { const rect=document.querySelector('.inspector-image-state').getBoundingClientRect(); return rect.top>=0 && rect.bottom<=innerHeight; })()"), true, "transparent state is outside visible viewport");
  recordCheck("captured transparent image stays outline while visible texture renders");
  report.captureLifecycle = { oldId, newId, emptyId, cancelEventCount, gpu, events, fixtureOnly: true, deviceSdkAcceptance: false };
  await shot("lifecycle-recovery.png");
}
