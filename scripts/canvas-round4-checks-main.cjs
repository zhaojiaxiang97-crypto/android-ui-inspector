const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const round = process.argv.includes("--round5") ? 5 : 4;
const project = resolve(__dirname, ".."), base = join(project, `.benchmarks/canvas-round${round}`);
mkdirSync(base, { recursive: true }); const evidence = mkdtempSync(join(base, "run-"));
app.setPath("userData", join(evidence, "profile"));
const deadline = setTimeout(() => { console.error(`Canvas round ${round} exceeded 240 seconds`); app.exit(1); }, 240_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: {
    preload: join(__dirname, "canvas-round4-checks-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  const errors = [], report = { generatedAt: new Date().toISOString(), sandbox: true, passed: false, phoneOperations: 0, results: [], errors };
  let run = "", zoom = 1;
  window.webContents.on("console-message", details => { if (details.level === "error") errors.push(details.message); });
  ipcMain.handle("canvas-round4-input", async (event, events) => {
    if (event.sender !== window.webContents || !Array.isArray(events) || events.length > 30) throw new Error("Invalid input fixture");
    for (const input of events) {
      if (!input || !["mouseMove", "mouseDown", "mouseUp", "keyDown", "keyUp", "char"].includes(input.type)) throw new Error("Unsupported input fixture");
      const next = { ...input };
      if (next.x !== undefined) next.x = Math.round(next.x * zoom);
      if (next.y !== undefined) next.y = Math.round(next.y * zoom);
      window.webContents.sendInputEvent(next); await new Promise(resolve => setTimeout(resolve, 20));
    }
  });
  ipcMain.handle("canvas-round4-checkpoint", async (event, name) => {
    if (event.sender !== window.webContents || !/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid checkpoint");
    writeFileSync(join(evidence, `${run}-${name}.png`), (await window.webContents.capturePage()).toPNG());
  });
  try {
    await window.loadURL(pathToFileURL(join(base, "build/index.html")).href); window.webContents.focus();
    for (const [width, height] of [[1440, 900], [960, 700], [650, 760]]) for (zoom of [1, 1.25, 1.5]) for (const theme of ["dark", "light"]) {
      window.setContentSize(width, height); window.webContents.setZoomFactor(zoom); run = `${width}-${height}-${zoom}-${theme}`;
      await window.webContents.executeJavaScript(`document.documentElement.dataset.appearance = ${JSON.stringify(theme)}`);
      await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80))))");
      const result = await window.webContents.executeJavaScript(`window.verifyCanvasRound${round}(window.canvasRound4Native).catch(error => { console.error(error.stack); throw error; })`);
      report.results.push({ width, height, zoom, theme, ...result }); console.log(run, result.checks.length, "groups passed");
    }
    if (errors.length) throw new Error(`Renderer errors: ${errors.join("; ")}`); report.passed = true;
  } catch (error) { report.error = String(error); console.error(error); writeFileSync(join(evidence, "failure.png"), (await window.webContents.capturePage()).toPNG()); }
  finally { writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2)); console.log(`Canvas round ${round} evidence:`, evidence); clearTimeout(deadline); app.exit(report.passed ? 0 : 1); }
});
