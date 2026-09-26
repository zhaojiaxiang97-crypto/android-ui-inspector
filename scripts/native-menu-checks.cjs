// Run after build: node_modules/.bin/electron scripts/native-menu-checks.cjs
const { app, BrowserWindow, Menu, clipboard, dialog } = require("electron");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

if (process.platform !== "darwin") { console.log("Native menu checks require macOS"); app.exit(0); }
else {
  const project = resolve(__dirname, "..");
  const output = join(project, ".benchmarks", "native-menu");
  mkdirSync(output, { recursive: true });
  app.setAppPath(project);
  app.setPath("userData", mkdtempSync(join(output, "profile-")));
  process.argv.push("--visual-fixture");
  require("../dist-electron/main.cjs");
  const timeout = setTimeout(() => { console.error("Native menu checks timed out"); app.exit(1); }, 30_000);
  const delay = () => new Promise(resolve => setTimeout(resolve, 40));
  const until = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(); } throw new Error("Native menu state did not settle"); };
  app.whenReady().then(async () => {
    try {
      const window = BrowserWindow.getAllWindows()[0];
      const evaluate = code => window.webContents.executeJavaScript(code);
      const item = id => Menu.getApplicationMenu().getMenuItemById(id);
      await until(() => item("capture")?.enabled);
      assert.equal(await evaluate("document.querySelector('.native-menu') !== null"), true);
      item("capture").click();
      await until(() => evaluate("document.querySelector('.tree-row') !== null"));
      await until(() => item("expand-all")?.enabled);
      const sharedFile = join(app.getPath("userData"), "mcp", "current.json");
      const cli = async (...args) => {
        const { stdout, stderr } = await promisify(execFile)("node", [join(project, "dist-electron", "cli.cjs"), ...args, "--snapshot-file", sharedFile], { timeout: 20_000 });
        assert.equal(stderr, "");
        return JSON.parse(stdout);
      };
      assert.equal(existsSync(sharedFile), false);
      assert.equal(item("mcp-stop").enabled, false);
      const showMessageBox = dialog.showMessageBox;
      let shareResponse = 0;
      dialog.showMessageBox = async (_window, options) => {
        assert.equal(options.defaultId, 0);
        assert.ok(options.detail.includes("云端 AI") && options.detail.includes("隐藏"));
        return { response: shareResponse };
      };
      try {
        assert.equal(await evaluate("window.electronApi.shareMcpSnapshot({}, null).then(() => false, () => true)"), true);
        item("mcp-share").click(); await delay(); await delay();
        assert.equal(existsSync(sharedFile), false); // cancelled: no file and no implicit share
        shareResponse = 1;
        item("mcp-share").click();
        await until(() => item("mcp-stop").enabled);
        assert.equal(JSON.parse(readFileSync(sharedFile, "utf8")).snapshot.serial, "visual-fixture");
        assert.equal((await cli("doctor")).shared.ready, true);
        assert.equal((await cli("snapshot")).serial, "visual-fixture");
        assert.equal((await cli("tree", "--depth", "0")).items.length, 1);
        assert.ok(await evaluate("document.querySelector('.scene-toolbar-host').textContent.includes('MCP 已共享')"));
        const writeText = clipboard.writeText;
        let copiedConfig = "";
        clipboard.writeText = async value => { copiedConfig = value; };
        try {
          item("mcp-config").click();
          await until(() => copiedConfig.includes("mcpServers"));
          const config = JSON.parse(copiedConfig).mcpServers["android-ui-inspector"];
          assert.equal(config.command, "node");
          assert.ok(existsSync(config.args[0]));
          assert.equal(config.env.ANDROID_UI_INSPECTOR_MCP_SNAPSHOT, sharedFile);
        } finally { clipboard.writeText = writeText; }
        item("mcp-stop").click();
        await until(() => !item("mcp-stop").enabled);
        assert.equal(existsSync(sharedFile), false);
        // Revocation wins if it occurs while the approval dialog is still open.
        let approve;
        dialog.showMessageBox = () => new Promise(resolve => { approve = resolve; });
        item("mcp-share").click();
        await until(() => Boolean(approve));
        await evaluate("window.electronApi.stopMcpSharing()");
        approve({ response: 1 }); await delay(); await delay();
        assert.equal(existsSync(sharedFile), false);
        dialog.showMessageBox = async () => ({ response: 1 });
        item("mcp-share").click();
        await until(() => item("mcp-stop").enabled);
      } finally { dialog.showMessageBox = showMessageBox; }
      // Exercise live authorization, UI synchronization and stop with the actual desktop bridge.
      item("mcp-stop").click();
      await until(() => !existsSync(sharedFile));
      dialog.showMessageBox = async (_window, options) => {
        assert.equal(options.defaultId, 0);
        assert.ok(options.detail.includes("30 分钟") && options.message.includes("com.example.sanitized"));
        return { response: 0 };
      };
      try {
        assert.equal(await evaluate("window.electronApi.startDebugSession('visual-fixture')"), null);
        assert.equal(existsSync(`${sharedFile}.live`), false);
        dialog.showMessageBox = async () => ({ response: 1 });
        item("debug-start").click();
        await until(() => existsSync(`${sharedFile}.live`));
        const endpoint = JSON.parse(readFileSync(`${sharedFile}.live`, "utf8"));
        const live = async (name, input) => {
          const response = await fetch(`http://127.0.0.1:${endpoint.port}/`, {
            method: "POST", headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name, input }),
          });
          assert.equal(response.status, 200); return response.json();
        };
        const state = await live("get_debug_session", {});
        assert.equal(state.active, true);
        assert.equal((await cli("attach")).id, state.id);
        await until(() => evaluate("Boolean(document.querySelector('.debug-stop'))"));
        const fresh = await cli("capture", "--session", state.id, "--mode", "fast");
        assert.ok(fresh.snapshotId);
        await until(() => evaluate("document.querySelector('.view-mode-toggle button:last-child')?.disabled === true"));
        assert.equal((await evaluate("window.electronApi.getDebugSession()" )).active, true); // renderer snapshot update must not revoke
        await until(() => evaluate("document.querySelector('.debug-step-list').textContent.includes('capture_ui')"));
        assert.equal(await evaluate("document.querySelector('.debug-drawer').textContent.includes('MCP 已共享这一份快照')"), false);
        window.setContentSize(960, 700); await delay(); await delay();
        await evaluate("document.querySelector('.debug-drawer').open = true");
        await delay(); await delay();
        const liveLayout = await evaluate(`(() => {
          const panel = document.querySelector('.debug-drawer .snapshot-drawer-body').getBoundingClientRect();
          const stop = document.querySelector('.debug-stop').getBoundingClientRect();
          const inViewport = box => box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
          const top = document.elementFromPoint(panel.left + 20, panel.top + 12);
          return { panelFits: inViewport(panel), stopFits: inViewport(stop), panelClickable: Boolean(top?.closest('.debug-drawer')), topElement: top?.outerHTML.slice(0, 240) };
        })()`);
        assert.ok(liveLayout.panelFits && liveLayout.stopFits && liveLayout.panelClickable, JSON.stringify(liveLayout));
        writeFileSync(join(output, "automation-960.png"), (await window.webContents.capturePage()).toPNG());
        const returned = await cli("back", "--session", state.id, "--snapshot", fresh.snapshotId);
        assert.equal(returned.dispatchState, "sent");
        assert.notEqual(returned.snapshotId, fresh.snapshotId);
        await until(() => evaluate("document.querySelector('.debug-step-list').textContent.includes('press_back')"));
        await evaluate("document.querySelector('.debug-stop').click()");
        await until(() => !existsSync(`${sharedFile}.live`) && !existsSync(sharedFile));
        await until(() => evaluate("!document.querySelector('.debug-stop')"));
        assert.equal((await evaluate("window.electronApi.getDebugSession()" )).active, false);
        // Returning home while confirmation is pending must win over the later approval.
        let approve;
        dialog.showMessageBox = () => new Promise(resolve => { approve = resolve; });
        item("debug-start").click();
        await until(() => Boolean(approve));
        item("home").click();
        await until(() => evaluate("!document.querySelector('.inspection-active')"));
        approve({ response: 1 }); await delay(); await delay();
        assert.equal(existsSync(`${sharedFile}.live`), false);
        item("capture").click();
        await until(() => evaluate("document.querySelector('.tree-row') !== null"));
      } finally { dialog.showMessageBox = showMessageBox; }
      item("collapse-all").click();
      await until(() => evaluate("document.querySelectorAll('.tree-row').length === 1"));
      item("expand-all").click();
      await until(() => evaluate("document.querySelectorAll('.tree-row').length > 1"));
      item("search").click();
      await until(() => evaluate("document.activeElement === document.querySelector('.tree-search')"));
      assert.equal(await evaluate("document.querySelector('.topbar .inspector-toolbar').getClientRects().length"), 0);
      assert.equal(await evaluate("document.querySelector('.topbar').offsetHeight"), 0);
      assert.equal(await evaluate("Boolean(document.querySelector('.tree-pane > .subpanel-heading'))"), false);
      // Keep the real IPC/menu construction; choose popup commands without OS clicks.
      const popup = Menu.prototype.popup;
      let choice = "focus", expectedExit = false;
      Menu.prototype.popup = function ({ callback }) {
        assert.equal(this.getMenuItemById("focus").label, "聚焦此控件");
        assert.equal(this.getMenuItemById("exit-focus").enabled, expectedExit);
        this.getMenuItemById(choice).click(); callback();
      };
      try {
        assert.equal(await evaluate("window.electronApi.showLayerMenu(true, false, false)"), "focus");
        choice = "exit-focus"; expectedExit = true;
        assert.equal(await evaluate("window.electronApi.showLayerMenu(false, false, true)"), "exit-focus");
        assert.equal(await evaluate("window.electronApi.showLayerMenu(true, false, 'invalid').then(() => false, () => true)"), true);
        choice = "focus"; expectedExit = false;
        await evaluate("document.querySelector('.view-mode-toggle button:last-child').click()");
        await until(() => evaluate("document.querySelector('.layer-webgl-canvas')?.dataset.layerRenderer === 'webgl' && Boolean(document.querySelector('.layer-plane'))"));
        await evaluate("document.querySelector('.layer-plane').click()"); await delay();
        await evaluate("document.querySelector('.screenshot-frame').dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }))");
        await until(() => evaluate("Boolean(document.querySelector('.exit-layer-focus')) && document.querySelector('.layer-scene').dataset.layerCount === '1'"));
      } finally { Menu.prototype.popup = popup; }
      // Exercise validation and the actual Electron menu, not just renderer mocks.
      assert.equal(await evaluate("window.electronApi.updateAppMenu({ devices: 'invalid' }).then(() => false, () => true)"), true);
      const state = { devices: [{ serial: "visual-fixture", model: "Fixture Pixel", state: "device" }, { serial: "locked", model: "Locked", state: "unauthorized" }], selectedSerial: "visual-fixture", loading: false, capturing: true, inspecting: true, hasSnapshot: false, filtered: false };
      await evaluate(`window.electronApi.updateAppMenu(${JSON.stringify(state)})`);
      assert.equal(item("capture").enabled, false);
      assert.equal(item("cancel").enabled, true);
      const deviceMenu = Menu.getApplicationMenu().items.find(menu => menu.label === "设备").submenu.items;
      assert.equal(deviceMenu.find(device => device.label.includes("Locked")).enabled, false);
      assert.equal(deviceMenu.find(device => device.label.includes("Fixture Pixel")).checked, true);
      item("refresh").click();
      await until(() => item("capture").enabled);
      for (const [width, height] of [[1440, 960], [960, 700]]) {
        window.setContentSize(width, height);
        await delay(); await delay();
        const geometry = await evaluate(`(() => {
          const toolbar = document.querySelector('.scene-toolbar-host').getBoundingClientRect();
          const preview = document.querySelector('.preview-pane').getBoundingClientRect();
          const actions = [...document.querySelectorAll('.tree-toolbar button')].map(button => button.getBoundingClientRect());
          const scene = document.querySelector('.layer-scene'), canvas = document.querySelector('.layer-webgl-canvas'), frame = document.querySelector('.screenshot-frame');
          return { toolbarFits: toolbar.left >= preview.left && toolbar.right <= innerWidth, actionsFit: actions.every(box => box.height <= 30), overflow: document.documentElement.scrollWidth - innerWidth, focusCentered: Math.abs(Number(scene.dataset.layerPivotX) - canvas.clientWidth / 2) < 1 && Math.abs(Number(scene.dataset.layerPivotY) - canvas.clientHeight / 2) < 1, viewportSized: Math.abs(canvas.clientWidth - frame.clientWidth) < 1 && Math.abs(canvas.clientHeight - frame.clientHeight) < 1 };
        })()`);
        assert.ok(geometry.toolbarFits && geometry.actionsFit && geometry.overflow <= 1 && geometry.focusCentered && geometry.viewportSized, JSON.stringify(geometry));
        writeFileSync(join(output, `focus-${width}.png`), (await window.webContents.capturePage()).toPNG());
      }
      await evaluate("document.querySelector('.exit-layer-focus').click()");
      await until(() => evaluate("document.querySelector('.layer-scene').dataset.layerCount !== '1'"));
      item("home").click();
      await until(() => evaluate("!document.querySelector('.inspection-active')"));
      await until(() => !existsSync(sharedFile));
      writeFileSync(join(output, "home.png"), (await window.webContents.capturePage()).toPNG());
      console.log("Native menu checks passed: commands, focus/exit popup, MCP approval/config/revocation, live authorization/capture/2D/logs/stop/pending-approval revocation, validation, device/busy state, full-height canvas, 1440/960 layouts");
      clearTimeout(timeout); app.exit(0);
    } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
  });
}
