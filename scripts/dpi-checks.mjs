import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const project = fileURLToPath(new URL("../", import.meta.url));
const main = fileURLToPath(new URL("./dpi-checks-main.cjs", import.meta.url));
const factors = [1, 1.25, 1.5];
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

let failed = false;
for (const factor of factors) {
  console.log(`DPI proxy check at ${factor * 100}%`);
  const child = spawn(require("electron"), [main, `--scale-factor=${factor}`], {
    cwd: project,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
  if (code !== 0) failed = true;
}

process.exitCode = failed ? 1 : 0;
