import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("production controlled reads cancel cooperatively without publishing late evidence or unlocking another worker", { timeout: 30000 }, context => {
  const java = (name: string) => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
  const compiler = spawnSync(java("javac"), ["-version"], { encoding: "utf8", timeout: 5000 });
  if (!process.env.JAVA_HOME && ((compiler.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    || /Unable to locate a Java Runtime|No Java runtime present/i.test(compiler.stderr ?? ""))) {
    context.skip("JDK unavailable; install JDK 17 to execute controlled-read regression."); return;
  }
  assert.equal(compiler.status, 0, compiler.stderr || compiler.error?.message);
  const source = readFileSync(new URL("../scripts/helper-templates/InspectorObservation.java", import.meta.url), "utf8");
  const part = (first: string, last: string) => {
    const start = source.indexOf(first), end = source.indexOf(last, start); assert(start >= 0 && end > start); return source.slice(start, end);
  };
  const replace = (text: string, from: string, to: string) => { assert.equal(text.split(from).length, 2); return text.replace(from, to); };
  const methods = [source.match(/private static final ReentrantLock READS =[^;]*;/)?.[0], source.match(/private static InputCapture inputCapture;/)?.[0],
    source.match(/private static final int CHILD_PREFETCH_FLAGS =[\s\S]*?;/)?.[0],
    part("    private static final class WaitFailure", "    private static final class Capture {"),
    part("    private static final class Capture {", "    private static final class Screenshot {"),
    source.slice(source.indexOf("    private static Rect intersection("), source.lastIndexOf("}"))].join("\n");
  let parent = readFileSync(new URL("./fixtures/InspectorObservationDiagnosticsCheck.java", import.meta.url), "utf8");
  parent = replace(parent, "/* PRODUCTION_METHODS */", "static Runnable treeHook, pngHook;\n" + methods);
  parent = replace(parent, "AccessibilityNodeInfo getChild(int index) { if (childFailure)",
    "AccessibilityNodeInfo getChild(int index) { if (treeHook != null) treeHook.run(); if (childFailure)");
  parent = replace(parent, "static byte[] encode(Bitmap bitmap) { if (scenario.encoderThrows)",
    "static byte[] encode(Bitmap bitmap) { if (pngHook != null) pngHook.run(); if (scenario.encoderThrows)");
  const controller = readFileSync(new URL("../scripts/helper-templates/InspectorReadControl.java", import.meta.url), "utf8")
    .replace(/^package .*;\n/m, "").replace(/^import .*;\n/gm, "").replace("public final class InspectorReadControl", "static final class InspectorReadControl");
  const fixture = replace(readFileSync(new URL("./fixtures/InspectorControlledReadCheck.java", import.meta.url), "utf8"), "/* PRODUCTION_CONTROL */", controller);
  const dir = mkdtempSync(join(tmpdir(), "controlled-read-"));
  try {
    const files = [join(dir, "InspectorObservationDiagnosticsCheck.java"), join(dir, "InspectorControlledReadCheck.java")];
    writeFileSync(files[0], parent); writeFileSync(files[1], fixture);
    const built = spawnSync(java("javac"), ["--release", "8", "-d", dir, ...files], { encoding: "utf8", timeout: 12000 });
    assert.equal(built.status, 0, built.stderr);
    if (process.env.HELPER_CONTROL_ARTIFACT_DIR) cpSync(dir, process.env.HELPER_CONTROL_ARTIFACT_DIR, { recursive: true, force: false, errorOnExist: true });
    const run = spawnSync(java("java"), ["-cp", dir, "InspectorControlledReadCheck"], { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /bounded registry/); console.log(run.stdout.trim());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
