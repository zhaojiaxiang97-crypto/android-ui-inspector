const { execFileSync } = require("node:child_process");
const { delimiter, join } = require("node:path");

function windowsPowerShellEnvironment() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const userProfile = process.env.USERPROFILE;
  const inherited = (process.env.PSModulePath || "")
    .split(delimiter)
    .filter((entry) => /(?:^|[\\/])WindowsPowerShell[\\/]/i.test(entry));
  const defaults = [
    userProfile ? join(userProfile, "Documents", "WindowsPowerShell", "Modules") : null,
    join(programFiles, "WindowsPowerShell", "Modules"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
  ].filter(Boolean);
  const modulePaths = [...new Set([...inherited, ...defaults])];
  return { ...process.env, PSModulePath: modulePaths.join(delimiter) };
}

function prepareWindowsRuntime(target = "Development") {
  if (process.platform !== "win32") return;
  if (!["Development", "Unpacked"].includes(target)) throw new Error("Unexpected runtime target");
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const output = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(__dirname, "windows-runtime-access.ps1"), "-Target", target], {
    encoding: "utf8", windowsHide: true, timeout: 30_000, env: windowsPowerShellEnvironment(),
  });
  console.log(output.trim());
}

module.exports = { prepareWindowsRuntime };
if (require.main === module) prepareWindowsRuntime(process.argv[2]);
