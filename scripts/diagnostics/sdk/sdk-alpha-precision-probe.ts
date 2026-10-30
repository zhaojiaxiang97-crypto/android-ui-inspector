// Debug sample diagnostic only. A completed experiment is not a production pixel pass.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const serial = process.argv[2];
if (!serial || !/^[\w.:-]+$/.test(serial) || process.argv.length !== 3) throw new Error("Usage: bun scripts/diagnostics/sdk/sdk-alpha-precision-probe.ts SERIAL");
const pkg = "com.androiduiinspector.sample", token = randomBytes(8).toString("hex");
const directory = join(import.meta.dirname, "../../../.benchmarks/alpha-precision", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(directory, { recursive: true });
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 15000, maxBuffer: 2_000_000 });
type Metric = { pixels: number; mismatchedPixels: number; maxChannelDelta: number; alphaMismatches: number };
type Row = { case: string; x: number; y: number; groupRepeat: Metric; sdkVsGroup: Metric; f16VsGroup: Metric;
  quantizedVsGroup: Metric; f16VsQuantized: Metric; quantizedLeafVsSdkLeaf: Metric;
  f16RowBytes: number; f16Premultiplied: boolean; f16ByteOrder: string };
let report: { completed: boolean; precisionBackend: string; probeToken: string; cases: Row[]; error?: string } | undefined;
const artifacts: unknown[] = [];
function read(file: string) {
  const bytes = adb("exec-out", "run-as", pkg, "cat", "files/isolation-probe/" + file);
  writeFileSync(join(directory, file), bytes);
  artifacts.push({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  return bytes;
}
function measure(a: Buffer, b: Buffer): Metric {
  assert.equal(a.length, b.length);
  const metric = { pixels: a.length / 4, mismatchedPixels: 0, maxChannelDelta: 0, alphaMismatches: 0 };
  for (let i = 0; i < a.length; i += 4) {
    let changed = false;
    for (let c = 0; c < 4; c++) { const delta = Math.abs(a[i + c] - b[i + c]); changed ||= delta !== 0; metric.maxChannelDelta = Math.max(metric.maxChannelDelta, delta); }
    if (changed) metric.mismatchedPixels++;
    if (a[i + 3] !== b[i + 3]) metric.alphaMismatches++;
  }
  return metric;
}
let opened = false;
try {
  adb("shell", "am", "start", "-W", "-n", `${pkg}/.AlphaPrecisionActivity`, "--es", "probeToken", token); opened = true;
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    try { const candidate = JSON.parse(adb("exec-out", "run-as", pkg, "cat", "files/isolation-probe/alpha-precision.json").toString());
      if (candidate.probeToken === token) { report = candidate; break; } } catch { /* Only poll report; never recapture. */ }
    await wait(500);
  }
  assert(report, "No fresh report");
  writeFileSync(join(directory, "device-report.json"), JSON.stringify(report, null, 2));
  assert.equal(report.completed, true, report.error);
  assert.equal(report.precisionBackend, "software-Canvas-RGBA_F16");
  assert.deepEqual(report.cases.map(row => row.case), ["gray-origin", "gray-offset", "gray-shifted", "transparent", "white", "black", "constant-alpha", "opaque-gradient"]);
  let grayResidual: number[] | undefined;
  for (const [index, row] of report.cases.entries()) {
    assert.equal(row.x, index === 0 ? 0 : index === 2 ? 32 : 31);
    assert.equal(row.y, index === 0 ? 0 : index === 2 ? 44 : 43);
    assert.deepEqual(row.groupRepeat, { pixels: 38400, mismatchedPixels: 0, maxChannelDelta: 0, alphaMismatches: 0 });
    const decoded: Buffer[] = [];
    for (const name of ["group", "sdk", "f16", "quantized"]) {
      const png = read(`alpha-${index}-${name}.png`);
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(png.readUInt32BE(16), 240); assert.equal(png.readUInt32BE(20), 160);
      const rgba = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { input: png, timeout: 5000, maxBuffer: 200000 });
      assert.equal(rgba.length, 38400 * 4); decoded.push(rgba);
    }
    for (const [a, b, expected] of [[1, 0, row.sdkVsGroup], [2, 0, row.f16VsGroup], [3, 0, row.quantizedVsGroup], [2, 3, row.f16VsQuantized]] as const)
      assert.deepEqual(measure(decoded[a], decoded[b]), expected, "PNG decode does not confirm device statistics");
    if (index < 3) {
      const residual: number[] = [];
      for (let y = 0; y < 39; y++) for (let x = 0; x < 61; x++) for (let c = 0; c < 4; c++) {
        const offset = ((y + row.y) * 240 + x + row.x) * 4 + c;
        residual.push(decoded[1][offset] - decoded[0][offset]);
      }
      if (grayResidual) assert.deepEqual(residual, grayResidual, "Moving the child changed the residual pattern");
      else grayResidual = residual;
    }
    const raw = read(`alpha-${index}.f16`);
    assert.equal(row.f16Premultiplied, true); assert.equal(row.f16ByteOrder, "LITTLE_ENDIAN");
    assert(Number.isSafeInteger(row.f16RowBytes) && row.f16RowBytes >= 61 * 8 && row.f16RowBytes <= 1024);
    assert.equal(raw.length, row.f16RowBytes * 39);
  }
  writeFileSync(join(directory, "result.json"), JSON.stringify({ diagnosticValidated: true, report, artifacts,
    grayPositionResidualsIdentical: true,
    strictLocalCompositionPassed: report.cases.every(row => row.sdkVsGroup.mismatchedPixels === 0),
    scope: "fixed Debug sample; software F16 control is not hardware precision proof or a production transport change" }, null, 2));
  console.log(JSON.stringify({ directory, cases: report.cases }));
} catch (error) {
  writeFileSync(join(directory, "failure.json"), JSON.stringify({ diagnosticValidated: false, error: String(error), report, artifacts }, null, 2)); throw error;
} finally {
  if (opened && /topResumedActivity=[^\n]*com\.androiduiinspector\.sample\/\.AlphaPrecisionActivity\b/.test(adb("shell", "dumpsys", "activity", "activities").toString()))
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
}
