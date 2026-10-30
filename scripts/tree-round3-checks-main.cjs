const { app, BrowserWindow } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const project = resolve(__dirname, ".."), base = join(project, ".benchmarks/tree-round3");
mkdirSync(base, { recursive: true });
const evidence = mkdtempSync(join(base, "run-"));
app.setPath("userData", join(evidence, "profile")); app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 180_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 960, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on("console-message", details => { if (details.level === "error") errors.push(details.message); });
  try {
    await window.loadURL(pathToFileURL(join(base, "build/index.html")).href);
    const results = [];
    for (const zoom of [1, 1.25, 1.5]) {
      window.webContents.setZoomFactor(zoom);
      await window.webContents.executeJavaScript("void (window.treeRound3VisualCheckpoint = () => new Promise(resolve => { window.treeRound3VisualResume = resolve; window.treeRound3VisualReady = true; }))");
      let finished = false;
      const checking = window.webContents.executeJavaScript("window.verifyTreeRound3()");
      checking.finally(() => { finished = true; }).catch(() => {});
      while (!finished && !await window.webContents.executeJavaScript("Boolean(window.treeRound3VisualReady)")) await new Promise(resolve => setTimeout(resolve, 40));
      if (!finished) {
        for (const theme of ["dark", "light"]) for (const width of [306, 248]) {
          const visual = await window.webContents.executeJavaScript(`window.setTreeRound3Visual(${JSON.stringify(theme)}, ${width})`);
          writeFileSync(join(evidence, `${theme}-${width}-${zoom}.png`), (await window.webContents.capturePage()).toPNG());
          console.log("Visual", JSON.stringify({ zoom, ...visual }));
        }
        await window.webContents.executeJavaScript("window.treeRound3VisualResume(); window.treeRound3VisualReady = false;");
      }
      const result = await checking; results.push({ zoom, ...result }); console.log("Tree round3", zoom, result.checks.length, "checks passed");
    }
    if (errors.length) throw new Error(`Renderer errors: ${errors.join("; ")}`);
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: true, sandbox: true, errors, results }, null, 2));
    console.log("Tree round3 evidence:", evidence); clearTimeout(deadline); app.exit(0);
  } catch (error) {
    console.error(error); writeFileSync(join(evidence, "failure.png"), (await window.webContents.capturePage()).toPNG());
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: false, errors, error: String(error) }, null, 2)); clearTimeout(deadline); app.exit(1);
  }
});
