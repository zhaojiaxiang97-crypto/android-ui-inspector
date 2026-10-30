const { app, BrowserWindow } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const project = resolve(__dirname, ".."), base = join(project, ".benchmarks/hidden-layers");
mkdirSync(base, { recursive: true }); const evidence = mkdtempSync(join(base, "run-"));
app.setPath("userData", join(evidence, "profile")); app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 180_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 960, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on("console-message", details => { if (details.level === "error") errors.push(details.message); });
  try {
    await window.loadURL(pathToFileURL(join(base, "build/index.html")).href);
    window.webContents.focus();
    const results = [], visuals = [];
    for (const zoom of [1, 1.25, 1.5]) {
      window.setSize(960, 700); window.webContents.setZoomFactor(zoom);
      await window.webContents.executeJavaScript("void (window.hiddenLayersVisualCheckpoint = () => new Promise(resolve => { window.hiddenLayersVisualResume = resolve; window.hiddenLayersVisualReady = true; }))");
      let finished = false;
      const checking = window.webContents.executeJavaScript("window.verifyHiddenLayers()");
      checking.finally(() => { finished = true; }).catch(() => {});
      while (!finished && !await window.webContents.executeJavaScript("Boolean(window.hiddenLayersVisualReady)")) await new Promise(resolve => setTimeout(resolve, 30));
      if (!finished) {
        for (const [windowWidth, windowHeight] of [[1440, 900], [960, 700], [650, 760]]) {
          window.setSize(windowWidth, windowHeight);
          for (const theme of ["dark", "light"]) for (const width of [306, 248]) {
            const visual = await window.webContents.executeJavaScript(`window.setHiddenLayersVisual(${JSON.stringify(theme)}, ${width})`);
            const name = `${theme}-${width}-${windowWidth}-${zoom}.png`;
            writeFileSync(join(evidence, name), (await window.webContents.capturePage()).toPNG());
            visuals.push({ zoom, windowWidth, windowHeight, ...visual, screenshot: name });
          }
        }
        await window.webContents.executeJavaScript("window.hiddenLayersNativePrepare()");
        window.webContents.focus();
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" }); window.webContents.sendInputEvent({ type: "char", keyCode: "Enter" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        await new Promise(resolve => setTimeout(resolve, 80)); await window.webContents.executeJavaScript("window.hiddenLayersNativeCheck(true)");
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await new Promise(resolve => setTimeout(resolve, 80)); await window.webContents.executeJavaScript("window.hiddenLayersNativeCheck(false)");
        await window.webContents.executeJavaScript("window.hiddenLayersVisualResume(); window.hiddenLayersVisualReady = false;");
      }
      const result = await checking; results.push({ zoom, ...result }); console.log("Hidden layers", zoom, result.checks.length, "groups passed");
    }
    if (errors.length) throw new Error(`Renderer errors: ${errors.join("; ")}`);
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: true, sandbox: true, nativeEnterEsc: true, errors, results, visuals }, null, 2));
    console.log("Hidden layers evidence:", evidence); clearTimeout(deadline); app.exit(0);
  } catch (error) {
    console.error(error); writeFileSync(join(evidence, "failure.png"), (await window.webContents.capturePage()).toPNG());
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: false, errors, error: String(error) }, null, 2)); clearTimeout(deadline); app.exit(1);
  }
});
