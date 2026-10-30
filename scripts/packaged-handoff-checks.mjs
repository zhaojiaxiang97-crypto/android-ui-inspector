import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
require("./lib/packaged-check-evidence.cjs").parseArgs(process.argv.slice(2));
require("./prepare-windows-runtime.cjs").prepareWindowsRuntime();
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const child = spawn(require("electron"), [fileURLToPath(new URL("./packaged-handoff-checks.cjs", import.meta.url)), ...process.argv.slice(2)],
  { env, stdio: "inherit", windowsHide: true });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
