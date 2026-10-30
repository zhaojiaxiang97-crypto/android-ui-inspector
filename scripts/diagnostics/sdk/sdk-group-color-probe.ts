// Fixed Debug sample only; never installs, restarts or captures the business App.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { validatePairedColorEvidence, type CaptureEvidence } from "../../paired-color-evidence";
import { pixelDifferenceSummary } from "../../../benchmarks/pixel-difference";

const serial = process.argv[2];
const flags = process.argv.slice(3);
const softwareWindow = flags.includes("--software"), extended = flags.includes("--extended");
if (!serial || !/^[\w.:-]+$/.test(serial) || new Set(flags).size !== flags.length || flags.some(flag => !["--software", "--extended"].includes(flag))) throw new Error("Usage: bun scripts/diagnostics/sdk/sdk-group-color-probe.ts SERIAL [--software] [--extended]");
const pkg = "com.androiduiinspector.sample";
const activity = softwareWindow ? "SoftwareGroupColorActivity" : "GroupColorActivity";
const token = randomBytes(8).toString("hex");
const output = join(import.meta.dirname, "../../../.benchmarks/group-color", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 15000, maxBuffer: 2_000_000 });
type Metric = { pixels: number; mismatchedPixels: number; maxChannelDelta: number; alphaMismatches: number };
type Row = { case: string; captures: CaptureEvidence[]; hardwareAccelerated: boolean; ownRepeat: Metric; productionGroupRepeat: Metric;
  composedVsSoftwareGroup: Metric; composedVsMatchedSnapshotGroup: Metric; softwareVsMatchedSnapshotGroup: Metric;
  productionVsMatchedSnapshotGroup: Metric; composedVsProductionGroup: Metric;
  gpuBitmapCompositionVsProductionGroup?: Metric; cpuVsGpuBitmapComposition?: Metric; leafCenterAlpha?: number };
let report: { completed: boolean; probeToken: string; pid: number; activityIdentity: string; captureTask: string; timeBase: string;
  cases: Row[]; transparentTextIsolated: boolean; specialAndOutlineRejected: boolean; error?: string } | undefined;
const artifacts: unknown[] = [];
const pairedDiagnostics: unknown[] = [];
const compositionFailures: string[] = [];
function measure(a: Buffer, b: Buffer): Metric {
  assert.equal(a.length, b.length);
  const result: Metric = { pixels: a.length / 4, mismatchedPixels: 0, maxChannelDelta: 0, alphaMismatches: 0 };
  for (let i = 0; i < a.length; i += 4) {
    let different = false;
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs(a[i + c] - b[i + c]);
      different ||= delta !== 0; result.maxChannelDelta = Math.max(result.maxChannelDelta, delta);
    }
    if (different) result.mismatchedPixels++;
    if (a[i + 3] !== b[i + 3]) result.alphaMismatches++;
  }
  return result;
}
function image(file: string, width: number, height: number) {
  const png = adb("exec-out", "run-as", pkg, "cat", `files/isolation-probe/${file}`);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), width); assert.equal(png.readUInt32BE(20), height);
  writeFileSync(join(output, file), png);
  const rgba = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: png, timeout: 5000, maxBuffer: 200000 });
  assert.equal(rgba.length, width * height * 4);
  artifacts.push({ file, sha256: createHash("sha256").update(png).digest("hex") });
  return rgba;
}
let opened = false;
try {
  adb("shell", "am", "start", "-W", "-n", `${pkg}/.${activity}`, "--es", "probeToken", token, "--ez", "extended", String(extended));
  opened = true;
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    try {
      const candidate = JSON.parse(adb("exec-out", "run-as", pkg, "cat", "files/isolation-probe/group-color.json").toString());
      if (candidate.probeToken === token) { report = candidate; break; }
    } catch { /* Only poll the small report; no recapture or stale report admission. */ }
    await wait(500);
  }
  assert(report, "No fresh report");
  writeFileSync(join(output, "device-report.json"), JSON.stringify(report, null, 2));
  assert.equal(report.completed, true, report.error);
  assert(Number.isSafeInteger(report.pid) && report.pid > 0);
  assert.match(report.activityIdentity, /^[0-9a-f]+$/);
  assert.equal(report.captureTask, "one-main-thread-task-fixed-views-not-simultaneous");
  assert.equal(report.timeBase, "elapsedRealtimeNanos");
  assert.equal(report.transparentTextIsolated, true);
  assert.equal(report.specialAndOutlineRejected, true);
  assert.deepEqual(report.cases.map(row => row.case), ["solid", "gray-vertical", "gray-horizontal", "color-vertical",
    ...(extended ? ["leaf-gradient", "leaf-intrinsic-alpha-gradient", "leaf-view-alpha", "overlapping-alpha"] : [])]);
  for (const [index, row] of report.cases.entries()) {
    assert.equal(row.hardwareAccelerated, !softwareWindow);
    const pair = validatePairedColorEvidence(row.captures, index, row.hardwareAccelerated);
    for (const metric of [row.ownRepeat, row.productionGroupRepeat])
      assert.deepEqual(metric, { pixels: 38400, mismatchedPixels: 0, maxChannelDelta: 0, alphaMismatches: 0 }, "Repeated fixture changed");
    const pixels: Buffer[] = [];
    for (const name of ["composed", "software", "snapshot", "production"]) {
      const file = `group-color-${index}-${name}.png`;
      pixels.push(image(file, 240, 160));
    }
    const parent = image(`group-color-${index}-parent.png`, 240, 160);
    for (let child = 0; child < (index === 7 ? 2 : 1); child++)
      image(`group-color-${index}-child-${child}.png`, 61, 39);
    pairedDiagnostics.push({ case: row.case, ...pair,
      nativeVersusComposed: pixelDifferenceSummary(new Uint8ClampedArray(pixels[3]), new Uint8ClampedArray(pixels[0]),
        240, 160, new Uint8ClampedArray(parent)) });
    for (const [a, b, metric] of [[0, 1, row.composedVsSoftwareGroup], [0, 2, row.composedVsMatchedSnapshotGroup], [1, 2, row.softwareVsMatchedSnapshotGroup], [3, 2, row.productionVsMatchedSnapshotGroup], [0, 3, row.composedVsProductionGroup]] as const) {
      assert.deepEqual(measure(pixels[a], pixels[b]), metric, "Independent PNG decode differs from Android pixel metrics");
    }
    if (extended && index === 5 && !softwareWindow) {
      assert(row.gpuBitmapCompositionVsProductionGroup && row.cpuVsGpuBitmapComposition, "Missing GPU control");
      const gpu = image("group-color-5-gpu-composed.png", 240, 160);
      const leaf = image("group-color-5-leaf.png", 61, 39);
      assert.deepEqual(measure(gpu, pixels[3]), row.gpuBitmapCompositionVsProductionGroup);
      assert.deepEqual(measure(pixels[0], gpu), row.cpuVsGpuBitmapComposition);
      assert.equal(leaf[(19 * 61 + 30) * 4 + 3], row.leafCenterAlpha);
      assert.equal(row.leafCenterAlpha, 128, "Intrinsic alpha acquired an ancestor background");
    }
    assert.deepEqual(row.productionVsMatchedSnapshotGroup, { pixels: 38400, mismatchedPixels: 0, maxChannelDelta: 0, alphaMismatches: 0 }, "Production backend differs from independent snapshot");
    if (row.composedVsProductionGroup.mismatchedPixels || row.composedVsMatchedSnapshotGroup.mismatchedPixels)
      compositionFailures.push(row.case);
    assert.equal(row.composedVsSoftwareGroup.alphaMismatches, 0, "Opaque fixture alpha changed");
    if (index === 0) assert.equal(row.composedVsSoftwareGroup.mismatchedPixels, 0, "Solid-color control differs");
  }
  writeFileSync(join(output, "result.json"), JSON.stringify({ completed: true, softwareWindow, extended, nativeGroupVerified: true,
    localCompositionVerified: compositionFailures.length === 0, sameBackendVerified: compositionFailures.length === 0, compositionFailures,
    softwarePixelsEqual: report.cases.every(row => row.composedVsSoftwareGroup.mismatchedPixels === 0), artifacts, report, pairedDiagnostics,
    scope: "fixed same-task Debug sample; no production behavior or business pixel acceptance" }, null, 2));
  console.log(JSON.stringify({ output, cases: report.cases }));
  assert.equal(compositionFailures.length, 0, `Composition mismatch: ${compositionFailures.join(", ")}`);
} catch (error) {
  writeFileSync(join(output, "failure.json"), JSON.stringify({ completed: false, error: String(error), report, artifacts, pairedDiagnostics }, null, 2));
  throw error;
} finally {
  if (opened && new RegExp(`topResumedActivity=[^\\n]*com\\.androiduiinspector\\.sample/\\.${activity}\\b`).test(adb("shell", "dumpsys", "activity", "activities").toString()))
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
}
