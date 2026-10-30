const assert = require("node:assert/strict");
const { Menu } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async function ({ window, evaluate, until, output, dialog, clipboard, item, project, deviceRequests }) {
  const sharp = require("sharp");
  const bitmap = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 45, g: 130, b: 205, alpha: 0.5 } } }).png().toBuffer();
  const screen = await sharp({ create: { width: 360, height: 640, channels: 4, background: { r: 32, g: 38, b: 46, alpha: 1 } } }).png().toBuffer();
  const base = JSON.parse(readFileSync(join(project, "tests/fixtures/debug-handoff-snapshot.json"), "utf8")).root;
  const node = (id, text, rect, children = []) => ({ ...base, id, index: Number(id.split("/").at(-1)), text,
    className: children.length ? "android.widget.FrameLayout" : "android.widget.TextView", resourceId: `com.example.fixture:id/node_${id.replaceAll("/", "_")}`,
    package: "com.example.fixture", bounds: { left: rect[0], top: rect[1], right: rect[2], bottom: rect[3], raw: `[${rect[0]},${rect[1]}][${rect[2]},${rect[3]}]` },
    attributes: {}, children, layerImageDataUrl: `data:image/png;base64,${bitmap.toString("base64")}`, layerImageSize: { width: 32, height: 32 }, layerImageStatus: "captured" });
  const target = node("0/0/0", "阅读控件 A", [20, 20, 150, 60]);
  const otherTarget = node("0/1/0", "阅读控件 B", [190, 20, 340, 60]);
  otherTarget.attributes = Object.fromEntries(Array.from({ length: 42 }, (_, index) => [`property-${index}`, `round4-match-B-${index}`]));
  const rawColor = "  rgba(18, 52, 86, 0.1)  ";
  target.attributes = { "inspection-source": "debug-qml", "background-color": rawColor,
    ...Object.fromEntries(Array.from({ length: 42 }, (_, index) => [`property-${index}`, `round4-match-${index}`])) };
  const tree = [{ key: "parent", label: "父项", type: "string", value: "  父项原值  ", children: [
    { key: "zero", label: "零值", type: "number", value: 0, children: [] },
    { key: "false", label: "布尔值", type: "boolean", value: false, children: [] },
    { key: "null", label: "空值", type: "null", value: null, children: [] },
    { key: "empty", label: "空字符串", type: "string", value: "", children: [] },
    { key: "long", label: "长说明", type: "string", value: "  阅读细节\n第二行与Unicode Ω  ", children: [] },
  ] }];
  target.debugMetadata = { version: 2, source: "debug-sdk-explicit", status: "captured",
    groups: [{ key: "state", label: "页面状态", fields: [{ key: "detail", label: "阅读详情", type: "tree", value: tree }] }] };
  const root = node("0", "第四轮自有离线页面", [0, 0, 360, 640], [
    node("0/0", "分支 A", [10, 10, 170, 300], [target,
      node("0/0/1", "子容器", [20, 80, 160, 220], [node("0/0/1/0", "深层文字", [30, 90, 140, 130])])]),
    node("0/1", "分支 B", [180, 10, 350, 300], [otherTarget, node("0/1/1", "阅读控件 C", [190, 90, 340, 130])]),
  ]);
  const fixture = join(output, "lookin-round4-snapshot.json");
  const fixtureDocument = { format: "android-ui-inspector-snapshot", version: 2, exportedAt: "2026-10-13T00:00:00.000Z", snapshot: {
    serial: "local-fixture", root, nodeCount: 8, xmlSize: 0, rawXml: null, screenshotDataUrl: `data:image/png;base64,${screen.toString("base64")}`,
    error: null, warning: "自有离线检查数据", inspectionSource: "debug-qml", hierarchyDumpMode: "full", captureMode: "deep",
  } };
  const report = { passed: false, fixtureOnly: true, actualMainPreloadRenderer: true, phoneOperations: 0,
    nativeMenuSelectionSubstitute: true, fileDialogSubstitute: true, clipboardSubstitute: true, runs: [] };
  const original = { popup: Menu.prototype.popup, open: dialog.showOpenDialog, copy: clipboard.writeText };
  let choice = null;
  const copies = [], menuErrors = [];
  Menu.prototype.popup = function ({ callback }) {
    if (choice) {
      const action = this.getMenuItemById(choice);
      if (!action?.enabled) menuErrors.push(choice);
      assert(action?.enabled, `Unavailable native action ${choice}`); action.click();
    }
    callback();
  };
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
  clipboard.writeText = value => copies.push(value);
  const settle = () => evaluate("(async()=>{for(let i=0;i<6;i++)await new Promise(requestAnimationFrame)})()");
  const click = async selector => { await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing UI '+${JSON.stringify(selector)});el.focus({preventScroll:true});el.click()})()`); await settle(); };
  const row = id => `.tree-row[data-tree-id=${JSON.stringify(id)}]`;
  const selected = () => evaluate("document.querySelector('.floating-inspector').dataset.nodeId");
  const menu = async (id, action) => {
    choice = action;
    await evaluate(`document.querySelector(${JSON.stringify(row(id))}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
    await settle();
  };
  const input = async (selector, value) => {
    await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`); await settle();
  };
  const key = async keyCode => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode }); window.webContents.sendInputEvent({ type: "keyUp", keyCode }); await settle();
  };
  const screenshot = async name => writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG());
  const camera = () => evaluate("(()=>{const d=document.querySelector('.screenshot-frame').dataset;return [d.cameraPaintAzimuth,d.cameraPaintElevation,d.cameraPaintRoll,document.querySelector('.layer-scene').style.transform]})()");
  const settingsSelect = 'body > .layer-settings-body [aria-label="3D 显示内容"]';
  try {
    for (const [width, height, zoom] of [[1440, 900, 1], [960, 700, 1.25], [1440, 900, 1.5]]) {
      window.setContentSize(width, height); window.webContents.setZoomFactor(zoom); window.focus(); window.webContents.focus();
      const title = `第四轮自有离线页面 · ${zoom}`; fixtureDocument.snapshot.root.text = title;
      writeFileSync(fixture, JSON.stringify(fixtureDocument)); item("open-snapshot").click();
      await until(() => evaluate(`document.querySelectorAll('.tree-row').length===8 && document.querySelector(${JSON.stringify(row("0"))})?.textContent.includes(${JSON.stringify(title)})`));
      await click(row(target.id)); await click(".view-mode-toggle button:last-child");
      await until(() => evaluate("document.querySelector('.layer-webgl-canvas')?.dataset.layerRenderer==='webgl'"));
      const originalCamera = await camera(), originalSelection = await selected();
      assert(originalCamera.slice(0, 3).every(value => typeof value === "string" && Number.isFinite(Number(value))), "Missing painted camera angles");
      await click(".zoom-continuous > summary");
      assert(await evaluate("document.querySelectorAll('body > .canvas-tool-popup').length===1 && Boolean(document.querySelector('body > .zoom-continuous-popup'))"));
      await click(".layer-settings > summary");
      assert(await evaluate("document.querySelectorAll('body > .canvas-tool-popup').length===1 && !document.querySelector('body > .zoom-continuous-popup') && Boolean(document.querySelector('body > .layer-settings-body'))"));
      await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(settingsSelect)});el.value='wireframe';el.dispatchEvent(new Event('change',{bubbles:true}))})()`); await settle();
      assert(await evaluate("document.querySelector('.layer-scene').dataset.layerDisplayMode==='wireframe' && document.querySelector('.layer-webgl-canvas').dataset.layerDisplayMode==='wireframe'"));
      assert.deepEqual(await camera(), originalCamera); assert.equal(await selected(), originalSelection);
      await screenshot(`round4-wireframe-${width}-${zoom}.png`);
      await click(".canvas-help > summary");
      assert(await evaluate("!document.querySelector('body > .layer-settings-body') && Boolean(document.querySelector('body > .canvas-help-body'))"));
      await key("Escape");
      assert(await evaluate("!document.querySelector('body > .canvas-tool-popup') && document.activeElement===document.querySelector('.canvas-help > summary')"));
      await click(".layer-settings > summary"); item("preferences").click();
      await until(() => evaluate("Boolean(document.querySelector('.preferences-panel[open]'))"));
      assert(await evaluate("!document.querySelector('body > .canvas-tool-popup')")); await key("Escape");
      await until(() => evaluate("!document.querySelector('.preferences-panel')"));
      await click(".layer-settings > summary");
      await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(settingsSelect)});el.value='images';el.dispatchEvent(new Event('change',{bubbles:true}))})()`); await settle();
      await key("Escape"); assert(await evaluate("document.querySelector('.layer-scene').dataset.layerDisplayMode==='images'"));

      await menu("0/0", "hide"); await menu("0/1", "hide");
      await click(".hidden-layers-toggle");
      assert(await evaluate("document.querySelectorAll('body > .hidden-layers-popup .hidden-layer-item').length===2"));
      await screenshot(`round4-hidden-${width}-${zoom}.png`);
      const selectionBeforeRestore = await selected();
      await click('.hidden-layer-item[data-node-id="0/0"] .hidden-layer-restore');
      assert.equal(await selected(), selectionBeforeRestore);
      assert(await evaluate("document.querySelectorAll('body > .hidden-layers-popup .hidden-layer-item').length===1"));
      await input(".tree-search", "does-not-match");
      await click('.hidden-layer-item[data-node-id="0/1"] .hidden-layer-locate');
      assert.equal(await selected(), "0/1");
      assert(await evaluate("!document.querySelector('.hidden-layers-popup') && document.querySelector('.tree-search').value===''"));
      await menu("0/1", "restore-selected"); await click(row(target.id));

      await input('.inspector-search input', "round4-match");
      assert(await evaluate("document.querySelector('.inspector-search-results > p').textContent==='第 1–30 项，共 42 项'"));
      await click(".inspector-search-pages button:last-child");
      assert(await evaluate("document.querySelector('.inspector-search-results > p').textContent==='第 31–42 项，共 42 项' && document.querySelectorAll('.inspector-search-result').length===12"));
      await screenshot(`round4-search-${width}-${zoom}.png`);
      await evaluate("(()=>{const el=[...document.querySelectorAll('.inspector-search-result')].find(el=>el.querySelector('strong').textContent==='property-41');if(!el)throw new Error('Missing last match');el.parentElement.querySelector('.inspector-search-result-copy').click();el.click()})()"); await settle();
      assert.equal(copies.at(-1), "round4-match-41");
      assert(await evaluate("document.querySelector('.inspector-property-highlight')?.querySelector('dt')?.textContent==='property-41'"));
      await input('.inspector-search input', "property-0");
      assert(await evaluate("document.querySelector('.inspector-search-results > p').textContent==='第 1–1 项，共 1 项' && !document.querySelector('.inspector-search-pages')"));
      await input('.inspector-search input', "");
      await evaluate("document.querySelector('[aria-label=\"展开阅读页面状态·阅读详情\"]').scrollIntoView({block:'nearest'})"); await settle();
      await click('[aria-label="展开阅读页面状态·阅读详情"]');
      await until(() => evaluate("Boolean(document.querySelector('body > dialog.debug-metadata-reader[open]'))"));
      assert(await evaluate("document.querySelector('body > dialog.debug-metadata-reader').textContent.includes('阅读控件 A') && document.querySelector('body > dialog.debug-metadata-reader').textContent.includes('Debug SDK')"));
      await evaluate("(()=>{const el=[...document.querySelectorAll('body > dialog.debug-metadata-reader button')].find(el=>el.textContent==='复制完整分层原值');if(!el)throw new Error('Missing full copy');el.click()})()"); await settle();
      assert.deepEqual(JSON.parse(copies.at(-1)), tree);
      await input('[aria-label="搜索分层信息"]', "空字符串");
      assert(await evaluate("document.querySelector('body > dialog.debug-metadata-reader').textContent.includes('空字符串')"));
      await screenshot(`round4-reader-${width}-${zoom}.png`); await key("Escape");
      assert(await evaluate("!document.querySelector('body > dialog.debug-metadata-reader') && document.activeElement?.getAttribute('aria-label')==='展开阅读页面状态·阅读详情'"));
      await input('.inspector-search input', rawColor.trim());
      await evaluate("document.querySelector('.inspector-color-property[data-color-label=\"背景源色\"] button.inspector-color-swatch').scrollIntoView({block:'nearest'})"); await settle();
      await click('.inspector-color-property[data-color-label="背景源色"] button.inspector-color-swatch');
      await until(() => evaluate("Boolean(document.querySelector('body > .inspector-color-copy-menu'))"));
      assert(await evaluate("document.querySelectorAll('body > .inspector-color-copy-menu [role=menuitem]').length===3"));
      await screenshot(`round4-color-${width}-${zoom}.png`);
      await evaluate("(()=>{const el=[...document.querySelectorAll('body > .inspector-color-copy-menu [role=menuitem]')].find(el=>el.textContent.includes('复制 原值'));if(!el)throw new Error('Missing raw color');el.click()})()"); await settle();
      assert.equal(copies.at(-1), rawColor);
      await click('.inspector-color-property[data-color-label="背景源色"] button.inspector-color-swatch');
      await click(row("0/1/0"));
      assert(await evaluate("!document.querySelector('body > .inspector-color-copy-menu') && !document.querySelector('.inspector-search-result') && document.querySelector('.inspector-search-results > p').textContent==='匹配 0 项' && !document.querySelector('.inspector-property-highlight')"));
      assert.equal(await selected(), otherTarget.id);
      await click(row(target.id)); await input('.inspector-search input', "round4-match");
      await click(".inspector-search-pages button:last-child");
      await click(row(otherTarget.id));
      assert(await evaluate("document.querySelector('.inspector-search input').value==='round4-match' && document.querySelector('.inspector-search-results > p').textContent==='第 1–30 项，共 42 项' && !document.querySelector('.inspector-property-highlight')"));
      await click(".inspector-search-result-copy");
      assert.equal(copies.at(-1), "round4-match-B-0");
      report.runs.push({ width, height, zoom, toolsExclusiveAndModalClose: true, wireframePreservesCameraAndSelection: true,
        hiddenListRestoreAndLocate: true, completeSearchPages: true, propertyCopyAndLocate: true, queryAndNodeReset: true,
        independentTypedReaderAndFocus: true, exactColorCopyAndSourceReset: true });
    }
    assert.equal(deviceRequests.length, 0, "Offline UI requested device reads"); assert.deepEqual(menuErrors, []);
    report.passed = true;
  } catch (error) {
    report.error = String(error); await screenshot("round4-failure.png"); throw error;
  } finally {
    Menu.prototype.popup = original.popup; dialog.showOpenDialog = original.open; clipboard.writeText = original.copy;
    writeFileSync(join(output, "lookin-round4-result.json"), JSON.stringify(report, null, 2));
    console.log(`Lookin round 4 native evidence: ${output}`);
  }
};
