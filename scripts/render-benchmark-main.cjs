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
app.setPath("userData", mkdtempSync(join(outputDirectory, "electron-profile-")));
app.commandLine.appendSwitch("enable-logging");
app.commandLine.appendSwitch("log-file", join(outputDirectory, "electron-render.log"));
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
    if (checksOnly) {
      writeFileSync(join(outputDirectory, diagnosticUnsandboxed ? "tree-behavior-diagnostic.json" : "tree-behavior.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sandbox: !diagnosticUnsandboxed, correctness, virtualCorrectness, virtualZoomChecks }, null, 2) + "\n");
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
    console.error("Benchmark failed. Inspect the failing assertion and .benchmarks/electron-render.log; do not treat a failed behavior check as a sandbox startup problem.");
    clearTimeout(deadline);
    app.exit(1);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
