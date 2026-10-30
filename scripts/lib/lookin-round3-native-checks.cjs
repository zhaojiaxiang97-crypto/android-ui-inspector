const assert = require("node:assert/strict");
const { Menu } = require("electron");
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async function ({ window, evaluate, until, output, dialog, clipboard, item, project, deviceRequests, layerMenuHandler }) {
  const sharp = require("sharp");
  const bitmap = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 45, g: 130, b: 205, alpha: 0.5 } } }).png().toBuffer();
  const screen = await sharp({ create: { width: 360, height: 640, channels: 4, background: { r: 32, g: 38, b: 46, alpha: 1 } } }).png().toBuffer();
  const base = JSON.parse(readFileSync(join(project, "tests/fixtures/debug-handoff-snapshot.json"), "utf8")).root;
  const node = (id, text, bounds, children = []) => ({ ...base, id, index: Number(id.split("/").at(-1)), text,
    className: children.length ? "android.widget.FrameLayout" : "android.widget.TextView", resourceId: `com.example.fixture:id/node_${id.replaceAll("/", "_")}`,
    package: "com.example.fixture", bounds: { left: bounds[0], top: bounds[1], right: bounds[2], bottom: bounds[3], raw: `[${bounds[0]},${bounds[1]}][${bounds[2]},${bounds[3]}]` },
    attributes: {}, children, layerImageDataUrl: `data:image/png;base64,${bitmap.toString("base64")}`, layerImageSize: { width: 32, height: 32 }, layerImageStatus: "captured" });
  const root = node("0", "自有离线测试页面", [0, 0, 360, 640], [
    node("0/0", "分支 A", [10, 10, 170, 300], [node("0/0/0", "匹配控件 A", [20, 20, 150, 60]),
      node("0/0/1", "子容器", [20, 80, 160, 220], [node("0/0/1/0", "深层文字", [30, 90, 140, 130])])]),
    node("0/1", "分支 B", [180, 10, 350, 300], [node("0/1/0", "匹配控件 B", [190, 20, 340, 60]), node("0/1/1", "匹配控件 C", [190, 90, 340, 130])]),
  ]);
  const fixture = join(output, "lookin-round3-snapshot.json");
  writeFileSync(fixture, JSON.stringify({ format: "android-ui-inspector-snapshot", version: 1, exportedAt: "2026-10-13T00:00:00.000Z", snapshot: {
    serial: "local-fixture", root, nodeCount: 8, xmlSize: 0, rawXml: null, screenshotDataUrl: `data:image/png;base64,${screen.toString("base64")}`,
    error: null, warning: "自有离线检查数据", inspectionSource: "debug-view", hierarchyDumpMode: "full", captureMode: "deep",
  } }));
  const report = { passed: false, fixtureOnly: true, actualMainPreloadRenderer: true, phoneOperations: 0, runs: [], fileDialogSubstitute: true, clipboardSubstitute: true };
  const original = { popup: Menu.prototype.popup, open: dialog.showOpenDialog, save: dialog.showSaveDialog, clipboardWrite: clipboard.write };
  let choice = null, held = null, hold = false, zoom = 1, copies = [];
  const popupErrors = [];
  Menu.prototype.popup = function ({ callback }) {
    if (hold) { held = { menu: this, callback }; return; }
    if (choice) {
      const command = this.getMenuItemById(choice);
      if (!command?.enabled) popupErrors.push(`Unavailable native menu action: ${choice}`);
      assert(command?.enabled, `Unavailable native menu action: ${choice}`); command.click();
    }
    callback();
  };
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
  let saved = join(output, "node-own.png");
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: saved });
  clipboard.write = async entries => {
    assert.equal(entries.length, 1); assert(entries[0].types.includes("image/png"));
    const blob = await entries[0].getType("image/png"); copies.push(Buffer.from(await blob.arrayBuffer()));
  };
  const settle = () => evaluate("(async()=>{for(let i=0;i<6;i++)await new Promise(requestAnimationFrame)})()");
  const click = async selector => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); };
  const row = id => `.tree-row[data-tree-id=${JSON.stringify(id)}]`;
  const menu = async (id, action) => {
    choice = action;
    await evaluate(`document.querySelector(${JSON.stringify(row(id))}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
    await settle();
  };
  const setSearch = async value => {
    await evaluate(`(()=>{const el=document.querySelector('.tree-search');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await settle();
  };
  const key = async (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers }); window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers }); await settle();
  };
  const screenshot = async name => writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG());
  try {
    for (const [width, height, scale] of [[1440, 900, 1], [960, 700, 1.25], [1440, 900, 1.5]]) {
      zoom = scale; window.setContentSize(width, height); window.webContents.setZoomFactor(zoom); window.focus(); window.webContents.focus();
      const document = JSON.parse(readFileSync(fixture, "utf8"));
      const title = `自有离线测试页面 · ${scale}`; document.snapshot.root.text = title;
      writeFileSync(fixture, JSON.stringify(document));
      item("open-snapshot").click();
      await until(() => evaluate(`document.querySelectorAll('.tree-row').length===8 && document.querySelector(${JSON.stringify(row("0"))})?.textContent.includes(${JSON.stringify(title)})`));
      await menu("0/0", "hide"); await menu("0/1", "hide");
      await menu("0/0", "restore-selected");
      assert(await evaluate(`!document.querySelector(${JSON.stringify(row("0/0"))}).textContent.includes('已隐藏') && document.querySelector(${JSON.stringify(row("0/1"))}).textContent.includes('已隐藏')`));
      await menu("0/1/0", "locate-hidden-ancestor");
      assert.equal(await evaluate("document.querySelector('.floating-inspector').dataset.nodeId"), "0/1");
      await menu("0/1", "restore-selected");
      await menu("0/0", "collapse-children");
      assert(await evaluate(`document.querySelector(${JSON.stringify(row("0/0"))}).getAttribute('aria-expanded')==='true' && document.querySelector(${JSON.stringify(row("0/0/1"))}).getAttribute('aria-expanded')==='false' && !document.querySelector(${JSON.stringify(row("0/0/1/0"))}) && document.querySelector(${JSON.stringify(row("0/1/1"))})`));
      await menu("0/0", "expand-branch"); await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(row("0/0/1/0"))}))`));
      await setSearch("匹配控件"); await click(".tree-search-next");
      assert.equal(await evaluate("document.querySelector('.floating-inspector').dataset.nodeId"), "0/0/0");
      await click(".tree-search-next"); assert.equal(await evaluate("document.querySelector('.floating-inspector').dataset.nodeId"), "0/1/0");
      assert.equal(await evaluate("document.querySelector('.tree-search-match-position').textContent"), "第 2 个 / 共 3 个");
      await evaluate("document.querySelector('.tree-search').focus()"); await key("G", ["meta", "shift"]);
      assert.equal(await evaluate("document.querySelector('.floating-inspector').dataset.nodeId"), "0/0/0");
      await setSearch("");
      await click(".inspector-close"); assert(await evaluate("document.querySelector('.floating-inspector').hidden"));
      await menu("0/0/0", "preview-image-own");
      await until(() => evaluate("Boolean(document.querySelector('body > .node-image-preview img'))"));
      assert(await evaluate("document.querySelector('.floating-inspector').hidden"));
      await evaluate("document.querySelector('.node-image-preview-viewport').focus()"); await key("1");
      assert.equal(await evaluate("document.querySelector('.node-image-preview-content').dataset.previewMode"), "pixels");
      await screenshot(`round3-preview-${width}-${scale}.png`); await key("Escape");
      await until(() => evaluate("!document.querySelector('.node-image-preview')"));
      assert(await evaluate("document.activeElement?.isConnected"));
      copies = []; await menu("0/0/0", "copy-image-own");
      await until(() => copies.length === 1); assert.equal((await sharp(copies[0]).metadata()).width, 32);
      saved = join(output, `own-${width}-${scale}.png`); await menu("0/0/0", "save-image-own");
      await until(() => existsSync(saved)); assert.equal((await sharp(saved).metadata()).width, 32);
      await click(".node-image-action-feedback button");
      await menu("0/0", "preview-image-branch");
      await until(() => evaluate("Boolean(document.querySelector('.node-image-preview img'))"));
      assert(await evaluate("document.querySelector('.node-image-preview-meta').textContent.includes('本地重建')")); await key("Escape");
      await click(row("0/0/0"));
      await click(".inspector-toggle");
      await click(".inspector-groups-open"); await click("body > .inspector-group-popup .inspector-group-more");
      await until(() => evaluate("document.querySelector('.preferences-panel')?.querySelector('[aria-current=location]')?.textContent.includes('属性与颜色')"));
      await screenshot(`round3-preferences-${width}-${scale}.png`); await click(".entry-dialog-close");
      item("preferences").click();
      await until(() => evaluate("document.querySelector('.preferences-panel')?.querySelector('[aria-current=location]')?.textContent.includes('属性与颜色')"));
      await click(".entry-dialog-close");
      hold = true; held = null; await menu("0/0/0", "copy-image-own"); await until(() => Boolean(held));
      const beforeCopies = copies.length; await click(row("0/1/0"));
      held.menu.getMenuItemById("copy-image-own").click(); held.callback(); held = null; hold = false; await settle();
      assert.equal(copies.length, beforeCopies, "Stale same-root menu copied the former selection");
      await screenshot(`round3-workbench-${width}-${scale}.png`);
      report.runs.push({ width, height, zoom, individualRestore: true, hiddenAncestor: true, branchExpansion: true,
        searchNavigation: true, hiddenInspectorImagePreview: true, imageCopyAndSave: true, branchSource: true, preferenceEntryAndReopen: true, staleMenuSuppressed: true });
    }
    const caller = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    assert.throws(() => layerMenuHandler(caller, false, false, false, { canFocus: false, expandable: false, expanded: false,
      imageScopes: [{ scope: "own", available: true, label: "x", detail: "", extra: "invalid" }] }), /图层菜单参数/);
    assert.equal(deviceRequests.length, 0, "Offline UI operations triggered capture or style reads");
    assert.deepEqual(popupErrors, [], "Native menu checks encountered unexpected IPC failures");
    report.passed = true;
  } catch (error) {
    report.error = String(error); await screenshot("round3-failure.png"); throw error;
  } finally {
    Menu.prototype.popup = original.popup; dialog.showOpenDialog = original.open; dialog.showSaveDialog = original.save; clipboard.write = original.clipboardWrite;
    writeFileSync(join(output, "lookin-round3-result.json"), JSON.stringify(report, null, 2));
    console.log(`Lookin round 3 native evidence: ${output}`);
  }
};
