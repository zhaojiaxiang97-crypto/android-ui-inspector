import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";
const require = createRequire(import.meta.url), project = fileURLToPath(new URL("../", import.meta.url));
require("./prepare-windows-runtime.cjs").prepareWindowsRuntime();
const output = join(project, ".benchmarks/workbench-controllers"); mkdirSync(output, { recursive: true });
await build({ configFile: false, root: project, define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: { outDir: output, emptyOutDir: false, lib: { entry: join(project, "benchmarks/workbench-controller-entry.tsx"), name: "WorkbenchControllers", formats: ["iife"], fileName: () => "renderer.js", cssFileName: "style" } } });
writeFileSync(join(output, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><script src="renderer.js"></script></body></html>');
writeFileSync(join(output, "runner.cjs"), `const { app, BrowserWindow } = require("electron");
const { writeFileSync, mkdtempSync } = require("node:fs"); const { join } = require("node:path");
app.setPath("userData", mkdtempSync(join(__dirname, "profile-")));
const deadline = setTimeout(() => app.exit(1), 45000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const report = { passed: false, fixtureOnly: true, errors: [], runs: [] };
  window.webContents.on("console-message", details => { if (details.level === "error") report.errors.push(details.message); });
  try {
    for (const [width, height] of [[1440, 900], [1024, 768], [900, 680]]) {
      window.setContentSize(width, height); await window.loadFile(join(__dirname, "index.html"));
      report.runs.push({ width, height, ...await window.webContents.executeJavaScript("window.verifyWorkbenchControllers()") });
    }
    if (report.errors.length) throw new Error(report.errors.join("\\n"));
    report.passed = true;
  } catch (error) { report.error = String(error); }
  finally { clearTimeout(deadline); writeFileSync(join(__dirname, "result.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); app.exit(report.passed ? 0 : 1); }
}).catch(error => { console.error(error); app.exit(1); });`);
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [join(output, "runner.cjs")], { cwd: project, env: environment, stdio: "inherit", windowsHide: true });
process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
