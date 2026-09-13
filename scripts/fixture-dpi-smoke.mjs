import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const reportRoot = join(project, ".benchmarks", "app-smoke");
const output = join(project, ".benchmarks", "fixture-dpi-smoke", new Date().toISOString().replace(/[:.]/g, "-"));
const scales = [1, 1.25, 1.5];
mkdirSync(output, { recursive: true });

function latestReport(startedAt) {
  const candidate = readdirSync(reportRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(reportRoot, entry.name);
      const resultPath = join(directory, "result.json");
      try {
        const stat = statSync(resultPath);
        return stat.mtimeMs >= startedAt ? { directory, resultPath, mtimeMs: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (!candidate) throw new Error("没有找到 fixture DPI smoke 报告");
  return candidate;
}

async function runScale(scale) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [
    join(project, "scripts", "app-smoke.mjs"),
    "--fixture",
    "--drag-outside",
    "--viewport=1264x816",
    `--scale-factor=${scale}`,
  ], {
    cwd: project,
    env: (() => {
      const environment = { ...process.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      return environment;
    })(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  const report = JSON.parse(readFileSync(latestReport(startedAt).resultPath, "utf8"));
  if (code !== 0 || !report.success) throw new Error(`${scale * 100}% fixture DPI smoke 失败：${report.error ?? stderr.slice(-1200)}`);
  const runPath = join(output, `scale-${String(scale).replace(".", "_")}`);
  mkdirSync(runPath, { recursive: true });
  writeFileSync(join(runPath, "result.json"), JSON.stringify(report, null, 2) + "\n");
  return { scale, devicePixelRatio: report.runtime?.devicePixelRatio, viewport: report.runtime?.viewport, dragOutside: report.dragOutside, sourceReport: latestReport(startedAt).directory };
}

const manifest = { generatedAt: new Date().toISOString(), scope: "Electron force-device-scale-factor + exact viewport proxy; it supplements, but does not replace, a native Windows Settings DPI switch.", scales, success: false, runs: [] };
try {
  for (const scale of scales) {
    const result = await runScale(scale);
    manifest.runs.push(result);
    console.log(`PASS: fixture DPI and outside-drag smoke at ${scale * 100}%`);
  }
  manifest.success = true;
} catch (error) {
  manifest.error = String(error);
  process.exitCode = 1;
  console.error(manifest.error);
} finally {
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ output, ...manifest }, null, 2));
}
