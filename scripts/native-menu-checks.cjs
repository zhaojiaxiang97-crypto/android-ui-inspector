// Run after build: node_modules/.bin/electron scripts/native-menu-checks.cjs
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const evidence = require("./lib/packaged-check-evidence.cjs");

if (process.platform !== "darwin") { console.log("Native menu checks require macOS"); app.exit(0); }
else {
  const project = resolve(__dirname, "..");
  const handoff = process.argv.find(value => value.startsWith("--debug-handoff="))?.split("=")[1];
  if (handoff !== undefined && !["current", "installed"].includes(handoff)) throw new Error("debug-handoff requires current or installed");
  const candidateArgs = process.argv.slice(2).filter(value => !value.startsWith("--debug-handoff="));
  const candidateOptions = candidateArgs.length ? evidence.parseArgs(candidateArgs) : null;
  assert(!(candidateOptions && handoff), "Candidate resources and legacy debug-handoff are separate checks");
  const baseOutput = join(project, ".benchmarks", "native-menu");
  mkdirSync(baseOutput, { recursive: true });
  const output = mkdtempSync(join(baseOutput, handoff ? `handoff-${handoff}-` : "workbench-"));
  const resources = candidateOptions?.resources ?? join(project, "release/mac-arm64/Android UI Inspector.app/Contents/Resources");
  const appPath = handoff === "installed" || candidateOptions ? join(resources, "app.asar") : project;
  const resourceIdentity = candidateOptions ? evidence.resourceIdentity(resources) : null;
  if (candidateOptions) assert.equal(resourceIdentity.candidate, candidateOptions.candidate, "Candidate identifier mismatch");
  const packageEvidence = candidateOptions ? { ...candidateOptions, resourceIdentity, coverage: "candidate main/preload/renderer, isolated fixture" } : {};
  app.setAppPath(appPath);
  app.setPath("userData", mkdtempSync(join(output, "profile-")));
  process.argv.push("--visual-fixture");
  if (handoff === "installed" || candidateOptions) {
    // Release excludes test data; supply only these fixtures without altering its JS or assets.
    const fs = require("node:fs");
    const fixtures = new Map(["uiautomator-portrait.xml", "visual-screen.svg"].map(name => {
      const path = join("tests/fixtures", name);
      return [join(appPath, path), join(project, path)];
    }));
    fs.readFileSync = (path, ...args) => readFileSync(fixtures.get(path) ?? path, ...args);
  }
  const deviceRequests = [];
  const registerHandler = ipcMain.handle;
  ipcMain.handle = (channel, handler) => registerHandler.call(ipcMain, channel, (...args) => {
    if (["inspect-device", "capture-group", "refresh-view-node", "read-view-style"].includes(channel)) deviceRequests.push(channel);
    return handler(...args);
  });
  require(join(appPath, "dist-electron/main.cjs"));
  ipcMain.handle = registerHandler;
  let handoffReport;
  let mcpConfigContext;
  let snapshotFileCheck;
  const timeout = setTimeout(() => { console.error("Native menu checks timed out"); app.exit(1); }, 30_000);
  const delay = () => new Promise(resolve => setTimeout(resolve, 40));
  const until = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(); } throw new Error("Native menu state did not settle"); };
  app.whenReady().then(async () => {
    try {
      let window = BrowserWindow.getAllWindows()[0];
      const evaluate = code => window.webContents.executeJavaScript(code);
      const item = id => Menu.getApplicationMenu().getMenuItemById(id);
      await until(() => item("capture")?.enabled);
      await until(() => evaluate("document.querySelector('.native-menu') !== null"));
      assert.equal(await evaluate("document.querySelector('.native-menu') !== null"), true);
      const sharedFile = join(app.getPath("userData"), "mcp", "current.json");
      const cli = async (...args) => {
        const cliPath = handoff === "installed" || candidateOptions ? join(resources, "cli/android-ui.cjs") : join(project, "dist-electron", "cli.cjs");
        const { stdout, stderr } = await promisify(execFile)("node", [cliPath, ...args, "--snapshot-file", sharedFile], { timeout: 20_000 });
        assert.equal(stderr, "");
        return JSON.parse(stdout);
      };
      if (handoff) {
        // Observe each real IPC hop without changing the product or the user's running app.
        handoffReport = { bundle: handoff, appPath, profile: app.getPath("userData"), sent: [], captures: [], passed: false,
          scope: "isolated unpackaged Electron with fixture data; no device IO or installed-app restart" };
        const send = window.webContents.send.bind(window.webContents);
        let lastSnapshotEvent;
        window.webContents.send = (channel, ...args) => {
          if (channel === "debug-session-event") {
            const event = args[0];
            handoffReport.sent.push({ sessionId: event.state.id, active: event.state.active, mode: event.snapshot?.captureMode ?? null,
              nodeCount: event.snapshot?.nodeCount ?? null });
            if (event.snapshot) lastSnapshotEvent = structuredClone(event);
          }
          return send(channel, ...args);
        };
        await evaluate(`(() => {
          window.__debugHandoff = { received: [] };
          window.__debugHandoff.off = window.electronApi.onDebugSession(event => {
            window.__debugHandoff.received.push({ sessionId: event.state.id, active: event.state.active,
              mode: event.snapshot?.captureMode ?? null, nodeCount: event.snapshot?.nodeCount ?? null });
          });
        })()`);
        assert.equal(await evaluate("window.electronApi.runtime.fixtureMode"), true);
        assert.equal(await evaluate("Boolean(document.querySelector('.inspection-active'))"), false);
        const showMessageBox = dialog.showMessageBox;
        dialog.showMessageBox = async (_window, options) => {
          assert.ok(options.message.includes("com.example.sanitized"));
          return { response: 1 };
        };
        try {
          await evaluate("document.querySelector('.debug-drawer').open = true; document.querySelector('.debug-drawer .snapshot-actions button').click()");
          await until(() => existsSync(`${sharedFile}.live`));
          const state = await cli("attach");
          assert.equal(state.active, true);
          for (const source of [null, {}, "__proto__", "untrusted reason"]) {
            assert.equal(await evaluate(`window.electronApi.stopMcpSharing(${JSON.stringify(source)}).then(() => false, () => true)`), true);
          }
          assert.equal((await cli("attach")).active, true, "invalid stop source must not revoke authorization");
          for (const mode of ["fast", "deep"]) {
            handoffReport.checkpoint = `${mode}: capture`;
            const captured = await cli("capture", "--session", state.id, "--mode", mode);
            const published = JSON.parse(readFileSync(sharedFile, "utf8"));
            assert.equal(captured.snapshotId, published.id);
            assert.equal(published.snapshot.serial, "visual-fixture");
            handoffReport.checkpoint = `${mode}: session send`;
            assert.ok(handoffReport.sent.some(event => event.sessionId === state.id && event.mode === mode && event.nodeCount === captured.nodeCount), "snapshot was not sent from the session");
            handoffReport.checkpoint = `${mode}: preload receive`;
            await until(() => evaluate(`window.__debugHandoff.received.some(event => event.sessionId === ${JSON.stringify(state.id)} && event.mode === ${JSON.stringify(mode)} && event.nodeCount === ${captured.nodeCount})`));
            handoffReport.checkpoint = `${mode}: workspace display`;
            await until(() => evaluate(`Boolean(document.querySelector('.inspection-active .tree-row')) && document.querySelector('.snapshot-summary')?.textContent.includes('${captured.nodeCount} nodes')`));
            assert.equal(await evaluate("Boolean(document.querySelector('.tree-row.selected')) && Boolean(document.querySelector('.floating-inspector'))"), true);
            if (mode === "fast") assert.equal(await evaluate("document.querySelector('.view-mode-toggle button:last-child').disabled"), true);
            else {
              await evaluate("document.querySelector('.view-mode-toggle button:last-child').click()");
              await until(() => evaluate("document.querySelector('.layer-webgl-canvas')?.dataset.layerRenderer === 'webgl' && Number(document.querySelector('.layer-scene')?.dataset.layerCount) > 0"));
            }
            assert.equal((await cli("attach")).active, true, "showing a snapshot revoked the live session");
            handoffReport.captures.push({ mode, snapshotId: captured.snapshotId, nodeCount: captured.nodeCount, published: true, sent: true, received: true, displayed: true });
            writeFileSync(join(output, `${mode}.png`), (await window.webContents.capturePage()).toPNG());
          }
          // Replay the sanitized failure-shaped tree through real IPC, not a mocked hook.
          handoffReport.checkpoint = "sanitized replay: receive/display";
          const replay = JSON.parse(readFileSync(join(project, "tests/fixtures/debug-handoff-snapshot.json"), "utf8"));
          replay.serial = state.serial;
          const target = replay.root.children.length ? replay.root.children[0] : replay.root;
          const replayBefore = await evaluate("window.__debugHandoff.received.length");
          send("debug-session-event", { state, snapshot: replay, selectedNodeId: target.id });
          await until(() => evaluate(`window.__debugHandoff.received.length > ${replayBefore} && document.querySelector('.snapshot-summary')?.textContent.includes('70 nodes')`));
          assert.equal(await evaluate("Boolean(document.querySelector('.inspection-active .tree-row.selected')) && Boolean(document.querySelector('.floating-inspector'))"), true);
          handoffReport.sanitizedReplayDisplayed = true;
          handoffReport.checkpoint = "stop/home: late snapshot";
          await cli("stop", "--session", state.id);
          await until(() => evaluate("!document.querySelector('.debug-stop')"));
          assert.equal((await evaluate("window.electronApi.getDebugSession()")).stopReason, "CLI / MCP 请求停止自动调试");
          assert.equal(await evaluate("document.querySelector('.debug-drawer').textContent.includes('CLI / MCP 请求停止自动调试')"), true);
          assert.equal(existsSync(sharedFile), false); assert.equal(existsSync(`${sharedFile}.live`), false);
          item("home").click();
          await until(() => evaluate("!document.querySelector('.inspection-active')"));
          const beforeLate = await evaluate("window.__debugHandoff.received.length");
          send("debug-session-event", lastSnapshotEvent);
          await until(() => evaluate(`window.__debugHandoff.received.length > ${beforeLate}`));
          await delay();
          handoffReport.lateSnapshotRejected = !await evaluate("Boolean(document.querySelector('.inspection-active')) || Boolean(document.querySelector('.debug-stop'))");
          handoffReport.authoritativeSessionActive = (await evaluate("window.electronApi.getDebugSession()")).active;
          assert.equal(handoffReport.authoritativeSessionActive, false);
          assert.equal(handoffReport.lateSnapshotRejected, true, "late stopped-session event restored the workspace");
          handoffReport.received = await evaluate("window.__debugHandoff.received");
          handoffReport.passed = true;
          writeFileSync(join(output, "result.json"), JSON.stringify(handoffReport, null, 2));
          console.log(`Debug handoff checks passed (${handoff}); report: ${join(output, "result.json")}`);
        } finally {
          dialog.showMessageBox = showMessageBox;
          handoffReport.received = await evaluate("window.__debugHandoff.received");
          await evaluate("void window.__debugHandoff.off()");
        }
        clearTimeout(timeout); app.exit(0); return;
      }
      assert.equal(item("preferences").accelerator, "CmdOrCtrl+,");
      item("preferences").click();
      await until(() => evaluate("document.querySelector('.preferences-panel')?.open === true"));
      writeFileSync(join(output, "preferences-home.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate("document.querySelector('.entry-dialog-close').click()");
      await until(() => evaluate("!document.querySelector('.preferences-panel')"));
      const initialMenu = { devices: [{ serial: "visual-fixture", model: "Fixture", state: "device" }], selectedSerial: "visual-fixture",
        loading: false, capturing: false, inspecting: false, hasSnapshot: false, filtered: false, canCapture: false };
      await evaluate(`window.electronApi.updateAppMenu(${JSON.stringify(initialMenu)})`);
      assert.equal(item("capture").enabled, false, "failed connection may leave a device but must disable capture");
      for (const field of ["canCapture", "canSelectDevice", "hasRawXml", "hasScreenshot", "historyLoading"])
        assert.equal(await evaluate(`window.electronApi.updateAppMenu(${JSON.stringify({ ...initialMenu, [field]: "invalid" })}).then(() => false, () => true)`), true);
      await evaluate(`window.electronApi.updateAppMenu(${JSON.stringify({ ...initialMenu, canCapture: true })})`);
      item("capture").click();
      await until(() => evaluate("document.querySelector('.tree-row') !== null"));
      await until(() => item("expand-all")?.enabled);
      const saveDialog = dialog.showSaveDialog, exported = [];
      dialog.showSaveDialog = async (_window, options) => { exported.push(options.defaultPath); return { canceled: true, filePath: undefined }; };
      try {
        for (const format of ["json", "xml", "png"]) {
          assert.equal(item(`export-${format}`).enabled, true);
          assert.equal(item(`export-${format}`).label, `导出 ${format.toUpperCase()}`);
          item(`export-${format}`).click();
          await until(() => exported.length === ["json", "xml", "png"].indexOf(format) + 1);
          assert.ok(exported.at(-1).endsWith(`.${format}`));
        }
      } finally { dialog.showSaveDialog = saveDialog; }
      writeFileSync(join(output, "export-actions.json"), JSON.stringify({ canceled: true, filesWritten: 0, formats: ["json", "xml", "png"] }, null, 2));
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
        const appDescriptor = Object.getOwnPropertyDescriptor(app, "isPackaged");
        const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
        try {
          if (candidateOptions) {
            // The fixture gate has already run in an unpackaged test process.
            // Only this real config IPC observes the packaged paths; restore them
            // before any further menu/capture checks. Product bytes stay intact.
            assert.equal(app.isPackaged, false);
            assert.ok(appDescriptor?.configurable && resourcesDescriptor?.configurable);
            Object.defineProperty(app, "isPackaged", { ...appDescriptor, get: () => true });
            Object.defineProperty(process, "resourcesPath", { ...resourcesDescriptor, value: resources });
            mcpConfigContext = { simulatedPackagedPaths: true, fixtureGateUnchanged: true, actualConfigIpc: true, restored: false };
          }
          item("mcp-config").click();
          await until(() => copiedConfig.includes("mcpServers"));
          const config = JSON.parse(copiedConfig).mcpServers["android-ui-inspector"];
          assert.equal(config.command, "node");
          if (candidateOptions) assert.equal(config.args[0], join(resources, "mcp/server.cjs"));
          assert.ok(existsSync(config.args[0]));
          assert.equal(config.env.ANDROID_UI_INSPECTOR_MCP_SNAPSHOT, sharedFile);
        } finally {
          if (mcpConfigContext) {
            Object.defineProperty(app, "isPackaged", appDescriptor);
            Object.defineProperty(process, "resourcesPath", resourcesDescriptor);
            mcpConfigContext.restored = app.isPackaged === false && process.resourcesPath === resourcesDescriptor.value;
            assert.equal(mcpConfigContext.restored, true);
          }
          clipboard.writeText = writeText;
        }
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
        await evaluate("document.querySelector('.workbench-utilities > summary').click(); document.querySelector('.debug-drawer > summary').click()");
        await delay(); await delay();
        const liveLayout = await evaluate(`(() => {
          const panel = document.querySelector('.debug-drawer .snapshot-drawer-body').getBoundingClientRect();
          const stop = document.querySelector('.debug-stop').getBoundingClientRect();
          const inViewport = box => box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
          const top = document.elementFromPoint(panel.left + 20, panel.top + 12);
          const stopElement = document.querySelector('.debug-stop');
          const stopHit = document.elementFromPoint(stop.left + stop.width / 2, stop.top + stop.height / 2);
          return { panelFits: inViewport(panel), stopFits: inViewport(stop), panelClickable: Boolean(top?.closest('.debug-drawer')),
            stopDirect: stopElement.parentElement === document.querySelector('.scene-toolbar-host'), stopClickable: stopElement.contains(stopHit),
            topElement: top?.outerHTML.slice(0, 240) };
        })()`);
        assert.ok(liveLayout.panelFits && liveLayout.stopFits && liveLayout.panelClickable && liveLayout.stopDirect && liveLayout.stopClickable, JSON.stringify(liveLayout));
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
      assert.equal(await evaluate("Boolean(document.querySelector('.topbar .inspector-toolbar'))"), false);
      assert.equal(await evaluate("document.querySelector('.inspection-header').offsetHeight >= 48"), true);
      assert.equal(await evaluate("Boolean(document.querySelector('.tree-pane > .subpanel-heading'))"), false);
      // Keep the real IPC/menu construction; choose popup commands without OS clicks.
      const popup = Menu.prototype.popup;
      let choice = "focus", expectedExit = false;
      Menu.prototype.popup = function ({ callback }) {
        for (const [contextId, appId] of [["focus", "focus-layer"], ["focus-branch", "focus-branch"], ["exit-focus", "exit-focus"], ["expand", "expand-selected"], ["collapse", "collapse-selected"], ["hide", "hide-selected"], ["restore", "restore-layers"]])
          assert.equal(this.getMenuItemById(contextId).label, item(appId).label, "context and native action labels differ");
        assert.equal(this.getMenuItemById("focus").label, "仅看此层");
        assert.equal(this.getMenuItemById("focus-branch").label, "聚焦分支");
        assert.equal(this.getMenuItemById("exit-focus").enabled, expectedExit);
        this.getMenuItemById(choice).click(); callback();
      };
      try {
        assert.equal(await evaluate("window.electronApi.showLayerMenu(true, false, false)"), "focus");
        choice = "exit-focus"; expectedExit = true;
        assert.equal(await evaluate("window.electronApi.showLayerMenu(false, false, true)"), "exit-focus");
        assert.equal(await evaluate("window.electronApi.showLayerMenu(true, false, 'invalid').then(() => false, () => true)"), true);
        assert.equal(await evaluate("window.electronApi.showLayerMenu(true, false, false, { canFocus: true, expandable: true, expanded: 'invalid' }).then(() => false, () => true)"), true);
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
          const inspector = document.querySelector('.floating-inspector'), frameBox = frame.getBoundingClientRect(), inspectorBox = inspector.getBoundingClientRect();
          // This scenario keeps the expanded inspector docked. Use its real bounds,
          // independently of the renderer's viewport metadata, to locate clear space.
          const clearWidth = inspectorBox.left - frameBox.left - frame.clientLeft - 8;
          const pivotX = Number(scene.dataset.layerPivotX), pivotY = Number(scene.dataset.layerPivotY);
          return { toolbarFits: document.querySelector('.scene-toolbar-host').parentElement === document.querySelector('.inspection-header') && toolbar.left >= 0 && toolbar.right <= innerWidth && toolbar.bottom <= preview.top, actionsFit: actions.every(box => box.height <= 30), overflow: document.documentElement.scrollWidth - innerWidth,
            inspectorDocked: inspector.classList.contains('is-docked') && !inspector.classList.contains('is-collapsed') && !inspector.hidden,
            focusCentered: Math.abs(pivotX - clearWidth / 2) < 1 && Math.abs(pivotY - frame.clientHeight / 2) < 1,
            focusVisible: pivotX > 0 && pivotX < clearWidth && pivotY > 0 && pivotY < frame.clientHeight,
            viewportSized: Math.abs(canvas.clientWidth - frame.clientWidth) < 1 && Math.abs(canvas.clientHeight - frame.clientHeight) < 1 };
        })()`);
        assert.ok(geometry.toolbarFits && geometry.actionsFit && geometry.overflow <= 1 && geometry.inspectorDocked && geometry.focusCentered && geometry.focusVisible && geometry.viewportSized, JSON.stringify(geometry));
        writeFileSync(join(output, `focus-${width}.png`), (await window.webContents.capturePage()).toPNG());
      }
      await evaluate("document.querySelector('.exit-layer-focus').click()");
      await until(() => evaluate("document.querySelector('.layer-scene').dataset.layerCount !== '1'"));
      await evaluate("document.querySelector('.tree-row[aria-expanded=true]').click()");
      await until(() => item("focus-branch").enabled && item("collapse-selected").enabled);
      item("focus-branch").click();
      await until(() => evaluate("document.querySelector('.layer-scene').dataset.layerFocusKind === 'branch' && Boolean(document.querySelector('.tree-focus-bar'))"));
      item("collapse-selected").click();
      await until(() => evaluate("document.querySelector('.layer-scene').dataset.layerCount === '1'"));
      await until(() => item("expand-selected").enabled);
      item("expand-selected").click();
      await until(() => evaluate("Number(document.querySelector('.layer-scene').dataset.layerCount) > 1"));
      item("exit-focus").click();
      await until(() => evaluate("!document.querySelector('.tree-focus-bar')"));
      item("double-click-focus-branch").click();
      await until(() => item("double-click-focus-branch").checked);
      assert.equal(await evaluate("document.querySelector('[aria-label=双击行为]').value"), "focus-branch");
      item("double-click-toggle").click();
      await until(() => item("double-click-toggle").checked);
      assert.equal(await evaluate("window.electronApi.updateAppMenu({ devices: [], selectedSerial: '', loading: false, capturing: false, inspecting: true, hasSnapshot: true, filtered: false, doubleClickAction: 'invalid' }).then(() => false, () => true)"), true);
      item("home").click();
      await until(() => evaluate("!document.querySelector('.inspection-active')"));
      await until(() => !existsSync(sharedFile));
      // Home-origin authorization uses the same renderer listener as the workbench.
      // Exercise the visible start button (including cancellation), not just direct IPC.
      dialog.showMessageBox = async () => ({ response: 0 });
      try {
        await evaluate("document.querySelector('.debug-drawer').open = true; document.querySelector('.debug-drawer .snapshot-actions button').click()");
        await until(() => evaluate("document.querySelector('.debug-drawer .snapshot-actions button').textContent.includes('开启自动调试') && !document.querySelector('.debug-drawer .snapshot-actions button').disabled"));
        assert.equal(existsSync(`${sharedFile}.live`), false);
        dialog.showMessageBox = async () => ({ response: 1 });
        item("debug-start").click();
        await until(() => existsSync(`${sharedFile}.live`));
        await until(() => evaluate("Boolean(document.querySelector('.debug-home-controls .debug-stop'))"));
        const state = await cli("attach");
        await cli("capture", "--session", state.id, "--mode", "fast");
        await until(() => evaluate("Boolean(document.querySelector('.inspection-active .tree-row'))"));
        await until(() => evaluate("Boolean(document.querySelector('.scene-toolbar-host .debug-stop')) && document.querySelector('.debug-step-list').textContent.includes('capture_ui')"));
        assert.equal((await evaluate("window.electronApi.getDebugSession()")).active, true);
        await cli("stop", "--session", state.id);
        await until(() => evaluate("!document.querySelector('.debug-stop')"));
        assert.equal(existsSync(sharedFile), false); assert.equal(existsSync(`${sharedFile}.live`), false);
        item("home").click();
        await until(() => evaluate("!document.querySelector('.inspection-active')"));
      } finally { dialog.showMessageBox = showMessageBox; }
      if (item("open-snapshot")) {
        const sharp = require("sharp");
        const source = await evaluate("window.electronApi.inspectDevice('visual-fixture', 'snapshot-file-fixture')");
        const png = await sharp(Buffer.from(source.screenshotDataUrl.split(",")[1], "base64")).png().toBuffer();
        const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
        const snapshot = { ...source, screenshotDataUrl: dataUrl, inspectionSource: "debug-hybrid", captureMode: "deep",
          root: { ...source.root, attributes: { ...source.root.attributes, "tree-source": "debug-sdk" } },
          layerGroupImages: [{ nodeId: source.root.id, image: { dataUrl, size: { width: 1080, height: 2400 }, capturedAt: "2026-10-11T00:00:00.000Z" } }] };
        const file = join(output, "portable-snapshot.json"), roundtrip = join(output, "roundtrip-snapshot.json"), invalid = join(output, "invalid-snapshot.json");
        const document = { format: "android-ui-inspector-snapshot", version: 1, exportedAt: "2026-10-11T01:00:00.000Z", snapshot };
        writeFileSync(file, JSON.stringify(document)); writeFileSync(invalid, JSON.stringify({ ...document, version: 2 }));
        const openDialog = dialog.showOpenDialog, fullSaveDialog = dialog.showSaveDialog;
        let choice = file;
        const beforeDeviceRequests = deviceRequests.length;
        try {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [choice] });
          item("open-snapshot").click();
          await until(() => evaluate("document.querySelector('.snapshot-file-status')?.textContent.includes('正在查看离线快照')"));
          await until(() => item("export-snapshot")?.enabled);
          dialog.showSaveDialog = async () => ({ canceled: false, filePath: roundtrip });
          item("export-snapshot").click();
          await until(async () => existsSync(roundtrip) && await evaluate("document.querySelector('.snapshot-file-status')?.textContent.includes('已保存：')"));
          assert.deepEqual(JSON.parse(readFileSync(roundtrip, "utf8")).snapshot, snapshot);
          await until(() => evaluate("document.querySelector('.view-mode-toggle button:last-child')?.disabled === false"));
          await evaluate("document.querySelector('.view-mode-toggle button:last-child').click()");
          await until(() => evaluate("Boolean(document.querySelector('.layer-scene'))"));
          item("collapse-all").click();
          await until(() => evaluate("document.querySelector('.layer-scene')?.dataset.layerRootComposite === 'true' && document.querySelector('.layer-resource-note')?.textContent.includes('已保存')"));
          writeFileSync(join(output, "offline-snapshot.png"), (await window.webContents.capturePage()).toPNG());
          item("save").click();
          await until(() => evaluate("window.electronApi.loadSnapshots().then(result => result.snapshots.some(entry => entry.snapshot.layerGroupImages?.length === 1))"));
          choice = invalid;
          item("open-snapshot").click();
          await until(() => evaluate("document.querySelector('.snapshot-file-status[role=alert]')?.textContent.includes('版本')"));
          assert.equal(await evaluate("document.querySelector('.layer-scene')?.dataset.layerRootComposite"), "true");
          window.close();
          await until(() => window.isDestroyed());
          app.emit("activate");
          await until(() => BrowserWindow.getAllWindows().length === 1);
          window = BrowserWindow.getAllWindows()[0];
          await until(() => evaluate("Boolean(document.querySelector('.snapshot-history-item'))"));
          await evaluate("document.querySelector('.snapshot-history-item').click()");
          await until(() => evaluate("document.querySelector('.view-mode-toggle button:last-child')?.disabled === false"));
          await evaluate("document.querySelector('.view-mode-toggle button:last-child').click()");
          await until(() => item("collapse-all")?.enabled);
          item("collapse-all").click();
          await until(() => evaluate("document.querySelector('.layer-scene')?.dataset.layerRootComposite === 'true' && document.querySelector('.layer-resource-note')?.textContent.includes('已保存')"));
          assert.equal(deviceRequests.length, beforeDeviceRequests, "offline import/export/history reopen made device requests");
          snapshotFileCheck = { passed: true, version: 1, actualMainPreloadRenderer: true, nativeGroupPreserved: true, windowReopenPassed: true, deviceRequests: 0, fixtureOnly: true };
          writeFileSync(join(output, "snapshot-files.json"), JSON.stringify(snapshotFileCheck, null, 2));
          item("home").click();
          await until(() => evaluate("!document.querySelector('.inspection-active')"));
        } finally { dialog.showOpenDialog = openDialog; dialog.showSaveDialog = fullSaveDialog; }
      } else assert.ok(candidateOptions, "current source must expose offline snapshot commands");
      writeFileSync(join(output, "home.png"), (await window.webContents.capturePage()).toPNG());
      if (candidateOptions) evidence.verifyUnchanged(resourceIdentity, resources);
      writeFileSync(join(output, "result.json"), JSON.stringify({ ...packageEvidence, mcpConfigContext, snapshotFileCheck, resourcesUnchanged: Boolean(candidateOptions), passed: true, output, fixtureOnly: true, installedAcceptance: false, phoneOperations: 0,
        checks: ["actual menu IPC and enablement", "distinct branch/single-layer focus", "selected expand/collapse and exit", "shared double-click preference", "invalid menu state/options rejected", "existing authorization/cancellation/stop", "1440/960 layout", "native preferences and shared action labels", "export JSON/XML/PNG through renderer/preload/main without writing", "failed connection capture guard and new state validation"] }, null, 2));
      console.log(`Native menu evidence: ${output}`);
      console.log("Native menu checks passed: commands, focus/exit popup, MCP approval/config/revocation, live authorization/capture/2D/logs/stop/pending-approval revocation, home-origin cancel/start/capture/logs/stop, validation, device/busy state, full-height canvas, 1440/960 layouts");
      clearTimeout(timeout); app.exit(0);
    } catch (error) {
      if (!handoffReport) writeFileSync(join(output, "result.json"), JSON.stringify({ ...packageEvidence, mcpConfigContext, passed: false, output, fixtureOnly: true, installedAcceptance: false, phoneOperations: 0, error: String(error) }, null, 2));
      if (handoffReport) {
        handoffReport.passed = false;
        handoffReport.error = error.message;
        writeFileSync(join(output, "result.json"), JSON.stringify(handoffReport, null, 2));
        console.error(`Debug handoff failed; report: ${join(output, "result.json")}`);
      }
      console.error(error); clearTimeout(timeout); app.exit(1);
    }
  });
}
