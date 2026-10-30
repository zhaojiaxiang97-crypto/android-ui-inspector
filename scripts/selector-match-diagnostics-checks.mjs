import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";

const project = fileURLToPath(new URL("../", import.meta.url));
const output = join(project, ".benchmarks", "selector-match-diagnostics");
mkdirSync(output, { recursive: true });
await build({ configFile: false, root: project, define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: { outDir: output, emptyOutDir: false, lib: { entry: join(project, "benchmarks", "selector-match-diagnostics-checks.tsx"),
    name: "SelectorMatchDiagnosticsChecks", formats: ["iife"], fileName: () => "renderer.js", cssFileName: "style" } } });
writeFileSync(join(output, "index.html"), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="style.css"></head><body><script src="renderer.js"></script></body></html>');
const require = createRequire(import.meta.url), environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [join(project, "scripts", "selector-match-diagnostics-checks-main.cjs"), output],
  { cwd: project, env: environment, stdio: "inherit", windowsHide: true });
process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
