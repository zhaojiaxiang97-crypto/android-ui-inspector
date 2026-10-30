// Fixed hardware sample only; candidate is not a production SDK switch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
const serial = process.argv[2];
const reuseFirst = process.argv[3] === "--reuse-first";
if (!serial || !/^[\w.:-]+$/.test(serial) || process.argv.length > 4 || (process.argv[3] && !reuseFirst))
  throw new Error("Usage: bun scripts/diagnostics/sdk/sdk-text-reuse-probe.ts SERIAL [--reuse-first]");
const pkg = "com.androiduiinspector.sample", token = randomBytes(8).toString("hex");
const output = join(import.meta.dirname, "../../../.benchmarks/text-reuse", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 15000, maxBuffer: 4_000_000 });
let report: any, opened = false;
const artifacts: unknown[] = [];
try {
  adb("shell", "am", "force-stop", pkg); // Only restart the independent sample, never the business App.
  adb("shell", "am", "start", "-W", "-n", `${pkg}/.HardwareTextActivity`, "--es", "leafProbeToken", token, "--ez", "leafReuse", "true",
    "--ez", "leafReuseFirst", String(reuseFirst)); opened = true;
  const deadline = performance.now() + 45000;
  while (performance.now() < deadline) {
    try { const value = JSON.parse(adb("exec-out", "run-as", pkg, "cat", "files/isolation-probe/text-reuse.json").toString());
      if (value.probeToken === token) { report = value; break; } } catch { /* No recapture, no stale token admission. */ }
    await wait(500);
  }
  assert(report, "No fresh report"); writeFileSync(join(output, "device-report.json"), JSON.stringify(report, null, 2));
  assert.equal(report.captureOrder, reuseFirst ? "B-A-A-B-B-A" : "A-B-B-A-A-B");
  // Preserve independently decoded evidence even if the device rejects pixel equality.
  assert.deepEqual(report.cases.map((row: any) => row.case), ["normal-text", "software-layer-text"]);
  for (const [index, row] of report.cases.entries()) {
    assert.equal(row.layerType, index === 0 ? 0 : 1);
    assert(Number.isSafeInteger(row.width) && Number.isSafeInteger(row.height) && row.width > 0 && row.height > 0 && row.width * row.height <= 4_000_000);
    for (const values of [row.ownNanos, row.reuseNanos]) {
      assert.equal(values.length, 3); for (const value of values) assert(Number.isSafeInteger(value) && value > 0);
    }
    const decoded: Buffer[] = [];
    for (const route of ["own", "reuse"]) {
      const name = `text-reuse-${index}-${route}.png`, png = adb("exec-out", "run-as", pkg, "cat", "files/isolation-probe/" + name);
      writeFileSync(join(output, name), png); artifacts.push({ name, sha256: createHash("sha256").update(png).digest("hex") });
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(png.readUInt32BE(16), row.width); assert.equal(png.readUInt32BE(20), row.height);
      const pixels = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: png, timeout: 5000, maxBuffer: 16_000_000 });
      assert.equal(pixels.length, row.width * row.height * 4); decoded.push(pixels);
    }
    let different = 0;
    for (let i = 0; i < decoded[0].length; i += 4) if (!decoded[0].subarray(i, i + 4).equals(decoded[1].subarray(i, i + 4))) different++;
    assert.equal(different, row.reuseVsOwn, "PNG decode differs from device metric");
    row.ownMilliseconds = row.ownNanos.map((n: number) => n / 1e6);
    row.reuseMilliseconds = row.reuseNanos.map((n: number) => n / 1e6);
  }
  assert.equal(report.completed, true, report.error); assert.equal(report.rendererClosed, true);
  assert.equal(report.detachedPixelsVerified, true); assert.equal(report.creations, 1); assert.equal(report.captures, 6);
  assert(report.cases.every((row: any) => row.reuseVsOwn === 0));
  assert.equal(report.safety.resourcesClosed, true); assert.equal(report.safety.recoveredPixelsVerified, true);
  assert.deepEqual(report.safety.cases.map((row: any) => row.case), ["wrong-size", "occupied-image-reentry-close", "readback-failure", "closed-renderer", "cancel-before", "cancel-active", "timeout-late"]);
  for (const row of report.safety.cases) assert.equal(row.rejected, true);
  for (const row of report.safety.cases.slice(1, 3)) assert.equal(row.imageReleased, true);
  for (const row of report.safety.cases.slice(4)) {
    assert.equal(row.callerStopped, true); assert.equal(row.resourcesClosed, true);
    assert.equal(row.lateResultsRecycled, row.case === "cancel-before" ? 0 : 1);
  }
  writeFileSync(join(output, "result.json"), JSON.stringify({ passed: true, report, artifacts,
    scope: "fixed sample UI capture/readback and fault cleanup; first samples retained, no business/transport performance claim" }, null, 2));
  console.log(JSON.stringify({ output, report }));
} catch (error) {
  writeFileSync(join(output, "failure.json"), JSON.stringify({ passed: false, error: String(error), report, artifacts }, null, 2)); throw error;
} finally {
  if (opened && /topResumedActivity=[^\n]*com\.androiduiinspector\.sample\/\.HardwareTextActivity\b/.test(adb("shell", "dumpsys", "activity", "activities").toString()))
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
}
