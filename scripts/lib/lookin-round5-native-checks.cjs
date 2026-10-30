const assert = require("node:assert/strict");
const { Menu } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async function ({ window, evaluate, until, output, dialog, clipboard, item, project, fixtureHandlers, deviceRequests }) {
  const sharp = require("sharp");
  const bitmap = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 25, g: 110, b: 190, alpha: .5 } } }).png().toBuffer();
  const screen = await sharp({ create: { width: 360, height: 640, channels: 4, background: { r: 32, g: 38, b: 46, alpha: 1 } } }).png().toBuffer();
  const base = JSON.parse(readFileSync(join(project, "tests/fixtures/debug-handoff-snapshot.json"), "utf8")).root;
  const make = (id, text, bounds, children = []) => ({ ...base, id, text, children, className: "android.widget.FrameLayout", index: Number(id.split("/").at(-1)),
    attributes: { "view-ref": `View@${id}`, "sdk-longClickable": "false" }, resourceId: `app.fixture:id/node_${id.replaceAll("/", "_")}`,
    bounds: { left: bounds[0], top: bounds[1], right: bounds[2], bottom: bounds[3], raw: `[${bounds[0]},${bounds[1]}][${bounds[2]},${bounds[3]}]` },
    layerImageDataUrl: `data:image/png;base64,${bitmap.toString("base64")}`, layerImageSize: { width: 32, height: 32 }, layerImageStatus: "captured" });
  const target = make("0/0/0", "第五轮控件 A", [20, 20, 150, 60]);
  target.debugMetadata = { version: 1, source: "debug-sdk-explicit", status: "captured", groups: [{ key: "state", label: "状态", fields: [{ key: "count", label: "数量", type: "number", value: 0 }] }] };
  const root = make("0", "第五轮离线样例", [0, 0, 360, 640], [make("0/0", "分支 A", [10, 10, 170, 300], [target]), make("0/1", "控件 B", [190, 20, 340, 60])]);
  Object.assign(root.attributes, { "debug-process-id": "fixture-process", "debug-window-name": "fixture-window" });
  const frame = { width: 360, height: 640, rotation: 0 };
  const snapshot = { serial: "visual-fixture", root, nodeCount: 4, xmlSize: 0, rawXml: null, screenshotDataUrl: `data:image/png;base64,${screen.toString("base64")}`,
    error: null, warning: "自有离线检查数据", inspectionSource: "debug-view", captureMode: "deep", hierarchyDumpMode: "full",
    captureGeometry: { hierarchyRotation: 0, beforeScreenshot: frame, afterScreenshot: frame, screenshotSize: { width: 360, height: 640 } } };
  const fixture = join(output, "lookin-round5-snapshot.json");
  const report = { passed: false, fixtureOnly: true, actualMainPreloadRenderer: true, phoneOperations: 0, captureAndRefreshSubstitutes: true,
    menuSelectionSubstitute: true, fileDialogSubstitute: true, clipboardSubstitute: true, runs: [] };
  const original = { popup: Menu.prototype.popup, open: dialog.showOpenDialog, save: dialog.showSaveDialog, copy: clipboard.write, text: clipboard.writeText };
  let choice = null, lastMenu, zoom = 1, liveRoot, heldRefresh = null;
  const textCopies = [], imageCopies = [], refreshes = [], menuErrors = [];
  Menu.prototype.popup = function ({ callback }) {
    lastMenu = this;
    if (choice) { const action = this.getMenuItemById(choice); if (!action?.enabled) menuErrors.push(choice); assert(action?.enabled, `Unavailable menu action ${choice}`); action.click(); }
    callback();
  };
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
  let savePath = join(output, "preview.png"), cancelSave = false;
  dialog.showSaveDialog = async () => ({ canceled: cancelSave, filePath: cancelSave ? undefined : savePath });
  clipboard.writeText = value => textCopies.push(value);
  clipboard.write = async entries => { assert.equal(entries.length, 1); assert(entries[0].types.includes("image/png")); imageCopies.push(Buffer.from(await (await entries[0].getType("image/png")).arrayBuffer())); };
  fixtureHandlers["inspect-device"] = async () => { liveRoot = structuredClone(root); liveRoot.text = `第五轮在线替身 ${zoom}`; return { ...structuredClone(snapshot), root: liveRoot }; };
  fixtureHandlers["refresh-view-node"] = (_event, requestId, nodeId, scope) => {
    refreshes.push({ requestId, nodeId, scope });
    return new Promise(resolve => { heldRefresh = () => {
      const all = []; const visit = node => { all.push(node); node.children.forEach(visit); }; visit(liveRoot);
      const old = all.find(node => node.id === nodeId); assert(old);
      const updated = { ...structuredClone(old), text: `已刷新 ${nodeId}` };
      resolve(scope === "branch" ? { nodes: [], failures: [], branch: updated } : { nodes: [updated], failures: [] }); heldRefresh = null;
    }; });
  };
  const settle = () => evaluate("(async()=>{for(let i=0;i<6;i++)await new Promise(requestAnimationFrame)})()");
  const click = async selector => { await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing '+${JSON.stringify(selector)});el.focus({preventScroll:true});el.click()})()`); await settle(); };
  const key = async keyCode => { window.webContents.sendInputEvent({ type: "keyDown", keyCode }); window.webContents.sendInputEvent({ type: "keyUp", keyCode }); await settle(); };
  const input = async (selector, value) => { await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus({preventScroll:true});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`); await settle(); };
  const row = id => `.tree-row[data-tree-id=${JSON.stringify(id)}]`;
  const menu = async (id, action = null) => { lastMenu = null; choice = action; await evaluate(`document.querySelector(${JSON.stringify(row(id))}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`); await until(() => Boolean(lastMenu)); await settle(); choice = null; };
  const capture = async name => writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG());
  const readPoint = () => evaluate("(()=>{const v=document.querySelector('.node-image-preview-viewport');return [document.querySelector('.node-image-preview-content').dataset.previewZoom,v.scrollLeft,v.scrollTop]})()");
  try {
    for (const [width, height, scale] of [[1440, 900, 1], [960, 700, 1.25], [1440, 900, 1.5]]) {
      zoom = scale; window.setContentSize(width, height); window.webContents.setZoomFactor(zoom); window.focus(); window.webContents.focus();
      root.text = `第五轮离线样例 ${zoom}`; writeFileSync(fixture, JSON.stringify({ format: "android-ui-inspector-snapshot", version: 2, exportedAt: "2026-10-13T00:00:00.000Z", snapshot }));
      item("open-snapshot").click(); await until(() => evaluate(`document.querySelector(${JSON.stringify(row("0"))})?.textContent.includes(${JSON.stringify(root.text)})`));
      await click(row(target.id)); await click(".view-mode-toggle button:first-child");
      assert(await evaluate("document.querySelector('.screenshot-stage').dataset.coordinateStatus==='checked'"));
      lastMenu = null; choice = "copy-text"; const beforeTextCopy = textCopies.length;
      const point = await evaluate("(()=>{const r=document.querySelector('.screenshot-stage img').getBoundingClientRect();return {x:r.left+r.width*40/360,y:r.top+r.height*40/640}})()");
      const pos = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) };
      window.webContents.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, ...pos }); window.webContents.sendInputEvent({ type: "mouseUp", button: "right", clickCount: 1, ...pos });
      await until(() => lastMenu && textCopies.length === beforeTextCopy + 1 && textCopies.at(-1) === target.text); choice = null;
      assert(!lastMenu.getMenuItemById("hide") && !lastMenu.getMenuItemById("focus"));
      assert.equal(lastMenu.getMenuItemById("refresh-node").enabled, false);
      await capture(`round5-2d-${width}-${zoom}.png`);

      const titleOpen = await evaluate("document.querySelector('.inspector-type').open");
      await click('[aria-label="管理类型分组"]'); assert.equal(await evaluate("document.querySelector('.inspector-type').open"), titleOpen);
      await click("body > .inspector-group-popup .inspector-group-hide");
      assert(await evaluate("document.querySelector('.inspector-type').hidden && document.activeElement===document.querySelector('.inspector-groups-open')"));
      await click(".inspector-groups-open"); await click('body > .inspector-group-popup [aria-label="显示类型"]');
      assert(await evaluate("!document.querySelector('.inspector-type').hidden"));
      await capture(`round5-groups-${width}-${zoom}.png`); await click("body > .inspector-group-popup .inspector-group-reset"); await key("Escape");

      await menu(target.id, "preview-image-own"); await until(() => evaluate("Boolean(document.querySelector('.node-image-preview img'))"));
      await click('.node-image-preview [aria-label="放大预览图片"]'); const reading = await readPoint();
      const beforeCopy = imageCopies.length; await click(".node-image-preview-copy"); await until(() => imageCopies.length === beforeCopy + 1); await until(() => evaluate("!document.querySelector('.node-image-preview-save').disabled"));
      assert.deepEqual(await sharp(imageCopies.at(-1)).ensureAlpha().raw().toBuffer(), await sharp(bitmap).ensureAlpha().raw().toBuffer()); assert.deepEqual(await readPoint(), reading);
      savePath = join(output, `preview-${width}-${zoom}.png`); await click(".node-image-preview-save");
      await until(() => evaluate("document.querySelector('.node-image-preview-output-status').textContent.includes('已保存')"));
      assert.deepEqual(await sharp(readFileSync(savePath)).ensureAlpha().raw().toBuffer(), await sharp(bitmap).ensureAlpha().raw().toBuffer());
      cancelSave = true; await click(".node-image-preview-save"); await until(() => evaluate("!document.querySelector('.node-image-preview-save').disabled")); cancelSave = false;
      assert.deepEqual(await readPoint(), reading); await capture(`round5-preview-${width}-${zoom}.png`); await key("Escape");

      await click(".view-mode-toggle button:last-child"); await click(".layer-settings > summary");
      await input('[aria-label="3D 层间距数值"]', "120"); await key("Enter");
      await input('[aria-label="3D 相机视距数值"]', "1120"); await key("Enter");
      assert(await evaluate("document.querySelector('.screenshot-frame').dataset.cameraPaintLayerGap==='120' && document.querySelector('.screenshot-frame').dataset.cameraPaintDistance==='1120'"));
      await input('[aria-label="3D 层间距数值"]', "121"); await key("Escape");
      assert(await evaluate("Boolean(document.querySelector('body > .layer-settings-body')) && document.querySelector('[aria-label=\"3D 层间距数值\"]').value==='120'"));
      await capture(`round5-camera-${width}-${zoom}.png`); await key("Escape");

      const capturesBefore = deviceRequests.filter(value => value === "inspect-device").length; item("capture").click();
      await until(() => evaluate(`document.querySelector(${JSON.stringify(row("0"))})?.textContent.includes(${JSON.stringify(`第五轮在线替身 ${zoom}`)})`));
      assert.equal(deviceRequests.filter(value => value === "inspect-device").length, capturesBefore + 1);
      for (const [id, action, scope] of [[target.id, "refresh-node", "node"], ["0/0", "refresh-branch", "branch"]]) {
        const count = refreshes.length; lastMenu = null; await menu(id, action); await until(() => Boolean(heldRefresh));
        assert.equal(refreshes.length, count + 1); assert.equal(refreshes.at(-1).nodeId, id); assert.equal(refreshes.at(-1).scope, scope);
        assert(await evaluate("document.querySelector('.view-refresh-feedback').textContent.includes('正在刷新')"));
        heldRefresh(); await until(() => evaluate(`document.querySelector(${JSON.stringify(row(id))})?.textContent.includes(${JSON.stringify(`已刷新 ${id}`)})`));
        await click(".view-refresh-feedback button");
      }
      await capture(`round5-refresh-${width}-${zoom}.png`);
      report.runs.push({ width, height, zoom, flatNativeMenu: true, localGroupsAndFocus: true, previewOriginalPixelsAndReadingPoint: true, exactCameraAndDraftEscape: true, existingNodeAndBranchRefreshIpc: true });
    }
    assert.deepEqual(menuErrors, []); assert(!deviceRequests.some(value => value === "capture-group" || value === "read-view-style"));
    report.refreshRequests = refreshes; report.deviceChannelsWithSubstitutes = deviceRequests; report.originalImageOutputs = imageCopies.length + report.runs.length; report.passed = true;
  } catch (error) { report.error = String(error); await capture("round5-failure.png"); throw error; }
  finally {
    Menu.prototype.popup = original.popup; dialog.showOpenDialog = original.open; dialog.showSaveDialog = original.save; clipboard.write = original.copy; clipboard.writeText = original.text;
    delete fixtureHandlers["inspect-device"]; delete fixtureHandlers["refresh-view-node"];
    writeFileSync(join(output, "lookin-round5-result.json"), JSON.stringify(report, null, 2)); console.log(`Lookin round 5 native evidence: ${output}`);
  }
};
