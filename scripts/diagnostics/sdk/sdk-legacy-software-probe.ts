// An unchanged old AAR in a new tiny software-window shell; no business updates.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const serial = process.argv[2]; assert.ok(serial && /^[\w.-]+$/.test(serial) && process.argv[3], "SERIAL ARTIFACT_DIR required");
const project = join(import.meta.dirname, "../../..");
const artifacts = resolve(process.argv[3]);
const legacy = JSON.parse(readFileSync(join(artifacts, "summary.json"), "utf8"));
assert.equal(legacy.passed, true); assert.equal(legacy.commit, "544fd6f82923821da30b0becaf727d81317375f6");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
assert.equal(sha(join(artifacts, "legacy-inspector-sdk-debug.aar")), legacy.aarSha256);
const sdk = process.env.ANDROID_HOME; assert.ok(sdk);
const analyzer = join(sdk, "cmdline-tools/latest/bin/apkanalyzer");
const apk = join(project, "android/legacy-window-sample/build/outputs/apk/debug/legacy-window-sample-debug.apk");
const release = join(project, "android/legacy-window-sample/build/outputs/apk/release/legacy-window-sample-release-unsigned.apk");
const debugManifest = execFileSync(analyzer, ["manifest", "print", apk], { encoding: "utf8" });
assert.match(debugManifest, /com\.androiduiinspector\.sdk\.HierarchyProvider/);
assert.match(debugManifest, /android:debuggable="true"/);
assert.match(debugManifest, /android:hardwareAccelerated="false"/);
const inspectDex = (file: string, debug: boolean) => {
  const dexes = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).split(/\r?\n/).filter(n => /^classes\d*\.dex$/.test(n));
  assert.ok(dexes.length); let provider = false;
  for (const dex of dexes) {
    const bytes = execFileSync("unzip", ["-p", file, dex], { maxBuffer: 32 * 1024 * 1024 });
    provider ||= bytes.includes(Buffer.from("Lcom/androiduiinspector/sdk/HierarchyProvider;"));
    for (const cap of ["wake-ui", "uiWakeVersion", "refDebugCanvasVersion", "branchGeometryVersion"]) assert.ok(!bytes.includes(Buffer.from(cap)));
    if (!debug) assert.ok(!bytes.includes(Buffer.from("Lorg/lsposed/hiddenapibypass/")));
  }
  assert.equal(provider, debug);
};
inspectDex(apk, true); inspectDex(release, false);
assert.doesNotMatch(execFileSync(analyzer, ["manifest", "print", release], { encoding: "utf8" }), /<provider\b/);
const sample = "com.androiduiinspector.legacywindow";
const activity = "com.androiduiinspector.sdkfree.SoftwareTextActivity";
const output = join(project, ".benchmarks/legacy-software", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true }); console.log(`Legacy software output: ${output}`);
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 30000 });
const previous = /mCurrentFocus=.*?\bu\d+\s+([\w.]+\/[\w.$]+)/.exec(adb("shell", "dumpsys", "window"))?.[1]; assert.ok(previous && !previous.startsWith(sample + "/"));
const initial = new Set(adb("forward", "--list").trim().split("\n"));
let pid: string | undefined, started = false;
const captureTree = () => {
  assert.match(adb("shell", "content", "call", "--uri", `content://${sample}.inspector`, "--method", "capture"), /result=ok/);
  return JSON.parse(adb("exec-out", "run-as", sample, "cat", "no_backup/inspector-hierarchy.json"));
};
try {
  const listed = adb("shell", "pm", "list", "packages", sample);
  const existing = listed.split(/\r?\n/).includes(`package:${sample}`) ? adb("shell", "pm", "path", sample).trim() : "";
  const alreadyInstalled = /^package:\/data\/app\/[^\n]+\/base\.apk$/.test(existing)
    && adb("shell", "sha256sum", existing.slice(8)).split(/\s+/)[0] === sha(apk);
  if (!alreadyInstalled) assert.match(adb("install", "-r", apk), /Success/);
  const installed = adb("shell", "pm", "path", sample).trim(); assert.match(installed, /^package:\/data\/app\/[^\n]+\/base\.apk$/);
  assert.equal(adb("shell", "sha256sum", installed.slice(8)).split(/\s+/)[0], sha(apk));
  started = true; adb("shell", "am", "start", "-S", "-W", "-n", `${sample}/${activity}`);
  pid = adb("shell", "pidof", sample).trim(); assert.match(pid, /^\d+$/);
  const tree = captureTree(); assert.equal(String(tree.pid), pid);
  for (const cap of ["uiWakeVersion", "refDebugCanvasVersion", "branchGeometryVersion"]) assert.equal(tree[cap], undefined);
  const child = spawn(process.execPath, [join(import.meta.dirname, "sdk-text-desktop-cancel-probe.ts"), serial, "Admission Text", "--legacy-software"], { env: process.env });
  let log = ""; child.stdout.on("data", c => { log += c; }); child.stderr.on("data", c => { log += c; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
  let code: number | null;
  try { code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); }
  finally { clearTimeout(timer); writeFileSync(join(output, "software.log"), log); }
  assert.equal(code, 0, log.slice(-1800));
  const result = log.split("\n").filter(l => l.startsWith("{")).map(l => JSON.parse(l)).find(r => r.passed);
  assert.equal(result?.noSdkSoftwareSafelyRejected, true);
  assert.equal(adb("shell", "pidof", sample).trim(), pid);
  assert.ok(adb("shell", "dumpsys", "window").includes(`${sample}/${activity}`));
  const recovery = captureTree(); assert.equal(String(recovery.pid), pid); assert.equal(recovery.processInstance, tree.processInstance);
  writeFileSync(join(output, "result.json"), JSON.stringify({ passed: true, result, pid, sdkTreeRecovered: true, oldAarSha256: legacy.aarSha256, apkSha256: sha(apk), releaseSdkFree: true }, null, 2));
} catch (error) {
  writeFileSync(join(output, "failure.json"), JSON.stringify({ passed: false, error: String(error) }, null, 2)); throw error;
} finally {
  for (const line of adb("forward", "--list").trim().split("\n")) {
    const [device, local, remote] = line.split(/\s+/);
    if (device === serial && !initial.has(line) && /^tcp:\d+$/.test(local ?? "") &&
      (remote === `localabstract:${sample}.inspector.session` || pid && remote === `jdwp:${pid}`)) adb("forward", "--remove", local);
  }
  if (started) { adb("shell", "am", "force-stop", sample); adb("shell", "am", "start", "-W", "-n", previous); assert.ok(adb("shell", "dumpsys", "window").includes(previous)); }
}
writeFileSync(join(output, "summary.json"), JSON.stringify({ passed: true, scope: "unchanged-old-sdk-software-window", foregroundRestored: true, output }, null, 2));
console.log(JSON.stringify({ passed: true, output }));
