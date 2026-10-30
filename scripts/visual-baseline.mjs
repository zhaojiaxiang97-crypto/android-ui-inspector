import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const options = process.argv.slice(2).filter((argument) => argument !== "--");
if (options.length > 1 || options.some((argument) => !["--home", "--home-states"].includes(argument))) {
  throw new Error("Supported options: --home | --home-states");
}
const homeOnly = options.length > 0;
const allHomeStates = options.includes("--home-states");
const states = allHomeStates ? ["connected", "loading", "unauthorized", "empty", "adb-missing"] : ["connected"];
const reportRoot = join(project, ".benchmarks", "app-smoke");
const outputName = allHomeStates ? "home-state-visual-baseline" : homeOnly ? "home-visual-baseline" : "visual-baseline";
const output = join(project, ".benchmarks", outputName, new Date().toISOString().replace(/[:.]/g, "-"));
const runner = process.versions.bun ? process.execPath : "bun";
const viewports = [
  { width: 1264, height: 816 },
  { width: 1440, height: 900 },
  { width: 1587, height: 1000 },
];

mkdirSync(output, { recursive: true });

function latestReport(startedAt, fixtureState, viewport) {
  const candidates = readdirSync(reportRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(reportRoot, entry.name);
      const resultPath = join(directory, "result.json");
      try {
        const stat = statSync(resultPath);
        const result = JSON.parse(readFileSync(resultPath, "utf8"));
        return stat.mtimeMs >= startedAt && result.fixture && result.homeOnly === homeOnly && result.reducedMotion === allHomeStates
          && result.fixtureState === fixtureState && result.requestedViewport?.width === viewport.width
          && result.requestedViewport?.height === viewport.height
          ? { directory, result, mtimeMs: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter((value) => value !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (!candidates) throw new Error(`没有找到匹配 ${fixtureState} ${viewport.width}x${viewport.height} 的视觉基线 smoke 报告`);
  return candidates;
}

async function runCase(fixtureState, viewport) {
  const startedAt = Date.now();
  const args = [join(project, "scripts", "app-smoke.mjs"), "--fixture", `--viewport=${viewport.width}x${viewport.height}`,
    ...(homeOnly ? ["--home-only"] : []),
    ...(allHomeStates ? ["--reduced-motion", `--fixture-state=${fixtureState}`] : []),
  ];
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(runner, args, {
    cwd: project,
    env: environment,
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
  let report;
  try {
    report = latestReport(startedAt, fixtureState, viewport);
  } catch (error) {
    throw new Error(`${error.message}：${stderr.slice(-1200) || stdout.slice(-1200)}`);
  }
  const result = report.result;
  if (code !== 0 || !result.success) {
    throw new Error(`${fixtureState} ${viewport.width}x${viewport.height} 视觉基线失败：${result.error ?? (stderr.slice(-1200) || stdout.slice(-1200))}`);
  }
  const name = `${allHomeStates ? `state-${fixtureState}/` : ""}viewport-${viewport.width}x${viewport.height}`;
  mkdirSync(join(output, name), { recursive: true });
  const screenshots = homeOnly ? ["home.png"] : ["app.png", "layers3d.png"];
  for (const screenshot of screenshots) copyFileSync(join(report.directory, screenshot), join(output, name, screenshot));
  writeFileSync(join(output, name, "result.json"), JSON.stringify(result, null, 2) + "\n");
  return {
    viewport,
    ...(allHomeStates ? { fixtureState } : {}),
    sourceReport: report.directory,
    artifacts: [...screenshots, "result.json"].map((file) => `${name}/${file}`).join(", "),
    ...(homeOnly ? { homeLayout: result.homeLayout } : { workspaceLayout: result.workspaceLayout, screenshot: result.screenshot }),
  };
}

const manifest = {
  generatedAt: new Date().toISOString(),
  source: {
    hierarchy: "tests/fixtures/uiautomator-portrait.xml",
    screenshot: "tests/fixtures/visual-screen.svg",
    ...(homeOnly ? { mode: "home-only" } : { coordinateSpace: { width: 1080, height: 2400 } }),
  },
  ...(allHomeStates ? { states } : {}),
  viewports,
  success: false,
  runs: [],
};

try {
  for (const fixtureState of states) {
    for (const viewport of viewports) {
      manifest.runs.push(await runCase(fixtureState, viewport));
      console.log(`PASS: ${outputName} ${fixtureState} ${viewport.width}x${viewport.height}`);
    }
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
