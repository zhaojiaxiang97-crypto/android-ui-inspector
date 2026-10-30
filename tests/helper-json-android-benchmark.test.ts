import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { buildJsonAndroidBenchmark, summarizeJsonAndroidBenchmark } from "../scripts/helper-json-android-benchmark";

function rows(order: "AB" | "BA" = "AB"): any[] {
  const encoding = (candidate: boolean, samples = false) => ({ jsonMs: candidate ? 4 : 10, utf8Ms: 2,
    byteLength: candidate ? 100 : 102, sha256: (candidate ? "b" : "a").repeat(64), javaHeapBeforeBytes: 1000,
    javaHeapAfterBytes: 1200, memorySamples: samples ? 3 : 0,
    ...(samples ? { javaHeapObservedMaxBytes: 1300, nativeHeapObservedMaxBytes: 500 } : {}) });
  const pair = (phase: string, index: number, ownOrder: string) => ({ event: "pair", fixture: "small", phase, index,
    order: ownOrder, baseline: encoding(false, phase === "memory-probe"), candidate: encoding(true, phase === "memory-probe"),
    fieldsEqual: true, pngBytesEqual: true, decodedPixelsEqual: true, originalUnchanged: true, bytesEqual: false });
  return [{ event: "fixture", fixture: "small", runtime: "Android", sdkInt: 34, platformOrgJson: true,
    width: 512, height: 640, pngBytes: 1_300_000, pngSha256: "c".repeat(64), pixelSha256: "d".repeat(64),
    warmPairs: 2, warmupPairs: 1, firstOrder: order, memorySampleIntervalMs: 1,
    memoryLimit: "separate memory probe; not exact peak", coldLimit: "first pair after construction", timingLimit: "JSON/UTF8 only" },
    pair("cold-first", 0, order), pair("warmup", 0, order === "AB" ? "BA" : "AB"),
    pair("warm", 0, order), pair("warm", 1, order === "AB" ? "BA" : "AB"), pair("memory-probe", 0, order),
    { event: "complete", fixture: "small", pairs: 5, passed: true }];
}
const jsonl = (rows: any[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";

test("Android benchmark separates cold/warm pairs, UTF8 and unsampled timing from independent memory probes", () => {
  const result = summarizeJsonAndroidBenchmark([jsonl(rows("AB")), jsonl(rows("BA"))]);
  assert.equal(result.runs, 2); assert.equal(result.groups.length, 2);
  const cold = result.groups.find(group => group.phase === "cold-first")!, warm = result.groups.find(group => group.phase === "warm")!;
  assert.equal(cold.baseline.jsonMs.count, 2); assert.equal(warm.baseline.jsonMs.count, 4);
  assert.equal(warm.baseline.jsonMs.mean, 10); assert.equal(warm.candidate.jsonMs.mean, 4);
  assert.equal(warm.pairedJsonDifferenceMs.mean, 6); assert.equal(warm.candidate.utf8Ms.mean, 2);
  assert.deepEqual(warm.firstOrders, ["AB", "BA"]); assert.equal(warm.bytesEqual, false, "different JSON ordering/escaping may be semantically equal");
  assert.equal(result.memoryProbes.length, 2); assert.equal(result.memoryProbes[0].baseline.memorySamples, 3);
  assert.ok(result.limitations.some(text => /not exact/.test(text)));
});

test("Android benchmark rejects incomplete, unbalanced, corrupted, desktop and mutable evidence", () => {
  for (const corrupt of [
    (r: any[]) => r.pop(), (r: any[]) => r.splice(2, 1), (r: any[]) => { r[3].order = "BA"; },
    (r: any[]) => { r[3].index = 1; }, (r: any[]) => { r[0].runtime = "desktop"; },
    (r: any[]) => { r[0].platformOrgJson = false; }, (r: any[]) => { r[1].fieldsEqual = false; },
    (r: any[]) => { r[1].pngBytesEqual = false; }, (r: any[]) => { r[1].originalUnchanged = false; },
    (r: any[]) => { r[1].candidate.jsonMs = Infinity; }, (r: any[]) => { r[1].candidate.byteLength = 32 * 1024 * 1024 + 1; },
    (r: any[]) => { r[3].candidate.sha256 = "f".repeat(64); }, (r: any[]) => { r[3].baseline.memorySamples = 1; },
    (r: any[]) => { r[5].candidate.memorySamples = 0; }, (r: any[]) => { delete r[5].candidate.javaHeapObservedMaxBytes; },
    (r: any[]) => { r[1].privatePageText = "unwanted"; },
  ]) { const input = rows(); corrupt(input); assert.throws(() => summarizeJsonAndroidBenchmark([jsonl(input)])); }
  const changedPng = rows("BA"); changedPng[0].pngSha256 = "e".repeat(64);
  assert.throws(() => summarizeJsonAndroidBenchmark([jsonl(rows()), jsonl(changedPng)]), /fixed payload/);
  const changedPayload = rows("BA"); for (const row of changedPayload) if (row.event === "pair") row.baseline.sha256 = "e".repeat(64);
  assert.throws(() => summarizeJsonAndroidBenchmark([jsonl(rows()), jsonl(changedPayload)]), /fixed payload/);
  assert.throws(() => summarizeJsonAndroidBenchmark([]));
});

test("standalone Java benchmark compiles against the real Android API and packages DEX without phone access", { timeout: 60_000 }, context => {
  const sdk = process.env.ANDROID_HOME ?? "/opt/homebrew/share/android-commandlinetools";
  const java = "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home";
  if (!existsSync(join(sdk, "platforms/android-36/android.jar")) || !existsSync(join(java, "bin/javac"))) { context.skip("Android SDK36/JDK17 unavailable"); return; }
  const base = mkdtempSync(resolve(".benchmarks-json-d3-test-"));
  try {
    const source = join(base, "InspectorSnapshotJson.java"), output = join(base, "compiled");
    writeFileSync(source, "package com.artemis.helper; public final class InspectorSnapshotJson { public static String stringify(org.json.JSONObject object) { return object.toString(); } }");
    const manifest = buildJsonAndroidBenchmark(output, source, sdk, java);
    assert.ok(readFileSync(manifest.archive).length > 1000); assert.match(manifest.serializerSourceSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.requiredRuntime, /Android app_process/); assert.match(manifest.invocation, /-Xmx512m/);
    assert.throws(() => buildJsonAndroidBenchmark(output, source, sdk, java), /new directory/);
    const fixture = readFileSync(resolve("scripts/helper-templates/InspectorJsonAndroidBenchmark.java"), "utf8");
    assert.match(fixture, /Build.VERSION.SDK_INT < 26/); assert.match(fixture, /new JsonReader\(new InputStreamReader\(new ByteArrayInputStream\(bytes\)/);
    assert.doesNotMatch(fixture, /new JSONObject\(new String|String json;/);
    assert.match(fixture, /decodedPixels\(decoded/); assert.match(fixture, /phase.equals\("memory-probe"\)/);
    assert.doesNotMatch(fixture, /AccessibilityService|TokenStore|socket|adb|force-stop/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
