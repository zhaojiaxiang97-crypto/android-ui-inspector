// Sample-only fault gates. No APK install, business restart or production timeout changes.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const serial = process.argv[2];
assert.ok(serial && /^[\w.-]+$/.test(serial), "SERIAL required");
const sample = "com.androiduiinspector.sample";
const output = join(import.meta.dirname, "../../../.benchmarks/ui-wake", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 30000 });
const previous = /mCurrentFocus=.*?\bu\d+\s+([\w.]+\/[\w.$]+)/.exec(adb("shell", "dumpsys", "window"))?.[1];
const initialForwards = new Set(adb("forward", "--list").trim().split("\n"));
const settings = adb("shell", "dumpsys", "package", sample);
const user = /User 0:[^\n]*\n([\s\S]*?)(?:\n\S|$)/.exec(settings)?.[1];
assert.ok(user !== undefined && !user.includes("com.androiduiinspector.sdk.HierarchyProvider"), "sample Provider must initially use its manifest default; preserve explicit user settings");
let providerChanged = false;
const results: unknown[] = [];
const samplePids = new Set<string>();
console.log(`UI wake output: ${output}`);
const start = (providerEnabled = true) => {
  adb("shell", "am", "start", "-S", "-W", "-n", `${sample}/.SoftwareTextActivity`, "--ez", "inspectorProviderEnabled", String(providerEnabled));
  const pid = adb("shell", "pidof", sample).trim();
  assert.match(pid, /^\d+$/); samplePids.add(pid); return pid;
};
async function probe(mode: string) {
  const pid = start(mode !== "--no-sdk-wake");
  if (mode === "--no-sdk-wake") assert.match(adb("shell", "dumpsys", "package", sample), /disabledComponents:\s*\n\s+com\.androiduiinspector\.sdk\.HierarchyProvider/, "SDK entry must really be disabled");
  const child = spawn(process.execPath, [join(import.meta.dirname, "sdk-text-desktop-cancel-probe.ts"), serial, "Admission Text", mode], { env: process.env });
  let log = "";
  child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
  let code: number | null;
  try { code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); }
  finally { clearTimeout(timer); }
  writeFileSync(join(output, mode.slice(2) + ".log"), log);
  assert.equal(code, 0, log.slice(-1800));
  const record = log.split("\n").filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(value => value.passed === true);
  assert.ok(record, "child gate must explicitly pass");
  assert.equal(adb("shell", "pidof", sample).trim(), pid, "no App crash or restart may be hidden by recovery");
  assert.ok(adb("shell", "dumpsys", "window").includes(`${sample}/${sample}.SoftwareTextActivity`));
  results.push(record); console.log(JSON.stringify(record));
}
try {
  await probe("--wake-ui");
  providerChanged = true; // restore even if the package-manager reply is interrupted
  await probe("--no-sdk-wake");
} finally {
  try {
    if (providerChanged) {
      start(true);
      // When launched with a disabled Provider, it wasn't installed before this
      // Activity's onResume. Restart after restoring manifest state so lifecycle
      // registration happens in the normal process-start order.
      start(true);
      assert.match(adb("shell", "content", "call", "--uri", `content://${sample}.inspector`, "--method", "capture"), /result=ok/, "Provider must recover after the unavailable-provider gate");
    }
    for (const line of adb("forward", "--list").trim().split("\n")) {
      const [device, local, remote] = line.trim().split(/\s+/);
      const ownRemote = remote === `localabstract:${sample}.inspector.session`
        || remote?.startsWith("jdwp:") && samplePids.has(remote.slice(5));
      if (!initialForwards.has(line) && device === serial && /^tcp:\d+$/.test(local ?? "") && ownRemote) adb("forward", "--remove", local);
    }
  } finally {
    adb("shell", "am", "force-stop", sample);
    if (previous && !previous.startsWith(sample + "/")) adb("shell", "am", "start", "-W", "-n", previous);
  }
}
writeFileSync(join(output, "summary.json"), JSON.stringify({ passed: true, results, providerRestored: true, scope: "sample-provider-disabled-not-sdk-free-apk" }, null, 2));
