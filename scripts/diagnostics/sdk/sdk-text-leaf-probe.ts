// Fixed Debug sample only. Does not install, restart or query business SDK.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
const serial = process.argv[2], software = process.argv[3] === "--software";
if (!serial || !/^[\w.:-]+$/.test(serial) || process.argv.length > 4 || (process.argv[3] && !software))
  throw new Error("Usage: bun scripts/diagnostics/sdk/sdk-text-leaf-probe.ts SERIAL [--software]");
const pkg = "com.androiduiinspector.sample", activity = software ? "SoftwareTextActivity" : "HardwareTextActivity";
const token = randomBytes(8).toString("hex");
const output = join(import.meta.dirname, "../../../.benchmarks/text-leaf", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 15000, maxBuffer: 4_000_000 });
let report: any, opened = false;
const artifacts: unknown[] = [];
try {
  adb("shell", "am", "start", "-W", "-n", `${pkg}/.${activity}`, "--es", "leafProbeToken", token); opened = true;
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    try { const value = JSON.parse(adb("exec-out", "run-as", pkg, "cat", "files/isolation-probe/text-leaf.json").toString());
      if (value.probeToken === token) { report = value; break; } } catch { /* Never recapture while polling. */ }
    await wait(500);
  }
  assert(report, "No fresh report"); writeFileSync(join(output, "device-report.json"), JSON.stringify(report, null, 2));
  assert.equal(report.completed, true, report.error); assert.equal(report.hardwareAccelerated, !software);
  assert.equal(report.parentOwnIsolated, true);
  assert.deepEqual(report.cases.map((row: any) => row.case), ["normal-text", "software-layer-text"]);
  for (const [index, row] of report.cases.entries()) {
    assert.equal(row.hardwareAccelerated, !software); assert.equal(row.layerType, index === 0 ? 0 : 1);
    assert.equal(row.ownVsMatched, 0); assert.equal(row.cornerAlpha, 0); assert.equal(row.foreignColorPixels, 0);
    assert(row.visiblePixels > 0 && Number.isSafeInteger(row.width) && Number.isSafeInteger(row.height));
    assert(row.width > 0 && row.height > 0 && row.width * row.height <= 4_000_000);
    for (const values of [row.ownNanos, row.directNanos]) {
      assert.equal(values.length, 3); for (const value of values) assert(Number.isSafeInteger(value) && value > 0);
    }
    const decoded: Buffer[] = [];
    for (const route of ["own", "matched", "direct"]) {
      const name = `text-leaf-${index}-${route}.png`;
      const png = adb("exec-out", "run-as", pkg, "cat", "files/isolation-probe/" + name);
      writeFileSync(join(output, name), png); artifacts.push({ name, sha256: createHash("sha256").update(png).digest("hex") });
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(png.readUInt32BE(16), row.width); assert.equal(png.readUInt32BE(20), row.height);
      const pixels = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
        { input: png, timeout: 5000, maxBuffer: 16_000_000 });
      assert.equal(pixels.length, row.width * row.height * 4); decoded.push(pixels);
    }
    assert(decoded[0].equals(decoded[1]), "Independent PNG comparison failed");
    let visible = 0, foreign = 0, oldMismatch = 0;
    for (let i = 0; i < decoded[0].length; i += 4) {
      const alpha = decoded[0][i + 3];
      if (alpha) {
        visible++; const expected = Math.round(34 * alpha / 255);
        if ([0, 1, 2].some(c => Math.abs(Math.round(decoded[0][i + c] * alpha / 255) - expected) > 1)) foreign++;
      }
      if (!decoded[0].subarray(i, i + 4).equals(decoded[2].subarray(i, i + 4))) oldMismatch++;
    }
    assert.equal(visible, row.visiblePixels); assert.equal(foreign, 0); assert.equal(oldMismatch, row.ownVsOldDirect);
    row.ownMilliseconds = row.ownNanos.map((n: number) => n / 1e6);
    row.directMilliseconds = row.directNanos.map((n: number) => n / 1e6);
  }
  writeFileSync(join(output, "result.json"), JSON.stringify({ passed: true, report, artifacts,
    scope: "fixed sample isolation and UI capture only; three samples include cold result; no transport or business performance claim" }, null, 2));
  console.log(JSON.stringify({ output, report }));
} catch (error) {
  writeFileSync(join(output, "failure.json"), JSON.stringify({ passed: false, error: String(error), report, artifacts }, null, 2)); throw error;
} finally {
  if (opened && new RegExp(`topResumedActivity=[^\\n]*com\\.androiduiinspector\\.sample/\\.${activity}\\b`).test(adb("shell", "dumpsys", "activity", "activities").toString()))
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
}
