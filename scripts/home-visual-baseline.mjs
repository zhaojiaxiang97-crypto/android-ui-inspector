import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const reportRoot = join(project, ".benchmarks", "app-smoke");
const output = join(project, ".benchmarks", "home-visual-baseline", new Date().toISOString().replace(/[:.]/g, "-"));
const viewports = [
  { width: 1264, height: 816 },
  { width: 1440, height: 900 },
  { width: 1587, height: 1000 },
];

mkdirSync(output, { recursive: true });

function latestReport(startedAt) {
  const candidates = readdirSync(reportRoot, { withFileTypes: true })
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
  if (!candidates) throw new Error("没有找到首页视觉基线 smoke 报告");
  return candidates;
}

async function runViewport(viewport) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [
    join(project, "scripts", "app-smoke.mjs"),
    "--fixture",
    "--home-only",
    `--viewport=${viewport.width}x${viewport.height}`,
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
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  const report = latestReport(startedAt);
  const result = JSON.parse(readFileSync(report.resultPath, "utf8"));
  if (code !== 0 || !result.success) {
    throw new Error(`${viewport.width}x${viewport.height} 首页视觉基线失败：${result.error ?? (stderr.slice(-1200) || stdout.slice(-1200))}`);
  }
  const name = `viewport-${viewport.width}x${viewport.height}`;
  mkdirSync(join(output, name), { recursive: true });
  copyFileSync(join(report.directory, "home.png"), join(output, name, "home.png"));
  writeFileSync(join(output, name, "result.json"), JSON.stringify(result, null, 2) + "\n");
  return {
    viewport,
    report: result,
    sourceReport: report.directory,
    artifacts: `${name}/home.png, ${name}/result.json`,
  };
}

const manifest = {
  generatedAt: new Date().toISOString(),
  source: {
    hierarchy: "tests/fixtures/uiautomator-portrait.xml",
    screenshot: "tests/fixtures/visual-screen.svg",
    mode: "home-only",
  },
  viewports,
  success: false,
  runs: [],
};

try {
  for (const viewport of viewports) {
    const run = await runViewport(viewport);
    manifest.runs.push({
      viewport: run.viewport,
      sourceReport: run.sourceReport,
      artifacts: run.artifacts,
      homeLayout: run.report.homeLayout,
    });
    console.log(`PASS: minimal home visual baseline ${viewport.width}x${viewport.height}`);
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
