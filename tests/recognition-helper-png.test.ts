import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { inspectorHelperTemplates } from "../scripts/prepare-recognition-helper";

test("helper generation includes both codec and adapter, without adding a service endpoint", () => {
  assert.deepEqual(inspectorHelperTemplates, ["InspectorObservation.java", "InspectorPngCodec.java", "InspectorPngEncoder.java"]);
  for (const name of inspectorHelperTemplates) assert.ok(readFileSync(new URL(`../scripts/helper-templates/${name}`, import.meta.url)).length > 0);
  const adapter = readFileSync(new URL("../scripts/helper-templates/InspectorPngEncoder.java", import.meta.url), "utf8");
  assert.doesNotMatch(adapter, /setColorSpace|Bitmap\.createBitmap|\.copy\(|createScaledBitmap|setPixels|\.recycle\(/);
  assert.match(adapter, /Bitmap\.Config\.ARGB_8888/);
  assert.match(adapter, /space\.isSrgb\(\)/);
  assert.match(adapter, /NativeAlphaRequired/);
  assert.match(adapter, /Bitmap\.CompressFormat\.PNG/);
});

test("PNG JVM encoder preserves exact RGBA through independent decoders and rejects unsafe dimensions", { timeout: 60000 }, async context => {
  const java = (name: string) => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
  const compiler = spawnSync(java("javac"), ["-version"], { encoding: "utf8", timeout: 5000 });
  if (!process.env.JAVA_HOME && ((compiler.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      || /Unable to locate a Java Runtime|No Java runtime present/i.test(compiler.stderr ?? ""))) {
    context.skip("JDK unavailable; use JDK 17 for the Android PNG codec acceptance tests."); return;
  }
  assert.equal(compiler.status, 0, compiler.stderr || compiler.error?.message);
  const base = resolve(".benchmarks"); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "png-codec-test-"));
  const run = (args: string[], main = "InspectorPngCodecCheck") => {
    const result = spawnSync(java("java"), ["-Djava.awt.headless=true", "-cp", directory, main, ...args], { encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout;
  };
  try {
    const result = spawnSync(java("javac"), ["--release", "8", "-d", directory,
      ...["scripts/helper-templates/InspectorPngCodec.java", "scripts/helper-templates/InspectorPngEncoder.java",
        "tests/fixtures/InspectorPngCodecCheck.java", "tests/fixtures/InspectorPngAdapterCheck.java",
        "tests/fixtures/png-android-stubs/Bitmap.java", "tests/fixtures/png-android-stubs/ColorSpace.java",
        "tests/fixtures/png-android-stubs/Build.java"].map(path => resolve(path))], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(run(["self-test"]), /PNG pixels, alpha, dimensions, limits, cancellation and errors passed/);
    assert.match(run([], "InspectorPngAdapterCheck"), /Android adapter routing, alpha fallback, size limits, errors and ownership passed/);
    const cases: Array<{ name: string; width: number; height: number; data: Buffer }> = [];
    const rgba = Buffer.alloc(257 * 65 * 4);
    for (let p = 0; p < rgba.length; p += 4) {
      rgba[p] = (p * 37) & 255; rgba[p + 1] = (p * 13 + 71) & 255;
      rgba[p + 2] = (p * 3 + 109) & 255; rgba[p + 3] = ((p / 4) % 257) & 255;
    }
    cases.push({ name: "alpha", width: 257, height: 65, data: rgba });
    for (const name of ["src/assets/icons/camera.png", "docs/images/first-use-2d.png"]) {
      const decoded = await sharp(resolve(name)).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      cases.push({ name, width: decoded.info.width, height: decoded.info.height, data: decoded.data });
    }
    for (const sample of cases) {
      const raw = Buffer.alloc(sample.data.length);
      for (let p = 0; p < raw.length; p += 4) {
        raw[p] = sample.data[p + 3]; raw[p + 1] = sample.data[p]; raw[p + 2] = sample.data[p + 1]; raw[p + 3] = sample.data[p + 2];
      }
      const input = join(directory, "pixels.argb"), output = join(directory, "encoded.png");
      writeFileSync(input, raw); run(["encode-argb", input, String(sample.width), String(sample.height), output]);
      const decoded = await sharp(output, { failOn: "warning" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(decoded.info.width, sample.width); assert.equal(decoded.info.height, sample.height);
      assert.deepEqual(decoded.data, sample.data, `${sample.name}: every channel, including transparent RGB, must survive`);
      const metadata = await sharp(output).metadata(); assert.equal(metadata.space, "srgb");
      assert.ok(readFileSync(output).length <= 16 * 1024 * 1024);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
