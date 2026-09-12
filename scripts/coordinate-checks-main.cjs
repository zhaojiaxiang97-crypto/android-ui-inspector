const { app, BrowserWindow } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const project = resolve(__dirname, ".."), output = join(project, ".benchmarks");
mkdirSync(output, { recursive: true });
app.setPath("userData", mkdtempSync(join(output, "coordinates-profile-")));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error("Coordinate checks exceeded 120 seconds"); app.exit(1); }, 120000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1280, height: 880, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.on("render-process-gone", (_event, details) => { console.error(details); app.exit(1); });
  const report = { generatedAt: new Date().toISOString(), sandbox: true, electron: process.versions.electron, chrome: process.versions.chrome, scope: "Actual ScreenshotPreview + production CSS, synthetic PNG/XML-equivalent nodes, fractional pointer-up events and layout assertions. Electron page zoom, not OS DPI or physical-device rotation.", runs: [], success: false };
  try {
    await window.loadURL(pathToFileURL(join(project, "benchmarks/coordinates.html")).href);
    for (const zoom of [1, 1.25, 1.5]) {
      window.webContents.setZoomFactor(zoom);
      const result = await window.webContents.executeJavaScript("window.verifyCoordinates()");
      report.runs.push({ zoom, ...result });
      console.log(`Coordinate checks at ${zoom * 100}%: ${result.checks.length} groups passed`);
    }
    report.success = true;
  } catch (error) { report.error = String(error); console.error(error); }
  finally {
    writeFileSync(join(output, "screen-coordinates.json"), JSON.stringify(report, null, 2) + "\n");
    clearTimeout(deadline); app.exit(report.success ? 0 : 1);
  }
}).catch(error => { console.error(error); app.exit(1); });
