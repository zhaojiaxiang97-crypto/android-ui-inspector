// Independent sample only. Android queue failure + desktop guard, not a full IPC fault injection.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { checkSdkMergedTreeOutcome, settleSdkMergedTree } from "../../../electron/sdk/capture-protocol";

const serial = process.argv[2];
assert.ok(serial && /^[\w.:-]+$/.test(serial), "Usage: bun scripts/diagnostics/sdk/sdk-merged-tree-failure-probe.ts SERIAL");
const app = "com.androiduiinspector.sample", file = "files/merged-tree-failure-probe.json";
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 15000, maxBuffer: 2000000 });
mkdirSync(".benchmarks", { recursive: true });
const output = mkdtempSync(".benchmarks/merged-tree-device-");
try { writeFileSync(`${output}/previous.json`, adb("exec-out", "run-as", app, "cat", file)); } catch { }
adb("shell", "am", "force-stop", app);
adb("shell", "run-as", app, "rm", "-f", file);
adb("shell", "am", "start", "-n", `${app}/.MainActivity`, "--es", "mode", "merged-tree-failure");
let report: any;
for (let i = 0; i < 40; i++) {
  await wait(500);
  try { report = JSON.parse(adb("exec-out", "run-as", app, "cat", file).toString()); break; } catch { }
}
assert.ok(report, "Sample did not return a fresh report");
writeFileSync(`${output}/result.json`, JSON.stringify(report, null, 2));
assert.equal(report.passed, true, report.error);
assert.equal(adb("shell", "pidof", app).toString().trim(), String(report.pid));
const outcome = { reply: { code: 0, stdout: Buffer.from("Bundle[{" + Object.entries(report.failure).map(([k, v]) => `${k}=${v}`).join(", ") + "}]") }, error: null };
let treeReads = 0, classicFallbacks = 0;
await assert.rejects(settleSdkMergedTree(Promise.resolve(outcome), async () => { treeReads++; return undefined; }, async () => {},
  () => { classicFallbacks++; }, value => checkSdkMergedTreeOutcome(value, report.failure.nonce, report.failure.processInstance)), /SDK 控件树超时/);
assert.equal(treeReads, 0); assert.equal(classicFallbacks, 0);
const logs = adb("logcat", "-d", "--pid=" + report.pid, "-s", "InspectorTree:D", "*:S").toString();
writeFileSync(`${output}/tree.log`, logs);
assert.equal((logs.match(/phase=merged-tree pid=/g) || []).length, 2, "Expected one failed request and one recovery");
assert.equal((logs.match(/posted=\d+ entered=-1 ended=-1/g) || []).length, 1, "Expected exactly one unentered tree task");
const summary = { passed: true, failureMs: report.failureMs, recoveredLayers: report.recovery.count,
  sameProcess: true, treeReads, classicFallbacks, scope: "real Android queue + internal SDK capture + desktop outcome guard", output };
writeFileSync(`${output}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
