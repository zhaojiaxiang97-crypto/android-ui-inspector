import { build } from "vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const project = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
await build({ configFile: false, root: project, define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: { outDir: ".benchmarks/canvas-round4/build", emptyOutDir: false,
    lib: { entry: fileURLToPath(new URL("../benchmarks/canvas-round4-entry.tsx", import.meta.url)), name: "CanvasRound4Checks", formats: ["iife"], fileName: () => "renderer.js", cssFileName: "style" } } });
const output = fileURLToPath(new URL("../.benchmarks/canvas-round4/build/", import.meta.url)); mkdirSync(output, { recursive: true });
writeFileSync(`${output}/index.html`, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; img-src \'self\' data:; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="style.css"><script defer src="renderer.js"></script></html>');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [fileURLToPath(new URL("./canvas-round4-checks-main.cjs", import.meta.url))], { cwd: project, env, stdio: "inherit" });
process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
