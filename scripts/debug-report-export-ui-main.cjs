const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const project = resolve(__dirname, ".."), evidence = process.argv[2];
if (!evidence) throw Error("Missing evidence directory");
app.setPath("userData", join(evidence, "profile")); app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error("Export UI verification exceeded 60 seconds"); app.exit(1); }, 60_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 880,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const errors = []; window.webContents.on("console-message", (_event, details) => { if (details.level === "error") errors.push(details.message); });
  try {
    await window.loadURL(pathToFileURL(join(project, "benchmarks", "debug-report-export.html")).href);
    const fixture = JSON.parse(readFileSync(join(evidence, "fixture.json"), "utf8"));
    const checks = await window.webContents.executeJavaScript(`window.verifyDebugReportExportUI(${JSON.stringify(fixture)}, ${JSON.stringify(join(evidence, "Debug-evidence-complete"))})`);
    const layouts = [];
    for (const width of [960, 1440]) {
      window.setContentSize(width, 880);
      await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const layout = await window.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('.debug-report-export'), button = panel.querySelector('[data-export-action="start"]'), dialog = document.querySelector('dialog');
        button.focus();
        const rect = panel.getBoundingClientRect(), action = button.getBoundingClientRect();
        return { fitsWidth: panel.scrollWidth <= panel.clientWidth + 1 && dialog.scrollWidth <= dialog.clientWidth + 1,
          buttonVisible: action.top >= rect.top && action.bottom <= rect.bottom, outline: getComputedStyle(button).outlineWidth,
          detailHeight: document.querySelector('.test-report-layout').getBoundingClientRect().height, feedback: panel.querySelector('[data-export-feedback]').dataset.exportState };
      })()`);
      if (!layout.fitsWidth || !layout.buttonVisible || layout.detailHeight < 120 || layout.feedback !== "complete") throw Error(`Invalid layout ${width}: ${JSON.stringify(layout)}`);
      writeFileSync(join(evidence, `report-export-${width}.png`), (await window.webContents.capturePage()).toPNG()); layouts.push({ width, ...layout });
    }
    if (errors.length) throw Error(`Renderer errors: ${errors.join("; ")}`);
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: true, generatedAt: new Date().toISOString(), sandbox: true,
      environment: { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform }, ...checks, layouts }, null, 2));
    console.log(JSON.stringify({ evidence, checks: checks.checks.length, layouts })); clearTimeout(deadline); app.exit(0);
  } catch (error) {
    writeFileSync(join(evidence, "failed.png"), (await window.webContents.capturePage()).toPNG());
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: false, error: String(error), errors }, null, 2));
    console.error(error, evidence); clearTimeout(deadline); app.exit(1);
  }
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
