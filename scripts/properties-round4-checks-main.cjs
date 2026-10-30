const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const project = resolve(__dirname, ".."), base = join(project, ".benchmarks/properties-round4");
mkdirSync(base, { recursive: true }); const evidence = mkdtempSync(join(base, "run-"));
app.setPath("userData", join(evidence, "profile")); app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error("Properties round4 exceeded 240 seconds"); app.exit(1); }, 240_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { preload: join(__dirname, "properties-round4-checks-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [], report = { passed: false, fixtureOnly: true, phoneOperations: 0, sandbox: true, runs: [], errors };
  window.webContents.on("console-message", details => { if (details.level === "error") errors.push(details.message); });
  let size = [1440, 900], zoom = 1, pane = 248;
  ipcMain.handle("fixture-properties-key", async (event, keyCode) => {
    if (event.sender !== window.webContents || !["Escape", "Enter", "ArrowUp", "ArrowDown"].includes(keyCode)) throw new Error("invalid fixture key");
    const key = keyCode === "ArrowUp" ? "Up" : keyCode === "ArrowDown" ? "Down" : keyCode;
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
    if (keyCode === "Enter") window.webContents.sendInputEvent({ type: "char", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  ipcMain.handle("fixture-properties-checkpoint", async (event, name) => {
    if (event.sender !== window.webContents || !/^[a-z-]+$/.test(name)) throw new Error("invalid fixture screenshot");
    writeFileSync(join(evidence, `${size.join("x")}-${zoom * 100}-${pane}-${name}.png`), (await window.webContents.capturePage()).toPNG());
  });
  try {
    await window.loadURL(pathToFileURL(join(base, "build/index.html")).href); window.webContents.focus();
    for (zoom of [1, 1.25, 1.5]) for (size of [[1440, 900], [960, 700], [650, 760]]) {
      window.setSize(...size); window.webContents.setZoomFactor(zoom);
      pane = size[0] === 1440 ? 306 : 248;
      for (const theme of ["dark", "light"]) {
        const result = await window.webContents.executeJavaScript(`window.verifyPropertiesRound4(window.propertiesRound4Native, ${JSON.stringify(theme)}, ${pane})`);
        if (window.webContents.getZoomFactor() !== zoom) throw new Error("property controls changed page zoom");
        report.runs.push({ size, zoom, ...result }); console.log(`Properties ${size.join("x")} ${zoom * 100}% ${theme}/${pane}: ${result.checks.length} checks, 0 device operations`);
      }
    }
    if (errors.length) throw new Error(`Renderer errors: ${errors.join("; ")}`); report.passed = true;
  } catch (error) { report.error = String(error); console.error(error); writeFileSync(join(evidence, "failure.png"), (await window.webContents.capturePage()).toPNG()); }
  finally { writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2)); console.log("Properties round4 evidence:", evidence); clearTimeout(deadline); app.exit(report.passed ? 0 : 1); }
}).catch(error => { console.error(error); app.exit(1); });
