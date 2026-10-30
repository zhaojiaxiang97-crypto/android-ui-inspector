import { build } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const project = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
await build({ configFile: false, root: project, define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: { outDir: ".benchmarks/properties-round4/build", emptyOutDir: false,
    lib: { entry: fileURLToPath(new URL("../benchmarks/properties-round4-entry.tsx", import.meta.url)), name: "PropertiesRound4Checks", formats: ["iife"], fileName: () => "renderer.js", cssFileName: "style" } } });
const output = fileURLToPath(new URL("../.benchmarks/properties-round4/build/", import.meta.url));
mkdirSync(output, { recursive: true });
writeFileSync(`${output}/index.html`, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><script defer src="renderer.js"></script>');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [fileURLToPath(new URL("./properties-round4-checks-main.cjs", import.meta.url))], { cwd: project, env, stdio: "inherit" });
process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
