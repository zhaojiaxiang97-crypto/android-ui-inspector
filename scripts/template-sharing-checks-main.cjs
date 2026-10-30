const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const output = process.argv[2];
app.setPath("userData", join(output, "profile"));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error("Template sharing checks exceeded 60 seconds"); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1440, height: 880, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await window.loadURL(pathToFileURL(join(output, "index.html")).href);
    const result = await window.webContents.executeJavaScript("window.verifyTemplateSharing()");
    const layouts = [];
    for (const width of [1440, 960, 640]) {
      window.setContentSize(width, 800);
      for (const state of ["templates", "fragments", "error"]) {
        await window.webContents.executeJavaScript(`window.setTemplateSharingVisualState(${JSON.stringify(state)})`);
        const layout = await window.webContents.executeJavaScript(`(() => {
          const dialog = document.querySelector('.debug-task-editor'), box = dialog.getBoundingClientRect(), draft = dialog.querySelector('.task-editor-draft'), library = dialog.querySelector('.task-editor-templates');
          const form = dialog.querySelector('.task-editor-fragment-save')?.getBoundingClientRect(), libraryBox = library.getBoundingClientRect();
          return { fitsWidth: dialog.scrollWidth <= dialog.clientWidth + 1, fitsHeight: box.bottom <= innerHeight && box.top >= 0,
            draftFitsWidth: draft.scrollWidth <= draft.clientWidth + 1, libraryFitsWidth: library.scrollWidth <= library.clientWidth + 1,
            conditionCount: dialog.querySelectorAll('.task-editor-condition').length,
            defineEnabled: !dialog.querySelector('[data-task-action="define"]').disabled,
            fragmentName: Boolean(dialog.querySelector('[data-task-field="fragment-name"]')),
            fragmentSaveVisible: !form || form.top >= libraryBox.top - 1 && form.bottom <= libraryBox.bottom + 1,
            alert: dialog.querySelector('[role="alert"]')?.textContent ?? null,
            footerVisible: dialog.querySelector('.task-editor-session').getBoundingClientRect().bottom <= box.bottom };
        })()`);
        if (!layout.fitsWidth || !layout.fitsHeight || !layout.draftFitsWidth || !layout.libraryFitsWidth || !layout.footerVisible || layout.defineEnabled
          || (state !== "error" && layout.conditionCount !== 6) || (state === "fragments" && (!layout.fragmentName || !layout.fragmentSaveVisible)) || (state === "error" && !layout.alert))
          throw Error(`Invalid sharing layout: ${JSON.stringify({ width, state, layout })}`);
        writeFileSync(join(output, `${state}-${width}.png`), (await window.webContents.capturePage()).toPNG());
        layouts.push({ width, state, ...layout });
      }
    }
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await new Promise(resolve => setTimeout(resolve, 40));
    if (await window.webContents.executeJavaScript("Boolean(document.querySelector('dialog'))")) throw Error("Native Escape did not close sharing editor");
    writeFileSync(join(output, "result.json"), JSON.stringify({ ...result, escapeCloses: true, layouts }, null, 2) + "\n");
    console.log("Template sharing checks:", JSON.stringify({ ...result, escapeCloses: true, layouts }));
    clearTimeout(deadline); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
});
