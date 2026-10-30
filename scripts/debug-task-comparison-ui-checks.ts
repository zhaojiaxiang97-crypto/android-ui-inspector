import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { comparisonDefinition, makeDebugTaskComparisonFixture } from "../tests/fixtures/debug-task-comparison";
import { makeDebugReportExportFixture } from "../tests/fixtures/debug-report-export";
import { loadTestReport } from "../electron/desktop/test-report";

const require = createRequire(import.meta.url), project = fileURLToPath(new URL("../", import.meta.url));
require("./prepare-windows-runtime.cjs").prepareWindowsRuntime();
const base = join(project, ".benchmarks", "debug-task-comparison-ui"); mkdirSync(base, { recursive: true });
const evidence = mkdtempSync(join(base, "run-")), definition = comparisonDefinition(); definition.finalConditions[0].selector.text = "定义已改";
const finalDefinition = comparisonDefinition(); finalDefinition.checkpoints[0].id = "final";
const fixtures = { primary: makeDebugTaskComparisonFixture({ base: evidence }), same: makeDebugTaskComparisonFixture({ base: evidence, seed: 1000, serial: "second-device", scale: 2 }),
  mismatch: makeDebugTaskComparisonFixture({ base: evidence, seed: 2000, definition }), missing: makeDebugTaskComparisonFixture({ base: evidence, seed: 3000 }),
  unchecked: makeDebugTaskComparisonFixture({ base: evidence, seed: 4000 }), stageFinal: makeDebugTaskComparisonFixture({ base: evidence, seed: 5000, definition: finalDefinition }) };
const old = await makeDebugReportExportFixture(evidence);
try {
  fixtures.primary.complete(); fixtures.same.complete(true); fixtures.mismatch.complete(); fixtures.stageFinal.complete();
  const missing = fixtures.missing.complete();
  rmSync(join(fixtures.missing.directory, fixtures.missing.report.snapshots.find(snapshot => snapshot.snapshotId === missing.observations.second!.snapshotId)!.tree!.path));
  fixtures.unchecked.addCheck("settings");
  const loaded = Object.fromEntries(await Promise.all(Object.entries(fixtures).map(async ([name, fixture]) => [name, await fixture.load()])));
  writeFileSync(join(evidence, "fixtures.json"), JSON.stringify({ ...loaded, noTask: await loadTestReport(old.file) }));
  await build({ configFile: false, root: project, define: { "process.env.NODE_ENV": JSON.stringify("production") }, build: { outDir: join(base, "render"), emptyOutDir: true,
    lib: { entry: join(project, "benchmarks", "debug-task-comparison-entry.tsx"), name: "DebugTaskComparisonUI", formats: ["iife"], fileName: () => "renderer.js", cssFileName: "style" } } });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [join(project, "scripts", "debug-task-comparison-ui-main.cjs"), evidence], { cwd: project, env, stdio: "inherit", windowsHide: true });
  process.exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
} finally { Object.values(fixtures).forEach(fixture => fixture.cleanup()); old.cleanup(); }
