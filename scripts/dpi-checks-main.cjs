const assert = require("node:assert/strict");
const { app, BrowserWindow } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const project = resolve(__dirname, "..");
const factorArgument = process.argv.find((value) => value.startsWith("--scale-factor="));
const scaleFactor = Number(factorArgument?.split("=")[1]);
if (![1, 1.25, 1.5].includes(scaleFactor)) throw new Error(`Unsupported scale factor: ${factorArgument ?? "missing"}`);

const output = join(project, ".benchmarks", "dpi-checks");
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(output, "electron-profile-"));
app.setPath("userData", profile);
app.disableHardwareAcceleration();

const deadline = setTimeout(() => {
  console.error(`DPI check at ${scaleFactor * 100}% exceeded 120 seconds`);
  app.exit(1);
}, 120_000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 880,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("DPI check renderer exited", details.reason);
    app.exit(1);
  });
  const reportPath = join(output, `dpi-${String(scaleFactor).replace(".", "_")}.json`);
  const report = {
    generatedAt: new Date().toISOString(),
    requestedScaleFactor: scaleFactor,
    scope: "Electron force-device-scale-factor proxy over the production ScreenshotPreview coordinate harness; this is a deterministic DPI proxy, not a live Windows Settings or multi-monitor switch.",
    success: false,
  };
  try {
    await window.loadURL(pathToFileURL(join(project, "benchmarks/coordinates.html")).href);
    const result = await window.webContents.executeJavaScript("window.verifyCoordinates()");
    const viewport = await window.webContents.executeJavaScript("({ devicePixelRatio: window.devicePixelRatio, visualViewportScale: window.visualViewport?.scale ?? null, innerWidth, innerHeight, screenWidth: window.screen.width, screenHeight: window.screen.height })");
    assert.ok(Math.abs(Number(result.devicePixelRatio) - scaleFactor) < 0.06, `devicePixelRatio ${result.devicePixelRatio} did not match ${scaleFactor}`);
    assert.equal(result.checks.length, 25, "DPI proxy did not complete the full coordinate matrix");
    report.viewport = viewport;
    report.checks = result.checks;
    report.success = true;
    console.log(`PASS: ${result.checks.length} coordinate groups at devicePixelRatio ${viewport.devicePixelRatio}`);
  } catch (error) {
    report.error = String(error);
    console.error(error);
  } finally {
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    clearTimeout(deadline);
    app.exit(report.success ? 0 : 1);
  }
}).catch((error) => {
  console.error(error);
  clearTimeout(deadline);
  app.exit(1);
});
