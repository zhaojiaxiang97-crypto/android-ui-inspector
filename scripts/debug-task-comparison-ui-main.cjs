const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const project = resolve(__dirname, ".."), evidence = process.argv[2];
if (!evidence) throw Error("Missing evidence directory");
app.setPath("userData", join(evidence, "profile")); app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error("Comparison UI verification exceeded 60 seconds"); app.exit(1); }, 60_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 880,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const errors = []; window.webContents.on("console-message", (_event, details) => { if (details.level === "error") errors.push(details.message); });
  try {
    await window.loadURL(pathToFileURL(join(project, "benchmarks", "debug-task-comparison.html")).href);
    const fixtures = JSON.parse(readFileSync(join(evidence, "fixtures.json"), "utf8"));
    const checks = await window.webContents.executeJavaScript(`window.verifyTaskComparisonUI(${JSON.stringify(fixtures)})`), layouts = [];
    for (const width of [960, 1440]) {
      window.setContentSize(width, 880);
      for (const state of ["same", "mismatch", "missing", "unchecked"]) {
        await window.webContents.executeJavaScript(`window.showTaskComparisonCase(${JSON.stringify(state)})`);
        await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        const layout = await window.webContents.executeJavaScript(`(() => {
          const panel = document.querySelector('.debug-task-run-comparison'), button = panel.querySelector('[data-comparison-action="import"]'), dialog = document.querySelector('dialog');
          const rect = panel.getBoundingClientRect(), action = button.getBoundingClientRect(); button.focus();
          return { fitsWidth: panel.scrollWidth <= panel.clientWidth + 1 && dialog.scrollWidth <= dialog.clientWidth + 1,
            buttonVisible: action.top >= rect.top && action.bottom <= rect.bottom, focusOutline: getComputedStyle(button).outlineWidth,
            detailHeight: document.querySelector('.test-report-layout').getBoundingClientRect().height, gate: panel.querySelector('[data-comparison-result]').dataset.comparisonResult,
            finalStatus: panel.querySelector('[data-comparison-phase-kind="final"] [data-comparison-side="secondary"] [data-comparison-status]')?.dataset.comparisonStatus ?? null };
        })()`);
        if (!layout.fitsWidth || !layout.buttonVisible || layout.detailHeight < 80) throw Error(`Invalid layout ${width}/${state}: ${JSON.stringify(layout)}`);
        writeFileSync(join(evidence, `comparison-${state}-${width}.png`), (await window.webContents.capturePage()).toPNG()); layouts.push({ width, state, ...layout });
        if (state === "same" || state === "missing") {
          await window.webContents.executeJavaScript(`(() => {
            const panel = document.querySelector('.debug-task-run-comparison'); panel.querySelector('[data-comparison-phase-kind="final"]').scrollIntoView({ block: 'end' });
          })()`);
          writeFileSync(join(evidence, `comparison-${state}-final-${width}.png`), (await window.webContents.capturePage()).toPNG());
          await window.webContents.executeJavaScript(`(() => {
            const row = document.querySelector('[data-comparison-phase-kind="final"]');
            row.querySelector('[data-comparison-side="secondary"] .debug-run-condition-results').open = true;
            row.querySelector('th > details').open = true; row.scrollIntoView({ block: 'start' });
          })()`);
          await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
          writeFileSync(join(evidence, `comparison-${state}-conditions-${width}.png`), (await window.webContents.capturePage()).toPNG());
        }
      }
    }
    if (errors.length) throw Error(`Renderer errors: ${errors.join("; ")}`);
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: true, generatedAt: new Date().toISOString(), sandbox: true,
      environment: { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform }, ...checks, layouts }, null, 2));
    console.log(JSON.stringify({ evidence, checks: checks.checks.length, layouts })); clearTimeout(deadline); app.exit(0);
  } catch (error) {
    writeFileSync(join(evidence, "failed.png"), (await window.webContents.capturePage()).toPNG());
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: false, error: String(error), errors }, null, 2)); console.error(error, evidence); clearTimeout(deadline); app.exit(1);
  }
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
