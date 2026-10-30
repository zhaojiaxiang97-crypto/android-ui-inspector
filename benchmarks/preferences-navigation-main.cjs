const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const project = resolve(__dirname, ".."), base = join(project, ".benchmarks/preferences-navigation");
mkdirSync(base, { recursive: true });
const evidence = mkdtempSync(join(base, "run-"));
app.setPath("userData", join(evidence, "profile")); app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 180_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 960, height: 700, webPreferences: {
    preload: join(project, "benchmarks/preferences-navigation-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  const errors = [], results = []; let run = "";
  window.webContents.on("console-message", details => { if (details.level === "error") errors.push(details.message); });
  ipcMain.handle("preferences-test-key", async (event, key) => {
    if (event.sender !== window.webContents || !["Return", "Escape"].includes(key)) throw new Error("Unsupported fixture key");
    const keyCode = key === "Return" ? "Enter" : key;
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    if (key === "Return") window.webContents.sendInputEvent({ type: "char", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await new Promise(resolve => setTimeout(resolve, 40));
  });
  ipcMain.handle("preferences-test-checkpoint", async (event, name) => {
    if (event.sender !== window.webContents || !["preferences-help", "preferences-properties"].includes(name)) throw new Error("Unsupported fixture checkpoint");
    writeFileSync(join(evidence, `${run}-${name}.png`), (await window.webContents.capturePage()).toPNG());
  });
  try {
    await window.loadURL(pathToFileURL(join(base, "build/index.html")).href);
    window.webContents.focus();
    const inspectionMode = await window.webContents.executeJavaScript("window.verifyInspectionModeSettings()");
    results.push({ inspectionMode }); console.log("Inspection mode:", inspectionMode.checks.length, "checks passed");
    for (const [width, height] of [[1440, 900], [960, 700], [650, 760]]) for (const zoom of [1, 1.25, 1.5]) for (const theme of ["dark", "light"]) {
      window.setContentSize(width, height); window.webContents.setZoomFactor(zoom);
      await window.webContents.executeJavaScript(`document.documentElement.dataset.appearance = ${JSON.stringify(theme)}`);
      run = `${width}-${height}-${zoom}-${theme}`;
      const result = await window.webContents.executeJavaScript("window.verifyPreferencesNavigation(window.preferencesTest.key, window.preferencesTest.checkpoint)");
      results.push({ width, height, zoom, theme, ...result }); console.log(run, result.checks.length, "checks passed");
    }
    if (errors.length) throw new Error(`Renderer errors: ${errors.join("; ")}`);
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: true, sandbox: true, phoneOperations: 0, errors, results }, null, 2));
    console.log("Preferences evidence:", evidence); clearTimeout(deadline); app.exit(0);
  } catch (error) {
    console.error(error); writeFileSync(join(evidence, "failure.png"), (await window.webContents.capturePage()).toPNG());
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: false, errors, error: String(error), results }, null, 2)); clearTimeout(deadline); app.exit(1);
  }
});
