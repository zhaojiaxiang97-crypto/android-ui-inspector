const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const project = resolve(__dirname, ".."), base = join(project, ".benchmarks/scene-runtime");
mkdirSync(base, { recursive: true }); const evidence = mkdtempSync(join(base, "run-"));
app.setPath("userData", join(evidence, "profile"));
const deadline = setTimeout(() => { console.error("Scene runtime checks exceeded 150 seconds"); app.exit(1); }, 150_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 960, height: 800, webPreferences: {
    preload: join(__dirname, "canvas-round4-checks-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  const errors = [], report = { generatedAt: new Date().toISOString(), sandbox: true, phoneOperations: 0, passed: false, errors };
  window.webContents.on("console-message", details => { if (details.level === "error") errors.push(details.message); });
  ipcMain.handle("canvas-round4-checkpoint", async (event, name) => {
    if (event.sender !== window.webContents || !/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid checkpoint");
    writeFileSync(join(evidence, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  });
  try {
    await window.loadURL(pathToFileURL(join(base, "build/index.html")).href);
    const result = await window.webContents.executeJavaScript("window.verifySceneRuntime(window.canvasRound4Native)"); Object.assign(report, result);
    report.passed = result.passed && errors.length === 0;
    for (const item of result.checks) console.log(item.name, item.passed ? "PASS" : item.error);
  } catch (error) { report.error = String(error); console.error(error); }
  finally { writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2)); console.log("Scene runtime evidence:", evidence); clearTimeout(deadline); app.exit(report.passed ? 0 : 1); }
});
