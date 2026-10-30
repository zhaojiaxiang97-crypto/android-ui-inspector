const assert = require("node:assert/strict");
const { app, BrowserWindow } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { inspectCoordinateMatrix, assertCompleteCoordinateMatrix } = require("./lib/coordinate-matrix-checks.cjs");

const project = resolve(__dirname, "..");
const factorArgument = process.argv.find((value) => value.startsWith("--scale-factor="));
const scaleFactor = Number(factorArgument?.split("=")[1]);
if (![1, 1.25, 1.5].includes(scaleFactor)) throw new Error(`Unsupported scale factor: ${factorArgument ?? "missing"}`);

const output = join(project, ".benchmarks", "dpi-checks");
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(output, "electron-profile-"));
app.setPath("userData", profile);

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
    scope: "Electron force-device-scale-factor proxy over the production ScreenshotPreview coordinate harness at page zoom 1; this is a deterministic DPI proxy, not physical monitor DPI or a live Windows Settings/multi-monitor switch.",
    success: false,
  };
  try {
    await window.loadURL(pathToFileURL(join(project, "benchmarks/coordinates.html")).href);
    const readViewport = () => window.webContents.executeJavaScript("({ devicePixelRatio: window.devicePixelRatio, visualViewportScale: window.visualViewport?.scale ?? null, innerWidth, innerHeight, screenWidth: window.screen.width, screenHeight: window.screen.height })");
    report.pageZoomFactor = window.webContents.getZoomFactor();
    report.viewport = await readViewport();
    report.gpuFeatureStatus = app.getGPUFeatureStatus();
    assert.ok(Math.abs(report.pageZoomFactor - 1) < 0.001, `DPI proxy requires page zoom 1, received ${report.pageZoomFactor}`);
    const result = await window.webContents.executeJavaScript("window.verifyCoordinates()");
    report.checks = result.checks;
    report.harnessDevicePixelRatio = result.devicePixelRatio;
    report.harnessViewport = result.viewport;
    report.viewport = await readViewport();
    report.pageZoomFactor = window.webContents.getZoomFactor();
    report.coverage = inspectCoordinateMatrix(result.checks);
    assert.ok(Math.abs(report.pageZoomFactor - 1) < 0.001, `DPI proxy changed page zoom to ${report.pageZoomFactor}`);
    assert.ok(Math.abs(Number(result.devicePixelRatio) - scaleFactor) < 0.06, `devicePixelRatio ${result.devicePixelRatio} did not match ${scaleFactor}`);
    assert.ok(Math.abs(Number(report.viewport.devicePixelRatio) - scaleFactor) < 0.06, `viewport devicePixelRatio ${report.viewport.devicePixelRatio} did not match ${scaleFactor}`);
    assertCompleteCoordinateMatrix(report.coverage);
    report.success = true;
    console.log(`PASS: ${report.coverage.totalGroups} coordinate groups (${report.coverage.interactionGroups} interaction, ${report.coverage.pixelGroups} pixel) at devicePixelRatio ${report.viewport.devicePixelRatio}, page zoom ${report.pageZoomFactor}`);
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
