#!/usr/bin/env node
// Build the SDK and SDK-free sample with the pinned Android toolchain.
// Keep Gradle output bounded; publish only artifact hashes, never APK bytes.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const android = join(root, "android");
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!process.env.JAVA_HOME || !sdk || !existsSync(join(sdk, "platforms", "android-36", "android.jar")))
  throw new Error("Android SDK gate requires JAVA_HOME and Android SDK platform 36.");

const binary = process.env.GRADLE_BINARY || "gradle";
const args = ["-p", android, ":inspector-sdk:assembleDebug", ":inspector-sdk:assembleRelease",
  ":sdk-free-sample:assembleDebug", "--console=plain", "--no-daemon"];
const outcome = spawnSync(binary, args, { cwd: root, encoding: "utf8",
  timeout: 360_000, maxBuffer: 16 * 1024 * 1024 });
if (outcome.error || outcome.status !== 0) {
  const messages = [outcome.stdout, outcome.stderr].filter(Boolean).join("\n").split("\n").slice(-30).join("\n");
  throw new Error(`Android SDK Gradle build failed (${outcome.status ?? outcome.signal ?? "spawn"}): ${outcome.error?.message ?? messages}`);
}
const artifacts = [
  "android/inspector-sdk/build/outputs/aar/inspector-sdk-debug.aar",
  "android/inspector-sdk/build/outputs/aar/inspector-sdk-release.aar",
  "android/sdk-free-sample/build/outputs/apk/debug/sdk-free-sample-debug.apk",
].map(path => {
  const buffer = readFileSync(join(root, path));
  if (buffer.length < 1024 || buffer.subarray(0, 2).toString() !== "PK")
    throw new Error(`Missing or malformed Android artifact: ${path}`);
  return { path, bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
});
const output = mkdtempSync(join(root, ".benchmarks", "android-sdk-verification-"));
const result = { version: 1, artifacts, installedOrDeviceVerified: false };
writeFileSync(join(output, "build-verification.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ ...result, reportRelativePath: relative(root, output) + "/build-verification.json" }));
