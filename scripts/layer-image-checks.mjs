import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWebpAlpha } from "./build-webp-alpha.mjs";

// No BrowserWindow, device API, input, or network calls: just the production image processor.
const project = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
await mkdir(join(project, ".benchmarks"), { recursive: true });
const output = await mkdtemp(join(project, ".benchmarks/layer-image-checks-"));
await buildWebpAlpha(output);
const bundle = spawnSync("bun", ["build", "tests/layer-images-electron.ts", "--target", "node", "--format", "cjs",
  "--external", "electron", "--external", "sharp", "--outfile", join(output, "checks.cjs")], { cwd: project, stdio: "inherit" });
if (bundle.error || bundle.status !== 0) throw bundle.error ?? new Error("Image checks build failed");
const env = { ...process.env, ALPHA_TEST_OUTPUT_DIR: output }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [join(project, "scripts/layer-image-checks-main.cjs")], { cwd: project, env, stdio: "inherit", windowsHide: true });
process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
