const { app, BrowserWindow } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { viewports, verifyDisclosureKeyboard, verifyDialogKeyboard } = require("./lib/workbench-ui-driver.cjs");
const project = resolve(__dirname, ".."), base = join(project, ".benchmarks", "diagnosis-handoff");
mkdirSync(base, { recursive: true });
const output = mkdtempSync(join(base, "run-")); app.setPath("userData", join(output, "profile"));
const report = { passed: false, output, fixtureOnly: true, installedAcceptance: false, phoneOperations: 0, runs: [], rendererErrors: [] };
const deadline = setTimeout(() => { console.error("Diagnosis handoff checks exceeded 45 seconds"); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", details => { if (details.level === "error") report.rendererErrors.push(details.message); });
  window.webContents.on("render-process-gone", (_event, details) => { report.rendererErrors.push(details.reason); });
  try {
    for (const [width, height] of viewports) {
      window.setContentSize(width, height);
      await window.loadFile(join(project, "benchmarks/diagnosis-handoff.html"));
      const imports = await window.webContents.executeJavaScript("window.verifyReportImportLifecycle()");
      const result = await window.webContents.executeJavaScript("window.verifyDiagnosisHandoff()");
      writeFileSync(join(output, `handoff-${width}.png`), (await window.webContents.capturePage()).toPNG());
      const layout = await window.webContents.executeJavaScript("window.verifyWorkbenchLayout()");
      writeFileSync(join(output, `workbench-${width}.png`), (await window.webContents.capturePage()).toPNG());
      for (const theme of ["light", "dark"]) {
        await window.webContents.executeJavaScript(`(async () => {
          document.documentElement.dataset.appearance = ${JSON.stringify(theme)};
          for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
        })()`);
        writeFileSync(join(output, `workbench-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG());
      }
      for (const [name, selector] of [["zoom", ".zoom-continuous-toggle"], ["display", ".inspector-groups-open"]]) {
        await window.webContents.executeJavaScript(`(async () => {
          document.querySelector(${JSON.stringify(selector)}).click();
          for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
        })()`);
        writeFileSync(join(output, `settings-${name}-${width}.png`), (await window.webContents.capturePage()).toPNG());
        await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
      }
      const tree = await window.webContents.executeJavaScript("window.verifyWorkbenchTree()");
      report.runs.push({ width, height, ...result, imports, layout, tree });
      writeFileSync(join(output, `tree-search-${width}.png`), (await window.webContents.capturePage()).toPNG());
      const focus = await window.webContents.executeJavaScript("window.verifyWorkbenchFocus()");
      report.runs.at(-1).focus = focus;
      writeFileSync(join(output, `tree-focus-${width}.png`), (await window.webContents.capturePage()).toPNG());
      await window.webContents.executeJavaScript("document.querySelector('.tree-interaction-settings').open = true");
      writeFileSync(join(output, `tree-settings-${width}.png`), (await window.webContents.capturePage()).toPNG());
      const canvas = await window.webContents.executeJavaScript("window.verifyWorkbenchCanvas()");
      report.runs.at(-1).canvas = canvas;
      writeFileSync(join(output, `canvas-fit-${width}.png`), (await window.webContents.capturePage()).toPNG());
      report.runs.at(-1).appearance = await window.webContents.executeJavaScript("window.verifyWorkbenchAppearance()");
      await window.webContents.executeJavaScript(`(async () => {
        document.querySelector('.inspector-collapse').click();
        for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame);
        document.querySelector('.zoom-fit').click();
        for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame);
      })()`);
      writeFileSync(join(output, `canvas-collapsed-${width}.png`), (await window.webContents.capturePage()).toPNG());
      report.runs.at(-1).properties = await window.webContents.executeJavaScript("window.verifyWorkbenchProperties()");
      await verifyDisclosureKeyboard(window.webContents, ".inspector-type", [false, true]);
      report.runs.at(-1).properties.keyboardDisclosure = true;
      await window.webContents.executeJavaScript("document.querySelector('.inspector-body').scrollTop = 0");
      writeFileSync(join(output, `properties-${width}.png`), (await window.webContents.capturePage()).toPNG());
      report.runs.at(-1).entry = await window.webContents.executeJavaScript("window.verifyWorkbenchEntry()");
      await verifyDisclosureKeyboard(window.webContents, ".home-application-menu", [true, false]);
      report.runs.at(-1).entry.drawers.keyboardDisclosure = true;
      report.runs.at(-1).entry.commandShowcase = await window.webContents.executeJavaScript("window.showWorkbenchCommands()");
      writeFileSync(join(output, `commands-${width}.png`), (await window.webContents.capturePage()).toPNG());
      for (const state of ["connected", "loading", "unauthorized", "offline", "adb-missing", "no-device", "error"]) {
        await window.webContents.executeJavaScript(`window.showWorkbenchEntryState(${JSON.stringify(state)})`);
        writeFileSync(join(output, `entry-${state}-${width}.png`), (await window.webContents.capturePage()).toPNG());
      }
      await window.webContents.executeJavaScript(`(async () => {
        await window.showWorkbenchEntryState("connected");
        document.querySelector('.home-application-menu').open = true;
        document.querySelector('.home-application-menu [data-command=preferences]').focus(); document.querySelector('.home-application-menu [data-command=preferences]').click();
        await new Promise(requestAnimationFrame);
      })()`);
      writeFileSync(join(output, `preferences-${width}.png`), (await window.webContents.capturePage()).toPNG());
      await verifyDialogKeyboard(window.webContents, ".preferences-panel", ".home-application-menu > summary");
      report.runs.at(-1).entry.nativeDialogKeyboard = true;
    }
    if (report.rendererErrors.length) throw new Error(report.rendererErrors.join("\n"));
    report.passed = true;
  } catch (error) {
    report.error = String(error);
    report.activeElement = await window.webContents.executeJavaScript("document.activeElement?.outerHTML.slice(0, 500)");
    report.layout = await window.webContents.executeJavaScript(`(() => {
      const selectors = ['.preview-pane', '.scene-toolbar-host', '.screenshot-frame', '.floating-inspector', '.inspector-body'];
      return selectors.map(selector => { const element=document.querySelector(selector); if (!element) return { selector, missing:true };
        const rect=element.getBoundingClientRect(), style=getComputedStyle(element);
        return { selector, hidden:element.hidden, rect:{ left:rect.left, top:rect.top, width:rect.width, height:rect.height },
          offsetTop:element.offsetTop, clientHeight:element.clientHeight, style:element.getAttribute('style'),
          computed:{ display:style.display, position:style.position, top:style.top, maxHeight:style.maxHeight, visibility:style.visibility, zIndex:style.zIndex, transform:style.transform } }; });
    })()`);
    writeFileSync(join(output, "failed.png"), (await window.webContents.capturePage()).toPNG());
  } finally {
    writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); clearTimeout(deadline); app.exit(report.passed ? 0 : 1);
  }
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
