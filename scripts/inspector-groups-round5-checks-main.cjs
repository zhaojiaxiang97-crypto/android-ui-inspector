const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const project = resolve(__dirname, ".."), base = join(project, ".benchmarks/inspector-groups-round5");
mkdirSync(base, { recursive: true }); const evidence = mkdtempSync(join(base, "run-"));
app.setPath("userData", join(evidence, "profile")); app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error("Inspector groups round5 exceeded 180 seconds"); app.exit(1); }, 180_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { preload: join(__dirname, "inspector-groups-round5-checks-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [], report = { passed: false, fixtureOnly: true, phoneOperations: 0, sandbox: true, runs: [], errors };
  window.webContents.on("console-message", details => { if (details.level === "error") errors.push(details.message); });
  let size = [1440, 900], zoom = 1, pane = 248;
  ipcMain.handle("fixture-inspector-group-key", async (event, keyCode) => {
    if (event.sender !== window.webContents || !["Escape", "Enter", "Space"].includes(keyCode)) throw new Error("invalid fixture key");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    if (keyCode === "Enter" || keyCode === "Space") window.webContents.sendInputEvent({ type: "char", keyCode: keyCode === "Space" ? " " : keyCode });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  ipcMain.handle("fixture-inspector-group-checkpoint", async (event, name) => {
    if (event.sender !== window.webContents || !/^[a-z-]+$/.test(name)) throw new Error("invalid fixture screenshot");
    writeFileSync(join(evidence, `${size.join("x")}-${zoom * 100}-${pane}-${name}.png`), (await window.webContents.capturePage()).toPNG());
  });
  try {
    await window.loadURL(pathToFileURL(join(base, "build/index.html")).href); window.webContents.focus();
    for (zoom of [1, 1.25, 1.5]) for (size of [[1440, 900], [960, 700], [650, 760]]) {
      window.setSize(...size); window.webContents.setZoomFactor(zoom); pane = size[0] === 1440 ? 306 : 248;
      for (const theme of ["dark", "light"]) {
        const result = await window.webContents.executeJavaScript(`window.verifyInspectorGroupsRound5(window.inspectorGroupsRound5Native, ${JSON.stringify(theme)}, ${pane})`);
        if (window.webContents.getZoomFactor() !== zoom) throw new Error("group controls changed page zoom");
        report.runs.push({ size, zoom, ...result }); console.log(`Inspector groups ${size.join("x")} ${zoom * 100}% ${theme}/${pane}: ${result.checks.length} checks, 0 device operations`);
      }
    }
    if (errors.length) throw new Error(`Renderer errors: ${errors.join("; ")}`); report.passed = true;
  } catch (error) { report.error = String(error); console.error(error); writeFileSync(join(evidence, "failure.png"), (await window.webContents.capturePage()).toPNG()); }
  finally { writeFileSync(join(evidence, "result.json"), JSON.stringify(report, null, 2)); console.log("Inspector groups round5 evidence:", evidence); clearTimeout(deadline); app.exit(report.passed ? 0 : 1); }
}).catch(error => { console.error(error); app.exit(1); });
