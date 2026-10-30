// Build an actual committed old SDK, never rewrite the current SDK to fake absence.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const project = join(import.meta.dirname, "../../..");
// Pin the pre-experiment checkpoint; advancing HEAD must not silently change this fixture.
const ref = process.argv[2] ?? "544fd6f82923821da30b0becaf727d81317375f6";
const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8" });
const commit = git("rev-parse", "--verify", `${ref}^{commit}`).trim();
assert.match(commit, /^[a-f0-9]{40}$/);
const source = git("show", `${commit}:android/inspector-sdk/src/main/java/com/androiduiinspector/sdk/HierarchyProvider.java`);
const missing = ["uiWakeVersion", "refDebugCanvasVersion", "branchGeometryVersion"];
for (const key of missing) assert.ok(!source.includes(`\"${key}\"`), `not a legacy fixture: ${key} exists`);
assert.ok(!source.includes('"wake-ui"'));
const sdk = process.env.ANDROID_HOME;
assert.ok(sdk && process.env.JAVA_HOME, "ANDROID_HOME and Java 17 JAVA_HOME required");
const output = join(project, ".benchmarks/legacy-sdk", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const checkout = mkdtempSync(join(tmpdir(), "inspector-legacy-sdk-"));
console.log(`Legacy artifact output: ${output}`);
const archive = execFileSync("git", ["-C", project, "archive", commit, "android"], { maxBuffer: 16 * 1024 * 1024 });
execFileSync("tar", ["-xf", "-", "-C", checkout], { input: archive });
let log = "";
try {
  const child = spawn("gradle", ["-p", join(checkout, "android"), ":inspector-sdk:assembleDebug", ":sample-app:assembleDebug"], { env: process.env });
  child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
  let code: number | null;
  try { code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); }
  finally { clearTimeout(timer); writeFileSync(join(output, "build.log"), log); }
  assert.equal(code, 0, log.slice(-2000));
  const apk = join(output, "legacy-sample-debug.apk");
  const aar = join(output, "legacy-inspector-sdk-debug.aar");
  copyFileSync(join(checkout, "android/sample-app/build/outputs/apk/debug/sample-app-debug.apk"), apk);
  copyFileSync(join(checkout, "android/inspector-sdk/build/outputs/aar/inspector-sdk-debug.aar"), aar);
  const manifest = execFileSync(join(sdk, "cmdline-tools/latest/bin/apkanalyzer"), ["manifest", "print", apk], { encoding: "utf8" });
  assert.match(manifest, /com\.androiduiinspector\.sdk\.HierarchyProvider/);
  assert.match(manifest, /android:debuggable="true"/);
  const dexFiles = execFileSync("unzip", ["-Z1", apk], { encoding: "utf8" }).split(/\r?\n/).filter(name => /^classes\d*\.dex$/.test(name));
  assert.ok(dexFiles.length);
  let providerFound = false;
  for (const file of dexFiles) {
    const dex = execFileSync("unzip", ["-p", apk, file], { maxBuffer: 32 * 1024 * 1024 });
    providerFound ||= dex.includes(Buffer.from("Lcom/androiduiinspector/sdk/HierarchyProvider;"));
    for (const key of [...missing, "wake-ui"]) assert.ok(!dex.includes(Buffer.from(key)), `new capability in compiled old APK: ${key}`);
  }
  assert.ok(providerFound);
  const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const summary = { passed: true, scope: "legacy-artifact-static-only", commit, checkout, apk, aar,
    apkSha256: sha256(apk), aarSha256: sha256(aar), missingCapabilities: missing, noWakeUiMethod: true,
    debugProviderPresent: true, deviceTested: false, installed: false };
  writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} catch (error) {
  writeFileSync(join(output, "failure.json"), JSON.stringify({ passed: false, commit, checkout, error: String(error), deviceTested: false }, null, 2));
  throw error;
}
