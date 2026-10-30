#!/usr/bin/env node
// Verify the pinned Artemis source and our Helper templates before compiling an APK.
// This script never installs the APK, starts a device session, or publishes the binary.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = join(root, ".benchmarks", "recognition-helper");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 12 * 1024 * 1024, timeout: 240_000 });
  if (result.error || result.status !== 0) {
    const tail = [result.stdout, result.stderr].filter(Boolean).join("\n").split("\n").slice(-35).join("\n");
    throw new Error(`${command} failed (${result.status ?? result.signal ?? "spawn"}): ${result.error?.message ?? tail}`);
  }
  return result.stdout;
};

const prepared = JSON.parse(run(process.env.BUN_BINARY || "bun", ["scripts/prepare-recognition-helper.ts"]).trim());
const source = resolve(prepared.output);
if (!isAbsolute(prepared.output) || relative(outputRoot, source).startsWith("..") || source === outputRoot)
  throw new Error("Helper preparation returned an unexpected path.");
const manifestPath = join(source, "source-manifest.json");
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest.helperCommit !== prepared.helperCommit || manifest.helperPackage !== prepared.helperPackage
  || manifest.failures.length || manifest.additions.length !== 7)
  throw new Error("Helper source manifest is incomplete or does not match pinned inputs.");
for (const file of [...manifest.files.map(({ path, patchedSha256 }) => ({ path, sha256: patchedSha256 })),
  ...manifest.additions]) {
  if (!file.path.startsWith("app/") && file.path !== "LICENSE" && file.path !== "build.gradle.kts"
    && file.path !== "settings.gradle.kts" && file.path !== "gradle.properties")
    throw new Error("Unexpected Helper source path in manifest.");
  if (!/^[0-9a-f]{64}$/.test(file.sha256) || hash(readFileSync(join(source, file.path))) !== file.sha256)
    throw new Error("Prepared Helper source does not match its manifest.");
}

const gradle = process.env.GRADLE_BINARY || "gradle";
run(gradle, ["-p", source, ":app:assembleDebug", "--console=plain", "--no-daemon"]);
const apkPath = join(source, "app/build/outputs/apk/debug/app-debug.apk");
if (!existsSync(apkPath)) throw new Error("Helper build succeeded without an APK.");
const apk = readFileSync(apkPath);
if (apk.length < 1024 || apk.subarray(0, 2).toString("utf8") !== "PK") throw new Error("Helper APK is missing or invalid.");
const result = {
  version: 1, sourceManifestSha256: hash(manifestBytes), helperCommit: manifest.helperCommit,
  packageName: manifest.helperPackage, apkSha256: hash(apk), apkBytes: apk.length,
  apkRelativePath: relative(source, apkPath), installedOrDeviceVerified: false,
};
writeFileSync(join(source, "helper-build-verification.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ...result, reportRelativePath: relative(root, join(source, "helper-build-verification.json")) }));
