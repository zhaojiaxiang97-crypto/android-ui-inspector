const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const output = process.argv[2];
app.setPath("userData", join(output, "profile")); app.disableHardwareAcceleration();
const deadline = setTimeout(() => { console.error("Selector diagnosis checks exceeded 60 seconds"); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1280, height: 900, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const run = source => window.webContents.executeJavaScript(source);
  const key = async (keyCode, text) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    if (text) window.webContents.sendInputEvent({ type: "char", keyCode: text });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await new Promise(resolve => setTimeout(resolve, 40));
  };
  try {
    await window.loadURL(pathToFileURL(join(output, "index.html")).href);
    const result = await run("window.selectorDiagnosticChecks.verify()"), layouts = [];
    for (const width of [1280, 360]) {
      window.setContentSize(width, 900);
      for (const state of ["one", "multiple", "reference", "none", "empty", "no-tree", "error", "duplicate-id", "invalid-bounds", "old", "many"]) {
        await run(`window.selectorDiagnosticChecks.setup(${JSON.stringify(state)})`);
        const folded = await run("window.selectorDiagnosticChecks.layout()");
        if (folded.open) throw Error("Details should start folded");
        if (state === "one") writeFileSync(join(output, `collapsed-${width}.png`), (await window.webContents.capturePage()).toPNG());
        await run("window.selectorDiagnosticChecks.expand()");
        const layout = await run("window.selectorDiagnosticChecks.layout()");
        if (!layout.fitsWidth || !layout.detailsFits || !layout.listsFit
          || (["reference", "none", "empty", "no-tree", "error", "duplicate-id", "invalid-bounds"].includes(state) && layout.enabledButtons)
          || (["no-tree", "error"].includes(state) && layout.alertColor !== "rgb(237, 126, 126)")
          || (state === "reference" && !layout.referenceCount) || (state === "many" && layout.exactCount !== 20))
          throw Error(`Invalid layout: ${JSON.stringify({ width, state, layout })}`);
        writeFileSync(join(output, `${state}-${width}.png`), (await window.webContents.capturePage()).toPNG());
        delete layout.body; layouts.push({ width, state, ...layout });
      }
      await run('window.selectorDiagnosticChecks.setup("one")'); window.webContents.focus();
      await run("window.selectorDiagnosticChecks.focusSummary()"); await key("Enter", "Enter");
      if (!(await run("window.selectorDiagnosticChecks.result().open"))) throw Error("Native Enter did not expand details");
      await key("Tab"); await key("Tab");
      if (!(await run('document.activeElement?.matches("[data-selector-action=select]")'))) throw Error("Native Tab did not reach the selection button");
      await key("Enter", "Enter");
      const selected = await run("window.selectorDiagnosticChecks.result()");
      if (selected.callbackCount !== 1 || !selected.sourceIsCurrent || selected.selected !== "ready") throw Error(`Native Enter selection failed: ${JSON.stringify(selected)}`);
      await run("window.selectorDiagnosticChecks.focusAction()");
      const focus = await run("window.selectorDiagnosticChecks.layout().focusVisible");
      if (!focus) throw Error("Keyboard focus outline is not visible");
      writeFileSync(join(output, `keyboard-${width}.png`), (await window.webContents.capturePage()).toPNG());
      layouts.push({ width, state: "native-keyboard", ...selected, focusVisible: focus });
    }
    const evidence = { ...result, layouts, sandbox: true, deviceOperations: 0 };
    writeFileSync(join(output, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.log("Selector diagnosis checks:", JSON.stringify(evidence)); clearTimeout(deadline); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
});
