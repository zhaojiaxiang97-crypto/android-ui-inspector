const { app } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const output = process.env.ALPHA_TEST_OUTPUT_DIR;
if (!output) throw new Error("Missing isolated image test directory");
app.setPath("userData", join(output, "profile"));
const deadline = setTimeout(() => app.exit(1), 15000);
app.whenReady().then(async () => {
  try {
    const report = { passed: true, scope: "production PNG/WebP alpha, isolated Electron, no window/device/input/network",
      electron: process.versions.electron, checks: await require(join(output, "checks.cjs")).verifyLayerImages(join(output, "webp-alpha-worker.cjs")) };
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); clearTimeout(deadline); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
});
