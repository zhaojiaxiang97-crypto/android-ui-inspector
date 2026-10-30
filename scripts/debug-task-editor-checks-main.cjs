const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const output = process.argv[2];
app.setPath("userData", join(output, "profile"));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error("Task editor checks exceeded 60 seconds"); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1440, height: 880, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await window.loadURL(pathToFileURL(join(output, "index.html")).href);
    const result = await window.webContents.executeJavaScript("window.verifyDebugTaskEditor()");
    const layouts = [];
    for (const width of [1440, 960]) {
      window.setContentSize(width, 800);
      for (const state of ["selected", "empty", "error"]) {
        await window.webContents.executeJavaScript(`window.setDebugTaskEditorVisualState(${JSON.stringify(state)})`);
        const layout = await window.webContents.executeJavaScript(`(() => {
          const dialog = document.querySelector('.debug-task-editor'), box = dialog.getBoundingClientRect(), draft = dialog.querySelector('.task-editor-draft');
          return { fitsWidth: dialog.scrollWidth <= dialog.clientWidth + 1, fitsHeight: box.bottom <= innerHeight && box.top >= 0,
            draftFitsWidth: draft.scrollWidth <= draft.clientWidth + 1, conditionCount: dialog.querySelectorAll('.task-editor-condition').length,
            nodeEnabled: !dialog.querySelector('[data-task-action="use-selected-node"]').disabled,
            defineEnabled: !dialog.querySelector('[data-task-action="define"]').disabled, alert: dialog.querySelector('[role="alert"]')?.textContent ?? null };
        })()`);
        if (!layout.fitsWidth || !layout.fitsHeight || !layout.draftFitsWidth || layout.defineEnabled
          || (state === "selected" && (layout.conditionCount !== 6 || !layout.nodeEnabled))
          || (state !== "selected" && layout.nodeEnabled) || (state === "error" && !layout.alert))
          throw Error(`Invalid editor layout: ${JSON.stringify({ width, state, layout })}`);
        writeFileSync(join(output, `${state}-${width}.png`), (await window.webContents.capturePage()).toPNG());
        layouts.push({ width, state, ...layout });
      }
    }
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await new Promise(resolve => setTimeout(resolve, 40));
    if (await window.webContents.executeJavaScript("Boolean(document.querySelector('dialog'))")) throw Error("Escape did not close the editor");
    writeFileSync(join(output, "result.json"), JSON.stringify({ ...result, escapeCloses: true, layouts }, null, 2) + "\n");
    console.log("Task editor checks:", JSON.stringify({ ...result, escapeCloses: true, layouts }));
    clearTimeout(deadline); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
});
