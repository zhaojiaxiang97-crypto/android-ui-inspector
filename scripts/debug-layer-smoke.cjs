// Replay a real saved inspection without recapturing the phone.
// node_modules/.bin/electron scripts/debug-layer-smoke.cjs /absolute/snapshot.json /absolute/output-dir
const { app, BrowserWindow, ipcMain } = require("electron");
const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { resolve, join } = require("node:path");
const assert = require("node:assert/strict");
const snapshot = JSON.parse(readFileSync(process.argv[2], "utf8"));
const output = resolve(process.argv[3]);
const project = resolve(__dirname, "..");
app.setPath("userData", join(output, "profile"));
ipcMain.handle("probe-adb", () => ({ devices: [{ serial: snapshot.serial, state: "device", model: "Debug replay" }], error: null }));
ipcMain.handle("inspect-device", () => snapshot);
ipcMain.handle("load-snapshots", () => ({ snapshots: [], error: null }));
app.whenReady().then(async () => {
  try {
    mkdirSync(output, { recursive: true });
    const window = new BrowserWindow({ width: 1500, height: 1000, webPreferences: { preload: join(project, "dist-electron/preload.cjs"), contextIsolation: true } });
    await window.loadFile(join(project, "dist/index.html"));
    const evaluate = (code) => window.webContents.executeJavaScript(code);
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(code)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Timed out: ${code}`);
    };
    await waitFor("Boolean(document.querySelector('.capture-button:not([disabled])'))");
    await evaluate("document.querySelector('.capture-button').click()");
    await waitFor("Boolean(document.querySelector('.tree-row'))");
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='3D 层级').click()");
    await waitFor("Boolean(document.querySelector('.layer-scene'))");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    writeFileSync(join(output, "expanded.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='全部折叠').click()");
    await waitFor("document.querySelector('.layer-scene')?.dataset.layerRootComposite === 'true'");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(await evaluate("Number(document.querySelector('.layer-scene').dataset.layerCompositeCount)"), 1);
    writeFileSync(join(output, "collapsed.png"), (await window.webContents.capturePage()).toPNG());
    console.log(`Replay passed: ${output}`);
    app.quit();
  } catch (error) {
    console.error(error); app.exit(1);
  }
});
