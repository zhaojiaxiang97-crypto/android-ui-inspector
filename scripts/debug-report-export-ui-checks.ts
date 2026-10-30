import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { makeDebugReportExportFixture } from "../tests/fixtures/debug-report-export";
import { loadTestReport } from "../electron/desktop/test-report";

const require = createRequire(import.meta.url), project = fileURLToPath(new URL("../", import.meta.url));
require("./prepare-windows-runtime.cjs").prepareWindowsRuntime();
const base = join(project, ".benchmarks", "debug-report-export-ui"); mkdirSync(base, { recursive: true });
const evidence = mkdtempSync(join(base, "run-")), fixture = await makeDebugReportExportFixture(evidence);
try {
  const loaded = await loadTestReport(fixture.file);
  writeFileSync(join(evidence, "fixture.json"), JSON.stringify({ report: loaded, canceled: false, error: null, exportSourceId: "fixture-owned-source" }));
  await build({ configFile: false, root: project, define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { outDir: join(base, "render"), emptyOutDir: true,
      lib: { entry: join(project, "benchmarks", "debug-report-export-entry.tsx"), name: "DebugReportExportUI", formats: ["iife"], fileName: () => "renderer.js", cssFileName: "style" } } });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [join(project, "scripts", "debug-report-export-ui-main.cjs"), evidence], { cwd: project, env, stdio: "inherit", windowsHide: true });
  process.exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
} finally { fixture.cleanup(); }
