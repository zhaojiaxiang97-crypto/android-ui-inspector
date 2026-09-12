const { spawn } = require("node:child_process");
const { resolve } = require("node:path");
const { prepareWindowsRuntime } = require("./prepare-windows-runtime.cjs");

if (process.argv.slice(2).some((argument) => argument !== "--dev")) throw new Error("Supported option: --dev");
prepareWindowsRuntime();
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
if (process.argv.includes("--dev")) environment.ELECTRON_RENDERER_URL ||= "http://127.0.0.1:1420";
else delete environment.ELECTRON_RENDERER_URL;
const child = spawn(require("electron"), [resolve(__dirname, "..")], { env: environment, stdio: "inherit", windowsHide: true });
child.once("error", (error) => { console.error(error); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill());
