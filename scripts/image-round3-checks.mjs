import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
const require = createRequire(import.meta.url), project = fileURLToPath(new URL("../", import.meta.url));
await build({ configFile: false, root: project, define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: { outDir: ".benchmarks/image-round3", emptyOutDir: true,
    lib: { entry: fileURLToPath(new URL("../benchmarks/image-round3-checks.tsx", import.meta.url)), name: "ImageRound3Checks", formats: ["iife"], fileName: () => "renderer.js", cssFileName: "style" } } });
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [fileURLToPath(new URL("./image-round3-checks-main.cjs", import.meta.url))], { cwd: project, env: environment, stdio: "inherit", windowsHide: true });
process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
