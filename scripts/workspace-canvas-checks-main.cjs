const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const project = resolve(__dirname, ".."), output = join(project, ".benchmarks", "workspace-canvas");
mkdirSync(output, { recursive: true });
app.setPath("userData", mkdtempSync(join(output, "profile-")));
const deadline = setTimeout(() => { console.error("Workspace canvas checks exceeded 120 seconds"); app.exit(1); }, 120000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, title: "离线布局与缩放验证", width: 1440, height: 900,
    webPreferences: { preload: join(__dirname, "workspace-canvas-checks-preload.cjs"), sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  let zoom = 1;
  const report = { sandbox: true, generatedAt: new Date().toISOString(), runs: [], success: false };
  ipcMain.handle("fixture-native-input", async (event, events) => {
    if (event.sender !== window.webContents) throw new Error("unexpected fixture sender");
    for (const input of events) {
      const next = { ...input };
      if (next.x !== undefined) next.x = Math.round(next.x * zoom);
      if (next.y !== undefined) next.y = Math.round(next.y * zoom);
      window.webContents.sendInputEvent(next);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  });
  ipcMain.handle("fixture-checkpoint", async (event, name) => {
    if (event.sender !== window.webContents || !/^[a-z0-9-]+$/.test(name)) throw new Error("invalid fixture checkpoint");
    const image = await window.webContents.capturePage(); writeFileSync(join(output, `${zoom * 100}-${name}.png`), image.toPNG());
  });
  try {
    await window.loadURL(pathToFileURL(join(project, "benchmarks/workspace-canvas.html")).href); window.webContents.focus();
    for (zoom of [1, 1.25, 1.5]) {
      window.webContents.setZoomFactor(zoom);
      const run = await window.webContents.executeJavaScript("window.verifyWorkspaceCanvas(window.fixtureNative)");
      report.runs.push({ zoom, ...run }); console.log(`Workspace canvas at ${zoom * 100}%: ${run.scenarios.length} groups passed, ${run.deviceRequests} device requests`);
    }
    report.success = true;
  } catch (error) {
    report.error = String(error); console.error(error);
    writeFileSync(join(output, "failure.png"), (await window.webContents.capturePage()).toPNG());
  } finally {
    writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n"); clearTimeout(deadline); app.exit(report.success ? 0 : 1);
  }
}).catch(error => { console.error(error); app.exit(1); });
