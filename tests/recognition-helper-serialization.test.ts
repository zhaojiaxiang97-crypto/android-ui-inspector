import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";

test("snapshot serializer preserves every JSON value and lossless PNG, with bounded canonical fast path and one-shot failures", { timeout: 30000 }, async context => {
  const java = (name: string) => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
  const compiler = spawnSync(java("javac"), ["-version"], { encoding: "utf8", timeout: 5000 });
  if (!process.env.JAVA_HOME && (compiler.error || /Unable to locate a Java Runtime|No Java runtime present/.test(compiler.stderr))) {
    context.skip("JDK unavailable; use JDK 17 for serializer semantic checks."); return;
  }
  assert.equal(compiler.status, 0, compiler.stderr);
  const directory = mkdtempSync(join(tmpdir(), "helper-snapshot-json-"));
  try {
    const production = readFileSync(new URL("../scripts/helper-templates/InspectorSnapshotJson.java", import.meta.url), "utf8")
      .replace(/^package .*;\n/m, "").replace(/^import .*;\n/gm, "")
      .replace("public final class InspectorSnapshotJson", "static final class InspectorSnapshotJson");
    const fixture = readFileSync(new URL("./fixtures/InspectorSnapshotSerializationCheck.java", import.meta.url), "utf8")
      .replace("/* SERIALIZER */", production);
    const file = join(directory, "InspectorSnapshotSerializationCheck.java");
    writeFileSync(file, fixture);
    const compiled = spawnSync(java("javac"), ["--release", "8", "-d", directory, file], { encoding: "utf8", timeout: 15000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const pixels = Buffer.from([255, 0, 128, 255, 0, 255, 64, 128, 12, 34, 56, 0, 250, 230, 210, 255]);
    const png = await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
    const run = spawnSync(java("java"), ["-Xmx256m", "-cp", directory, "InspectorSnapshotSerializationCheck", png.toString("base64")],
      { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.match(lines.pop()!, /^checked canonical limits/);
    assert.ok(lines.length > 30);
    for (const line of lines) {
      const row = JSON.parse(line) as { label: string; original: string; encoded: string; utf8Length: number };
      assert.deepEqual(JSON.parse(row.encoded), JSON.parse(row.original), row.label);
      assert.equal(Buffer.byteLength(row.encoded, "utf8"), row.utf8Length, row.label);
      if (row.label === "png-and-unicode") {
        const result = Buffer.from(JSON.parse(row.encoded).screenshot_base64, "base64");
        assert.equal(createHash("sha256").update(result).digest("hex"), createHash("sha256").update(png).digest("hex"));
        assert.deepEqual(await sharp(result).raw().toBuffer(), pixels);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
