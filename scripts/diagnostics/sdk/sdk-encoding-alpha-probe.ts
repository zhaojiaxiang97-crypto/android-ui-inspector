// Independent sample only. Same immutable bitmap encoded twice; no business capture or install.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const serial = process.argv[2];
assert.ok(serial && /^[\w.:-]+$/.test(serial), "Usage: bun scripts/diagnostics/sdk/sdk-encoding-alpha-probe.ts SERIAL");
const existingToken = process.argv.find(value => value.startsWith("--existing-token="))?.slice("--existing-token=".length);
if (existingToken) assert.match(existingToken, /^[0-9a-f-]{36}$/i);
const pkg = "com.androiduiinspector.sample", token = existingToken ?? randomUUID();
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 15000, maxBuffer: 16_000_000 });
const base = join(import.meta.dirname, "../../../.benchmarks"); mkdirSync(base, { recursive: true });
const output = mkdtempSync(join(base, "encoding-alpha-"));
console.log(`Encoding/alpha probe: ${output}`);
const previous = /(?:mResumedActivity:|topResumedActivity=).*?\s([\w.]+\/[\w.$]+)\s/.exec(adb("shell", "dumpsys", "activity", "activities").toString())?.[1];
let device: any;
const rows: unknown[] = [];
const save = (extra: object) => writeFileSync(join(output, "report.json"), JSON.stringify({ token, device, rows,
  scope: "same immutable sample bitmap encoding and large alpha scan; not business rendering precision", ...extra }, null, 2));
try {
  if (!existingToken) adb("shell", "am", "start", "-S", "-W", "-n", `${pkg}/.MainActivity`, "--es", "mode", "encoding-diagnostic", "--es", "probeToken", token);
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    try {
      const report = JSON.parse(adb("exec-out", "run-as", pkg, "cat", "files/snapshot-encoding.json").toString());
      if (report.probeToken === token) { device = report; break; }
    } catch { /* Only poll the report, never repeat drawing. */ }
    await delay(500);
  }
  assert.ok(device, "fresh token-bound report required"); save({ passed: false });
  assert.equal(device.passed, true, device.error);
  assert.equal(device.cases.length, 9);
  assert.equal(device.alphaInspection.blank, true);
  assert.equal(device.alphaInspection.faintLastPixelEmpty, false);
  for (const item of device.cases) {
    assert.match(item.name, /^(text|software|palette)-[0-2]$/);
    const buffers: Record<string, Buffer> = {};
    for (const extension of ["rgba", "png", "webp"]) {
      const bytes = adb("exec-out", "run-as", pkg, "cat", `files/snapshot-encoding/${item.name}.${extension}`);
      writeFileSync(join(output, `${item.name}.${extension}`), bytes);
      buffers[extension] = extension === "rgba" ? bytes : execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
        { input: bytes, timeout: 5000, maxBuffer: 16_000_000 });
      assert.equal(buffers[extension].length, item.width * item.height * 4);
    }
    assert.equal(createHash("sha256").update(buffers.rgba).digest("hex"), item.sha256);
    if (!item.name.startsWith("palette-")) assert.equal(item.immutable, true);
    const compare = (a: Buffer, b: Buffer) => {
      let pixels = 0, alpha = 0, maxRgb = 0, maxPremultiplied = 0;
      for (let i = 0; i < a.length; i += 4) {
        let changed = false;
        if (a[i + 3] !== b[i + 3]) alpha++;
        for (let c = 0; c < 3; c++) {
          const delta = Math.abs(a[i + c] - b[i + c]); changed ||= delta > 0; maxRgb = Math.max(maxRgb, delta);
          maxPremultiplied = Math.max(maxPremultiplied, Math.abs(Math.round(a[i + c] * a[i + 3] / 255) - Math.round(b[i + c] * b[i + 3] / 255)));
        }
        if (changed || a[i + 3] !== b[i + 3]) pixels++;
      }
      return { pixels, alpha, maxRgb, maxPremultiplied };
    };
    rows.push({ name: item.name, pngVsRaw: compare(buffers.png, buffers.rgba), webpVsRaw: compare(buffers.webp, buffers.rgba), pngVsWebp: compare(buffers.png, buffers.webp) });
    save({ passed: false });
  }
  save({ passed: true }); console.log(JSON.stringify({ output, alphaInspection: device.alphaInspection, rows }));
} catch (error) { save({ passed: false, error: String(error) }); throw error; }
finally {
  if (!existingToken && previous && !previous.startsWith(`${pkg}/`)) adb("shell", "am", "start", "-n", previous);
}
