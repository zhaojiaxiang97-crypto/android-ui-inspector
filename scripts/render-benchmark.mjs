import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const require = createRequire(import.meta.url);
require("./prepare-windows-runtime.cjs").prepareWindowsRuntime();
const project = fileURLToPath(new URL("../", import.meta.url));
const extraArguments = process.argv.slice(2).filter((argument) => argument !== "--");
if (extraArguments.some((argument) => !["--diagnostic-unsandboxed", "--checks-only"].includes(argument))) throw new Error("Supported options: --diagnostic-unsandboxed --checks-only");
await build({
  configFile: false,
  root: project,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: ".benchmarks/render",
    emptyOutDir: false,
    lib: { entry: fileURLToPath(new URL("../benchmarks/render-entry.tsx", import.meta.url)), name: "TreeRenderBenchmark", formats: ["iife"], fileName: () => "renderer.js", cssFileName: "style" },
  },
});

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [fileURLToPath(new URL("./render-benchmark-main.cjs", import.meta.url)), ...extraArguments], {
  cwd: project,
  env: environment,
  stdio: "inherit",
  windowsHide: true,
});
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (status) => resolve(status ?? 1));
});
process.exitCode = code;
