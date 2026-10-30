const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const output = process.argv[2];
app.setPath("userData", join(output, "profile"));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error("Live preview checks exceeded 60 seconds"); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1280, height: 880, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await window.loadURL(pathToFileURL(join(output, "index.html")).href);
    const result = await window.webContents.executeJavaScript("window.verifyLivePreview()");
    const layouts = [];
    for (const width of [1280, 960]) {
      window.setContentSize(width, 800);
      for (const state of ["running", "paused", "error"]) {
        await window.webContents.executeJavaScript(`window.setLivePreviewVisualState(${JSON.stringify(state)})`);
        const layout = await window.webContents.executeJavaScript(`(() => {
          const panel = document.querySelector('.live-preview-panel'), img = panel.querySelector('img');
          const box = panel.getBoundingClientRect();
          return { status: panel.querySelector('[role="status"]').textContent, fitsWidth: panel.scrollWidth <= panel.clientWidth + 1,
            fitsHeight: box.bottom <= innerHeight && box.top >= 0, imageVisible: img?.complete && img?.naturalWidth > 0,
            previewTime: panel.querySelectorAll('time')[0].dateTime, treeTime: panel.querySelectorAll('time')[1].dateTime };
        })()`);
        if (!layout.fitsWidth || !layout.fitsHeight || !layout.imageVisible || layout.previewTime === layout.treeTime)
          throw Error(`Invalid live preview layout: ${JSON.stringify({ width, state, layout })}`);
        writeFileSync(join(output, `${state}-${width}.png`), (await window.webContents.capturePage()).toPNG());
        layouts.push({ width, state, ...layout });
      }
    }
    writeFileSync(join(output, "result.json"), JSON.stringify({ ...result, layouts }, null, 2) + "\n");
    console.log("Live preview checks:", JSON.stringify({ ...result, layouts }));
    clearTimeout(deadline); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
});
