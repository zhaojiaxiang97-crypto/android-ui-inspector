const { app, BrowserWindow } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { cpus, release } = require("node:os");
const { pathToFileURL } = require("node:url");

const project = resolve(__dirname, "..");
const outputDirectory = join(project, ".benchmarks");
const diagnosticUnsandboxed = process.argv.includes("--diagnostic-unsandboxed");
const checksOnly = process.argv.includes("--checks-only");
mkdirSync(outputDirectory, { recursive: true });
const checksBase = join(outputDirectory, "tree-ui");
mkdirSync(checksBase, { recursive: true });
const evidence = mkdtempSync(join(checksBase, "run-"));
app.setPath("userData", join(evidence, "profile"));
app.commandLine.appendSwitch("enable-logging");
app.commandLine.appendSwitch("log-file", join(evidence, "electron-render.log"));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => {
  console.error("Rendering benchmark exceeded 180 seconds");
  app.exit(1);
}, 180_000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 880,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: !diagnosticUnsandboxed, backgroundThrottling: false },
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("Benchmark renderer exited", details.reason);
    app.exit(1);
  });
  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    console.error("Benchmark navigation failed:", { code, description, url, isMainFrame });
  });
  try {
    await window.loadURL(pathToFileURL(join(project, "benchmarks/render.html")).href);
    const correctness = await window.webContents.executeJavaScript("window.verifyTreeBehavior()");
    console.log("Behavior checks:", JSON.stringify(correctness));
    const virtualCorrectness = await window.webContents.executeJavaScript("window.verifyVirtualTreeBehavior()");
    console.log("Virtual tree checks:", JSON.stringify(virtualCorrectness));
    window.webContents.setZoomFactor(1.25);
    const virtualZoomChecks = await window.webContents.executeJavaScript("window.verifyVirtualTreeBehavior()");
    window.webContents.setZoomFactor(1);
    console.log("Virtual tree checks at 125% zoom:", virtualZoomChecks.checks.length, "passed");
    if (checksOnly) await window.webContents.executeJavaScript("void (window.captureFeedbackCheckpoint = () => new Promise(resolve => { window.captureFeedbackResume = resolve; window.captureFeedbackReady = true; }))");
    const inspectionRun = window.webContents.executeJavaScript("window.verifyInspectionBehavior()");
    if (checksOnly) {
      const checkpointDeadline = Date.now() + 30000;
      let finished = false;
      inspectionRun.then(() => { finished = true; }, () => { finished = true; });
      while (!finished && !await window.webContents.executeJavaScript("Boolean(window.captureFeedbackReady)")) {
        if (Date.now() > checkpointDeadline) throw new Error("Capture feedback screenshot checkpoint timed out");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!finished) {
        for (const width of [1280, 960]) {
          window.setContentSize(width, 880);
          await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
          const layout = await window.webContents.executeJavaScript(`(() => {
            const panel = document.querySelector('.capture-failure-feedback');
            const button = panel?.querySelector('.capture-retry');
            const pane = panel?.parentElement;
            return { title: panel?.querySelector('h4')?.textContent, buttonVisible: Boolean(button && button.getBoundingClientRect().bottom <= pane.getBoundingClientRect().bottom),
              fitsWidth: Boolean(panel && panel.scrollWidth <= panel.clientWidth + 1), height: panel?.getBoundingClientRect().height };
          })()`);
          if (layout.title !== "控件树读取超时" || !layout.buttonVisible || !layout.fitsWidth) throw new Error(`Capture feedback layout invalid at ${width}: ${JSON.stringify(layout)}`);
          writeFileSync(join(outputDirectory, `capture-feedback-${width}.png`), (await window.webContents.capturePage()).toPNG());
          console.log(`Capture feedback layout at ${width}:`, JSON.stringify(layout));
        }
        window.setContentSize(1280, 880);
        await window.webContents.executeJavaScript("window.captureFeedbackResume(); delete window.captureFeedbackCheckpoint;");
      }
    }
    const inspectionChecks = await inspectionRun;
    console.log("Inspection lifecycle checks:", JSON.stringify(inspectionChecks));
    const debugHandoff = await window.webContents.executeJavaScript("window.verifyDebugHandoff()");
    console.log("Debug handoff checks:", JSON.stringify(debugHandoff));
    const hoverIntegration = await window.webContents.executeJavaScript("window.verifyWorkbenchHover()");
    console.log("Workbench hover checks:", JSON.stringify(hoverIntegration));
    if (checksOnly) {
      const result = JSON.stringify({ passed: true, generatedAt: new Date().toISOString(), sandbox: !diagnosticUnsandboxed, correctness, virtualCorrectness, virtualZoomChecks, inspectionChecks, debugHandoff, hoverIntegration }, null, 2) + "\n";
      writeFileSync(join(evidence, "result.json"), result);
      writeFileSync(join(outputDirectory, diagnosticUnsandboxed ? "tree-behavior-diagnostic.json" : "tree-behavior.json"), result);
      console.log(`Tree evidence: ${evidence}`);
      clearTimeout(deadline);
      app.exit(0);
      return;
    }
    const scenarios = [
      { nodes: 1_000, shape: "balanced" },
      { nodes: 5_000, shape: "balanced" },
      { nodes: 10_000, shape: "balanced" },
      { nodes: 25_000, shape: "balanced" },
      { nodes: 10_000, shape: "wide" },
    ];
    const results = [];
    for (let index = 0; index < scenarios.length; index += 1) {
      // Alternate A/B order to reduce a systematic warm-cache advantage.
      const variants = index % 2 === 0 ? ["legacy", "optimized", "virtual"] : ["virtual", "optimized", "legacy"];
      for (const variant of variants) {
        const input = { ...scenarios[index], variant };
        const result = await window.webContents.executeJavaScript(`window.runTreeRenderCase(${JSON.stringify(input)})`);
        results.push(result);
        console.log(`${variant} ${input.shape} ${input.nodes}: mount ${result.mount.medianMs.toFixed(2)} ms, select ${result.selection.medianMs.toFixed(2)} ms`);
      }
    }
    const report = {
      generatedAt: new Date().toISOString(),
      environment: { electron: process.versions.electron, chrome: process.versions.chrome, react: require("react/package.json").version, node: process.version, platform: process.platform, os: release(), arch: process.arch, cpu: cpus()[0]?.model, graphics: "software rendering, matching app flags", sandbox: !diagnosticUnsandboxed, benchmarkZoom: 1, fonts: "Local/system fonts; CSP blocks external font stylesheets" },
      scope: "Production React, real Electron DOM, logically expanded trees. Mount/selection: flushSync + forced layout. Virtual scroll: dispatch to actual window commit + layout, including scheduling. No separate paint measurement; excludes full App panels, ADB, screenshots and native dialogs.",
      sampling: { mountWarmups: 1, mountSamples: 3, selectionWarmups: 2, selectionSamples: 9, unrelatedUpdateSamples: 9, scrollWarmups: 2, scrollSamples: 9 },
      correctness,
      virtualCorrectness,
      virtualZoomChecks,
      results,
    };
    const output = join(outputDirectory, diagnosticUnsandboxed ? "tree-virtual-diagnostic.json" : "tree-virtual.json");
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(`Report: ${output}`);
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error);
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: false, error: String(error), sandbox: !diagnosticUnsandboxed }, null, 2));
    writeFileSync(join(evidence, "failed.png"), (await window.webContents.capturePage()).toPNG());
    console.error(`Benchmark failed. Evidence: ${evidence}; do not treat a failed behavior check as a sandbox startup problem.`);
    clearTimeout(deadline);
    app.exit(1);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
