const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const project = resolve(__dirname, ".."), base = join(project, ".benchmarks/canvas-controller");
mkdirSync(base, { recursive: true });
const evidence = mkdtempSync(join(base, "run-"));
app.setPath("userData", join(evidence, "profile"));
const deadline = setTimeout(() => { console.error("Canvas controller checks exceeded 180 seconds"); app.exit(1); }, 180_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: {
    preload: join(__dirname, "canvas-round4-checks-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  let run = "", zoom = 1;
  const errors = [], report = { generatedAt: new Date().toISOString(), sandbox: true, passed: false, phoneOperations: 0, results: [], errors };
  window.webContents.on("console-message", details => { if (details.level === "error") errors.push(details.message); });
  ipcMain.handle("canvas-round4-input", async (event, events) => {
    if (event.sender !== window.webContents || !Array.isArray(events) || events.length > 30) throw new Error("Invalid input fixture");
    for (const input of events) {
      if (!input || !["mouseMove", "mouseDown", "mouseUp", "mouseWheel", "keyDown", "keyUp", "char"].includes(input.type)) throw new Error("Unsupported input fixture");
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
    // Three window sizes, with fractional zoom only on the middle size.
    const matrix = process.argv.includes("--quick") ? [[960, 700, 1]] : [[1440, 900, 1], [960, 700, 1], [650, 760, 1], [960, 700, 1.25], [960, 700, 1.5]];
    for (const [width, height, factor] of matrix) {
      zoom = factor; window.setContentSize(width, height); window.webContents.setZoomFactor(zoom); run = `${width}-${height}-${zoom}`;
      await window.webContents.executeJavaScript("document.documentElement.dataset.appearance = 'dark'; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const result = await window.webContents.executeJavaScript("window.verifyCanvasController(window.canvasRound4Native)");
      report.results.push({ width, height, zoom, ...result });
      console.log(run, `${result.checks.filter(item => item.passed).length}/${result.checks.length}`, "checks passed");
      for (const check of result.checks) if (!check.passed) console.error(check.name, check.error);
    }
    report.passed = errors.length === 0 && report.results.every(result => result.passed);
  } catch (error) { report.error = String(error); console.error(error); }
  finally { writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2)); console.log("Canvas controller evidence:", evidence); clearTimeout(deadline); app.exit(report.passed ? 0 : 1); }
});
