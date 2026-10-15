// Downgrade only the inspector sample to the pinned real old SDK, then restore it.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const serial = process.argv[2]; assert.ok(serial && /^[\w.-]+$/.test(serial));
const project = join(import.meta.dirname, "../../..");
assert.ok(process.argv[3], "SERIAL ARTIFACT_DIR required; use the verified legacy artifact probe output");
const artifacts = resolve(process.argv[3]);
const evidence = JSON.parse(readFileSync(join(artifacts, "summary.json"), "utf8"));
assert.equal(evidence.passed, true); assert.equal(evidence.commit, "544fd6f82923821da30b0becaf727d81317375f6");
const oldApk = join(artifacts, "legacy-sample-debug.apk");
const newApk = join(project, "android/sample-app/build/outputs/apk/debug/sample-app-debug.apk");
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
assert.equal(hash(oldApk), evidence.apkSha256);
const newHash = hash(newApk);
const sample = "com.androiduiinspector.sample";
const output = join(project, ".benchmarks/legacy-device", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true }); console.log(`Legacy device output: ${output}`);
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 30000 });
const installedHash = () => {
  const path = adb("shell", "pm", "path", sample).trim();
  assert.match(path, /^package:\/data\/app\/[^\n]+\/base\.apk$/);
  return adb("shell", "sha256sum", path.slice(8)).split(/\s+/)[0];
};
assert.equal(installedHash(), newHash, "restore APK must exactly match the original installed sample");
const previous = /mCurrentFocus=.*?\bu\d+\s+([\w.]+\/[\w.$]+)/.exec(adb("shell", "dumpsys", "window"))?.[1];
assert.ok(previous && !previous.startsWith(sample + "/"), "start from a known non-sample page");
const originalForwards = new Set(adb("forward", "--list").trim().split("\n"));
const pids = new Set<string>(); const records: unknown[] = [];
let changed = false;
const readTree = () => {
  assert.match(adb("shell", "content", "call", "--uri", `content://${sample}.inspector`, "--method", "capture"), /result=ok/);
  return JSON.parse(adb("exec-out", "run-as", sample, "cat", "no_backup/inspector-hierarchy.json"));
};
try {
  changed = true; // restore even if the installation reply is interrupted
  assert.match(adb("install", "-r", oldApk), /Success/); assert.equal(installedHash(), evidence.apkSha256);
  // An unrecognized non-null mode keeps the simple page but disables old auto-probes.
  adb("shell", "am", "start", "-S", "-W", "-n", `${sample}/.MainActivity`, "--es", "mode", "compat-static");
  const pid = adb("shell", "pidof", sample).trim(); assert.match(pid, /^\d+$/); pids.add(pid);
  const tree = readTree(); assert.equal(String(tree.pid), pid);
  for (const key of ["uiWakeVersion", "refDebugCanvasVersion", "branchGeometryVersion"]) assert.equal(tree[key], undefined);
  assert.match(adb("shell", "content", "call", "--uri", `content://${sample}.inspector`, "--method", "wake-ui", "--arg", "0123456789abcdef"), /Unauthorized or unsupported request/);
  writeFileSync(join(output, "live-capabilities.json"), JSON.stringify({ pid, instance: tree.processInstance, newCapabilitiesAbsent: true, wakeUiUnsupported: true }, null, 2));
  let baseline: string | undefined;
  for (const enabled of ["0", "1"]) {
    const args = [join(import.meta.dirname, "../../device-health-check.ts"), `--serial=${serial}`, "--require-device", `--app=${sample}`, "--reuse-app", "--refresh-node", "--refresh-pixels", "--refresh-text=RED CHILD"];
    if (baseline) args.push(`--expected-refresh-sha=${baseline}`);
    const child = spawn(process.execPath, args, { env: { ...process.env, INSPECTOR_ENABLE_SDK_TEXT_REFRESH: enabled } });
    let log = ""; child.stdout.on("data", c => { log += c; }); child.stderr.on("data", c => { log += c; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
    let code: number | null;
    try { code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); }
    finally { clearTimeout(timer); writeFileSync(join(output, `hardware-${enabled}.log`), log); }
    assert.equal(code, 0, log.slice(-1600));
    const health = JSON.parse(log.split("\n").find(l => l.startsWith("[health] {"))!.slice(9));
    assert.equal(health.inspectionSource, "debug-hybrid"); assert.equal(health.debugProcessId, pid);
    const directory = /Device health check output: (.+)/.exec(log)?.[1]; assert.ok(directory);
    const name = readdirSync(directory).find(n => n.endsWith("-refresh.json")); assert.ok(name);
    const refresh = JSON.parse(readFileSync(join(directory, name), "utf8")); assert.equal(refresh.samples.length, 3);
    for (const entry of refresh.samples) {
      assert.equal(entry.accepted, true); assert.equal(entry.boundsMatchBaseline, true);
      assert.equal(entry.value.route, "jdwp");
      baseline ??= entry.value.pixels.sha256; assert.equal(entry.value.pixels.sha256, baseline);
    }
    assert.equal(adb("shell", "pidof", sample).trim(), pid);
    assert.ok(adb("shell", "dumpsys", "window").includes(`${sample}/${sample}.MainActivity`));
    records.push({ enabled, health, refreshEvidence: join(directory, name), legacyRoute: true, pixelsMatch: true });
    console.log(JSON.stringify({ phase: "legacy", enabled, passed: true }));
  }
} catch (error) {
  writeFileSync(join(output, "failure.json"), JSON.stringify({ passed: false, completed: records, error: String(error) }, null, 2)); throw error;
} finally {
  try {
    if (changed) {
      assert.match(adb("install", "-r", newApk), /Success/); assert.equal(installedHash(), newHash);
      adb("shell", "am", "start", "-S", "-W", "-n", `${sample}/.HardwareTextActivity`);
      const pid = adb("shell", "pidof", sample).trim(); if (/^\d+$/.test(pid)) pids.add(pid);
      const restored = readTree(); assert.equal(restored.uiWakeVersion, 1); assert.equal(restored.refDebugCanvasVersion, 1);
    }
  } finally {
    for (const line of adb("forward", "--list").trim().split("\n")) {
      const [device, local, remote] = line.split(/\s+/);
      if (device === serial && !originalForwards.has(line) && /^tcp:\d+$/.test(local ?? "") &&
        (remote === `localabstract:${sample}.inspector.session` || remote?.startsWith("jdwp:") && pids.has(remote.slice(5)))) adb("forward", "--remove", local);
    }
    adb("shell", "am", "force-stop", sample); adb("shell", "am", "start", "-W", "-n", previous);
    assert.ok(adb("shell", "dumpsys", "window").includes(previous));
  }
}
writeFileSync(join(output, "summary.json"), JSON.stringify({ passed: true, scope: "real-old-sdk-hardware-window", sourceCommit: evidence.commit, records, newSampleRestored: true, foregroundRestored: true, softwareWindowTested: false }, null, 2));
console.log(JSON.stringify({ passed: true, output, newSampleRestored: true }));
