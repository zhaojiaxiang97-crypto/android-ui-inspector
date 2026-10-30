const { app, BrowserWindow } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const project = resolve(__dirname, ".."), output = join(project, ".benchmarks", "debug-step-diff");
mkdirSync(output, { recursive: true });
app.setPath("userData", join(output, "profile"));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error("Diff UI checks exceeded 60 seconds"); app.exit(1); }, 60_000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const results = [];
  try {
    await window.loadFile(join(project, "benchmarks", "debug-step-diff.html"));
    for (const width of [1280, 360]) {
      window.setContentSize(width, 900);
      for (const state of ["normal", "empty", "partial", "missing", "error", "check"]) {
        results.push(await window.webContents.executeJavaScript(`window.verifyDebugStepDiff(${JSON.stringify(state)})`));
        if (["normal", "check"].includes(state)) {
          window.webContents.focus();
          window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          window.webContents.sendInputEvent({ type: "char", keyCode: "Enter" });
          window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
          await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
          const closed = await window.webContents.executeJavaScript("!document.querySelector('.debug-step-diff-changes').open");
          if (!closed) throw new Error(`Enter failed to collapse the changes at ${width}`);
          window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          window.webContents.sendInputEvent({ type: "char", keyCode: "Enter" });
          window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
          await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
          const opened = await window.webContents.executeJavaScript("document.querySelector('.debug-step-diff-changes').open");
          if (!opened) throw new Error(`Enter failed to reopen the changes at ${width}`);
        }
        writeFileSync(join(output, `${state}-${width}.png`), (await window.webContents.capturePage()).toPNG());
      }
      for (const state of ["normal", "check"]) results.push(await window.webContents.executeJavaScript(`window.verifyDebugStepDiff(${JSON.stringify(state)}, true)`));
      results.push(await window.webContents.executeJavaScript('window.verifyDebugStepDiff("normal", false, true)'));
    }
    writeFileSync(join(output, "result.json"), JSON.stringify({ passed: true, generatedAt: new Date().toISOString(),
      scope: "Synthetic loaded history only; no main process, preload, IPC or device capture", results }, null, 2) + "\n");
    console.log(`Diff UI checks: ${results.length} passed; ${output}`);
    clearTimeout(deadline); app.exit(0);
  } catch (error) {
    console.error(error); writeFileSync(join(output, "failed.png"), (await window.webContents.capturePage()).toPNG());
    writeFileSync(join(output, "result.json"), JSON.stringify({ passed: false, error: String(error), results }, null, 2) + "\n");
    clearTimeout(deadline); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
