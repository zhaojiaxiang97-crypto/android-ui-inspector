const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

function prepareLinuxSandbox(executable) {
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true") return;
  const sandbox = join(dirname(executable), "chrome-sandbox");
  if (!existsSync(sandbox)) throw new Error(`Electron sandbox not found: ${sandbox}`);
  execFileSync("sudo", ["chown", "root:root", sandbox], { stdio: "inherit" });
  execFileSync("sudo", ["chmod", "4755", sandbox], { stdio: "inherit" });
}
module.exports = { prepareLinuxSandbox };

if (require.main === module) {
  // Resolve/download before Windows permission checks or Electron-based tests.
  const executable = require("electron");
  if (!existsSync(executable)) throw new Error(`Electron runtime not found: ${executable}`);
  prepareLinuxSandbox(executable);
  require("./prepare-windows-runtime.cjs").prepareWindowsRuntime();
}
