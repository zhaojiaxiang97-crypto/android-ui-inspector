import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { isDebugMetadata } from "../shared/debug-metadata";

// Use the real JSON runtime already fetched by Android tooling, without adding an SDK runtime dependency.
function jsonRuntime(): string | null {
  if (process.env.SDK_TEST_JSON_JAR) return existsSync(process.env.SDK_TEST_JSON_JAR) ? process.env.SDK_TEST_JSON_JAR : null;
  const root = join(homedir(), ".gradle/caches/modules-2/files-2.1/org.json/json");
  if (!existsSync(root)) return null;
  for (const version of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory())) {
    const directory = join(root, version.name);
    for (const digest of readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory())) {
      const location = join(directory, digest.name);
      const jar = readdirSync(location).find(name => /^json-.*\.jar$/.test(name));
      if (jar) return join(location, jar);
    }
  }
  return null;
}
const json = jsonRuntime();

test("actual SDK registration produces valid desktop metadata and keeps changes atomic", {
  timeout: 20000, skip: json ? false : "JVM check needs org.json: set SDK_TEST_JSON_JAR or build Android once to populate Gradle's cache",
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "sdk-debug-values-"));
  const source = join(import.meta.dirname, "../android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/DebugMetadata.java");
  try {
    const files: Record<string, string> = {
      "android/view/View.java": "package android.view; public class View { private final java.util.Map<Integer,Object> tags=new java.util.HashMap<>(); public Object getTag(int key){return tags.get(key);} public void setTag(int key,Object value){tags.put(key,value);} }",
      "android/os/Looper.java": "package android.os; public class Looper { private static final Thread owner=Thread.currentThread(); private static final Looper main=new Looper(); public static Looper getMainLooper(){return main;} public static Looper myLooper(){return Thread.currentThread()==owner?main:null;} }",
      "com/androiduiinspector/sdk/R.java": "package com.androiduiinspector.sdk; public class R { public static class id { public static final int inspector_debug_metadata=1; } }",
    };
    for (const [path, contents] of Object.entries(files)) {
      const target = join(directory, path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, contents);
    }
    const compile = spawnSync("javac", ["--release", "8", "-cp", json!, "-d", directory, source,
      join(import.meta.dirname, "fixtures/DebugMetadataCheck.java"), ...Object.keys(files).map(path => join(directory, path))], { encoding: "utf8", timeout: 10000 });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync("java", ["-cp", `${directory}${delimiter}${json}`, "com.androiduiinspector.sdk.DebugMetadataCheck"], { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    const metadata = JSON.parse(run.stdout.split("\n")[0]);
    assert.equal(isDebugMetadata(metadata), true, "actual Java serialization must satisfy the desktop validator");
    assert.deepEqual(metadata.groups[0].fields.map((field: { value: unknown }) => field.value), ["SampleCard", "Inspector 自有样例", false, 0, "", '中😀\n"\\</script>', 0.125]);
    assert.match(run.stdout, /atomic updates, thread guard, removal, Unicode and byte budgets passed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("SDK business capture reads explicitly stored values through one per-tree budget", () => {
  const directory = join(import.meta.dirname, "../android/inspector-sdk");
  const tree = readFileSync(join(directory, "src/main/java/com/androiduiinspector/sdk/HierarchyTree.java"), "utf8");
  assert.match(tree, /report\.put\("debugMetadataVersion", 1\)/);
  assert.match(tree, /node\(root, debugBudget\)/);
  assert.match(tree, /node\(child, debugBudget\)/);
  assert.match(tree, /DebugMetadata\.read\(view, debugBudget\)/);
  const registration = readFileSync(join(directory, "src/main/java/com/androiduiinspector/sdk/DebugMetadata.java"), "utf8");
  assert.doesNotMatch(registration, /java\.lang\.reflect|WeakHashMap|setAccessible|Runnable|Callable|Supplier/);
  assert.match(readFileSync(join(directory, "build.gradle.kts"), "utf8"), /include\("\*\*\/\*\.java", "\*\*\/\*\.xml"\)/);
  const refresh = readFileSync(join(import.meta.dirname, "../electron/capture/refresh.ts"), "utf8");
  assert.match(refresh, /root\.attributes\?\.\["sdk-debug-metadata-version"\] === "1"/);
  assert.match(refresh, /debugMetadata: latest\.debugMetadata/);
});
