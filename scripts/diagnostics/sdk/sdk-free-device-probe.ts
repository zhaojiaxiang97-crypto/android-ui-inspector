// Actual SDK-free APK gates. Installs/restarts only this dedicated fixture.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
const serial = process.argv[2];
assert.ok(serial && /^[\w.-]+$/.test(serial), "SERIAL required");
const project = join(import.meta.dirname, "../../..");
const sample = "com.androiduiinspector.sdkfree";
const sdk = process.env.ANDROID_HOME;
assert.ok(sdk, "ANDROID_HOME required for APK verification");
const apk = join(project, "android/sdk-free-sample/build/outputs/apk/debug/sdk-free-sample-debug.apk");
const output = join(project, ".benchmarks/sdk-free", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
console.log(`SDK-free output: ${output}`);
const analyzer = join(sdk, "cmdline-tools/latest/bin/apkanalyzer");
const manifest = execFileSync(analyzer, ["manifest", "print", apk], { encoding: "utf8" });
const classes = execFileSync(analyzer, ["dex", "packages", "--defined-only", apk], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
assert.doesNotMatch(manifest, /<provider\b|com\.androiduiinspector\.sdk\./);
assert.match(manifest, /android:debuggable="true"/);
assert.doesNotMatch(classes, /com\.androiduiinspector\.sdk\.|hiddenapibypass|org\.lsposed/);
assert.match(classes, /com\.androiduiinspector\.sdkfree\.HardwareTextActivity/);
const apkSha256 = createHash("sha256").update(readFileSync(apk)).digest("hex");
writeFileSync(join(output, "apk-verification.json"), JSON.stringify({ apk, apkSha256, noProvider: true, noSdkOrBypassClasses: true, debuggable: true }, null, 2));
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 30000 });
const previous = /mCurrentFocus=.*?\bu\d+\s+([\w.]+\/[\w.$]+)/.exec(adb("shell", "dumpsys", "window"))?.[1];
assert.ok(previous, "must know the original foreground to restore it");
const initialForwards = new Set(adb("forward", "--list").trim().split("\n"));
const pids = new Set<string>();
const records: unknown[] = [];
let fixtureStarted = false;
async function childProbe(name: string, args: string[], experimental: string) {
  const child = spawn(process.execPath, args, { env: { ...process.env, INSPECTOR_ENABLE_SDK_TEXT_REFRESH: experimental } });
  let log = "";
  child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
  let code: number | null;
  try { code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); }
  finally { clearTimeout(timer); }
  writeFileSync(join(output, name + ".log"), log);
  assert.equal(code, 0, log.slice(-1800));
  return log;
}
const start = (activity: string) => {
  fixtureStarted = true;
  adb("shell", "am", "start", "-S", "-W", "-n", `${sample}/.${activity}`);
  const pid = adb("shell", "pidof", sample).trim(); assert.match(pid, /^\d+$/); pids.add(pid); return pid;
};
const stable = (pid: string, activity: string) => {
  assert.equal(adb("shell", "pidof", sample).trim(), pid, "fixture crashed/restarted");
  assert.ok(adb("shell", "dumpsys", "window").includes(`${sample}/${sample}.${activity}`));
};
try {
  // pm path exits 1 for an absent package on this device. Query presence first;
  // connection/authorization failures still throw instead of pretending absence.
  const listed = adb("shell", "pm", "list", "packages", sample);
  const existing = listed.split(/\r?\n/).includes(`package:${sample}`)
    ? adb("shell", "pm", "path", sample).trim() : "";
  const exactInstalled = /^package:\/data\/app\/[^\n]+\/base\.apk$/.test(existing)
    && adb("shell", "sha256sum", existing.slice("package:".length)).split(/\s+/)[0] === apkSha256;
  // Manual installation of the verified binary should not prompt another USB install.
  if (!exactInstalled) assert.match(adb("install", "-r", apk), /Success/);
  const installed = adb("shell", "pm", "path", sample).trim();
  assert.match(installed, /^package:\/data\/app\/[^\n]+\/base\.apk$/);
  assert.equal(adb("shell", "sha256sum", installed.slice("package:".length)).split(/\s+/)[0], apkSha256, "installed APK must be the verified SDK-free binary");
  const pid = start("HardwareTextActivity");
  let baseline: string | undefined;
  for (const experimental of ["0", "1"]) {
    const args = [join(import.meta.dirname, "../../device-health-check.ts"), `--serial=${serial}`, "--require-device", `--app=${sample}`, "--reuse-app", "--refresh-node", "--refresh-pixels", "--refresh-text=Admission Text"];
    if (baseline) args.push(`--expected-refresh-sha=${baseline}`);
    const log = await childProbe(`hardware-${experimental}`, args, experimental);
    const directory = /Device health check output: (.+)/.exec(log)?.[1]; assert.ok(directory);
    const health = JSON.parse(log.split("\n").find(line => line.startsWith("[health] {"))!.slice("[health] ".length));
    assert.equal(health.inspectionSource, "debug-view"); assert.equal(health.debugProcessId, pid);
    const refreshFile = readdirSync(directory).find(name => name.endsWith("-refresh.json")); assert.ok(refreshFile);
    const refresh = JSON.parse(readFileSync(join(directory, refreshFile), "utf8"));
    assert.equal(refresh.samples.length, 3);
    for (const entry of refresh.samples) {
      assert.equal(entry.accepted, true); assert.equal(entry.boundsMatchBaseline, true);
      assert.equal(entry.value.route, "jdwp");
      baseline ??= entry.value.pixels.sha256;
      assert.equal(entry.value.pixels.sha256, baseline);
    }
    stable(pid, "HardwareTextActivity");
    records.push({ experimental, health, refreshEvidence: join(directory, refreshFile), legacyRoute: true, pixelsMatch: true });
    console.log(JSON.stringify({ phase: "hardware", experimental, passed: true }));
  }
  const softwarePid = start("SoftwareTextActivity");
  const log = await childProbe("software", [join(import.meta.dirname, "sdk-text-desktop-cancel-probe.ts"), serial, "Admission Text", "--no-sdk-wake", `--fixture-package=${sample}`], "0");
  const software = log.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line)).find(r => r.passed);
  assert.equal(software?.noSdkSoftwareSafelyRejected, true);
  stable(softwarePid, "SoftwareTextActivity"); records.push(software);
} catch (error) {
  writeFileSync(join(output, "failure.json"), JSON.stringify({ passed: false, error: String(error), completed: records }, null, 2));
  throw error;
} finally {
  try {
    for (const line of adb("forward", "--list").trim().split("\n")) {
      const [device, local, remote] = line.split(/\s+/);
      if (!initialForwards.has(line) && device === serial && /^tcp:\d+$/.test(local ?? "") &&
        (remote === `localabstract:${sample}.inspector.session` || remote?.startsWith("jdwp:") && pids.has(remote.slice(5)))) adb("forward", "--remove", local);
    }
    assert.ok(adb("forward", "--list").trim().split("\n").every(line => {
      const [device, , remote] = line.split(/\s+/);
      return initialForwards.has(line) || device !== serial || !(remote === `localabstract:${sample}.inspector.session` || remote?.startsWith("jdwp:") && pids.has(remote.slice(5)));
    }), "owned fixture forward leaked");
  } finally {
    if (fixtureStarted) {
      adb("shell", "am", "force-stop", sample);
      if (!previous.startsWith(sample + "/")) adb("shell", "am", "start", "-W", "-n", previous);
      assert.ok(adb("shell", "dumpsys", "window").includes(previous), "original foreground was not restored");
    }
  }
}
writeFileSync(join(output, "summary.json"), JSON.stringify({ passed: true, scope: "actual-sdk-free-apk", records, foregroundRestored: true }, null, 2));
console.log(JSON.stringify({ passed: true, scope: "actual-sdk-free-apk", output }));
