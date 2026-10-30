import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { sdkEntryCompileSupport, sdkEntryPlatform, sdkPipelinePlatform } from "./fixtures/sdk-pipeline-platform";

test("actual SDK pipeline bounds work, preserves ordered atomic output and owns cancellation resources", { timeout: 30000 }, () => {
  const root = join(import.meta.dirname, "..");
  const parent = join(root, ".benchmarks");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "sdk-pipeline-host-"));
  try {
    const stubs = Object.entries(sdkPipelinePlatform).map(([path, contents]) => {
      const file = join(directory, path);
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, contents); return file;
    });
    const java = (name: string) => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
    const source = join(root, "android/inspector-sdk/src/main/java/com/androiduiinspector/sdk");
    const compile = spawnSync(java("javac"), ["--release", "8", "-d", directory,
      ...["CapturePipeline", "CaptureOutput", "RefCaptureSelection"].map(name => join(source, `${name}.java`)),
      join(import.meta.dirname, "fixtures/CapturePipelineCheck.java"), ...stubs], { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.equal(compile.status, 0, `${compile.error ?? ""}\n${compile.stdout}\n${compile.stderr}`);
    const run = spawnSync(java("java"), ["-cp", directory, "com.androiduiinspector.sdk.CapturePipelineCheck", directory],
      { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.equal(run.status, 0, `${run.error ?? ""}\n${run.stdout}\n${run.stderr}`);
    for (const check of ["ordered-output-and-bounds", "cancel-and-late-ownership", "failure-and-rejected-submit", "writer-and-publish-failures", "layer-file-lifecycle", "selection-late-cleanup"])
      assert.match(run.stdout, new RegExp(`PASS ${check}`));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const androidJar = process.env.SDK_TEST_ANDROID_JAR ?? (androidHome ? join(androidHome, "platforms/android-30/android.jar") : "");
test("full SDK refs entry reclaims partial and late UI selections", {
  timeout: 30000,
  skip: androidJar && existsSync(androidJar) ? false : "Full Java entry check needs SDK_TEST_ANDROID_JAR or ANDROID_HOME with android-30; no device is used",
}, () => {
  const root = join(import.meta.dirname, "..");
  mkdirSync(join(root, ".benchmarks"), { recursive: true });
  const directory = mkdtempSync(join(root, ".benchmarks/sdk-refs-entry-host-"));
  try {
    const product = join(directory, "product"), platform = join(directory, "platform");
    mkdirSync(product); mkdirSync(platform);
    const materialize = (base: string, files: Record<string, string>) => Object.entries(files).map(([path, source]) => {
      const file = join(base, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, source); return file;
    });
    const java = (name: string) => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
    const source = join(root, "android/inspector-sdk/src/main/java/com/androiduiinspector/sdk");
    const support = materialize(product, sdkEntryCompileSupport);
    const compile = spawnSync(java("javac"), ["--release", "8", "-cp", androidJar, "-d", product,
      ...readdirSync(source).filter(name => name.endsWith(".java")).map(name => join(source, name)), ...support],
      { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.equal(compile.status, 0, `${compile.error ?? ""}\n${compile.stdout}\n${compile.stderr}`);
    const stubs = materialize(platform, sdkEntryPlatform);
    const runtimeCompile = spawnSync(java("javac"), ["--release", "8", "-cp", [product, androidJar].join(delimiter), "-d", platform,
      ...stubs, join(import.meta.dirname, "fixtures/CaptureRefsEntryCheck.java")], { cwd: root, encoding: "utf8", timeout: 10000 });
    assert.equal(runtimeCompile.status, 0, `${runtimeCompile.error ?? ""}\n${runtimeCompile.stdout}\n${runtimeCompile.stderr}`);
    const run = spawnSync(java("java"), ["-cp", [platform, product, androidJar].join(delimiter), "com.androiduiinspector.sdk.CaptureRefsEntryCheck", directory],
      { cwd: root, encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, `${run.error ?? ""}\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /PASS entry-partial-selection-cleanup created=1 recycled=1/);
    assert.match(run.stdout, /PASS entry-late-selection-cleanup created=1 recycled=1 published=false/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
