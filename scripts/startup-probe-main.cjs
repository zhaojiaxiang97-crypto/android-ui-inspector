const { app, BrowserWindow } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const mode = process.argv.find((argument) => argument.startsWith("--probe-mode="))?.slice(13) ?? "legacy";
const output = resolve(process.env.INSPECTOR_PROBE_OUTPUT);
mkdirSync(output, { recursive: true });
app.setPath("userData", mkdtempSync(join(output, "profile-")));
if (mode !== "default") app.disableHardwareAcceleration();
if (mode === "legacy" || mode === "no-in-process") {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("use-angle", "swiftshader");
}
if (mode === "legacy") app.commandLine.appendSwitch("in-process-gpu");

const events = [];
let window;
const report = (success, detail) => {
  const value = { mode, success, detail, events, metrics: app.isReady() ? app.getAppMetrics() : [], versions: process.versions };
  writeFileSync(join(output, "result.json"), JSON.stringify(value, null, 2) + "\n");
  console.log(JSON.stringify({ mode, success, detail }));
  app.exit(success ? 0 : 1);
};
const timeout = setTimeout(() => report(false, "startup timed out"), 15_000);
app.on("child-process-gone", (_event, details) => events.push({ event: "child-process-gone", ...details }));
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: {
    sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false,
    preload: join(__dirname, "startup-probe-preload.cjs"),
  } });
  for (const event of ["render-process-gone", "preload-error", "did-fail-load"]) {
    window.webContents.on(event, (_event, ...details) => events.push({ event, details }));
  }
  try {
    await window.loadURL(pathToFileURL(join(__dirname, "startup-probe.html")).href);
    const state = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('button').click();
      return { title: document.title, count: document.querySelector('output').textContent, sandboxed: window.startupProbe?.sandboxed, contextIsolated: window.startupProbe?.contextIsolated, nodeExposed: typeof window.require !== 'undefined' };
    })()`);
    if (!state.sandboxed || !state.contextIsolated || state.count !== "1" || state.nodeExposed) throw new Error(JSON.stringify(state));
    await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const screenshot = await window.webContents.capturePage();
    writeFileSync(join(output, "page.png"), screenshot.toPNG());
    clearTimeout(timeout);
    report(true, state);
  } catch (error) {
    // Give process launch diagnostics time to arrive before collecting metrics.
    setTimeout(() => { clearTimeout(timeout); report(false, String(error)); }, 300);
  }
}).catch((error) => report(false, String(error)));
