import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const directory = fileURLToPath(new URL("../.benchmarks/startup/", import.meta.url));
const run = new Date().toISOString().replace(/[:.]/g, "-");
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ["legacy", "default", "software", "no-in-process"];
for (const mode of modes) {
  if (!["legacy", "default", "software", "no-in-process"].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  const output = join(directory, run, mode);
  mkdirSync(output, { recursive: true });
  const environment = { ...process.env, INSPECTOR_PROBE_OUTPUT: output };
  delete environment.ELECTRON_RUN_AS_NODE;
  const stdout = createWriteStream(join(output, "stdout.log"));
  const stderr = createWriteStream(join(output, "stderr.log"));
  const child = spawn(require("electron"), ["--enable-logging=stderr", "--v=1", fileURLToPath(new URL("startup-probe-main.cjs", import.meta.url)), `--probe-mode=${mode}`], { env: environment, windowsHide: true });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  try {
    const result = JSON.parse(readFileSync(join(output, "result.json"), "utf8"));
    console.log(JSON.stringify({ output, code, result }));
    if (code !== 0 || !result.success) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ output, code, result: "No report, inspect stderr.log" }));
    process.exitCode = 1;
  }
}
