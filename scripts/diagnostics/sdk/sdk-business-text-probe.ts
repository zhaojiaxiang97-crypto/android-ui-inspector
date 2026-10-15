// Stable business-page comparison only. Never install, restart or navigate.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { businessTextAdmission } from "../../business-text-admission";
import { parseProcessLoad } from "./sdk-device-load";
import { businessSettingsPid } from "../../business-process";
const serial = process.argv[2], text = process.argv[3] ?? "设置";
assert.ok(serial && /^[\w.-]+$/.test(serial) && text.length > 0 && text.length <= 256);
const app = "com.smile.gifmaker";
const output = join(import.meta.dirname, "../../../.benchmarks/business-text", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 15000 });
const records: any[] = [];
console.log(`Business text output: ${output}`);
let pid: string, startTicks: number, instance: string, signature: string | undefined, baseline: string | undefined;
const page = () => assert.match(adb("shell", "dumpsys", "window"),
  /mCurrentFocus=.*com\.smile\.gifmaker\/com\.yxcorp\.plugin\.setting\.activity\.SettingsActivity/,
  "keep the stable business settings page foreground");
try {
  page(); pid = businessSettingsPid(adb, app);
  const clockTicks = Number(adb("shell", "getconf", "CLK_TCK").trim());
  assert.ok(Number.isSafeInteger(clockTicks) && clockTicks > 0);
  const state = () => {
    assert.equal(businessSettingsPid(adb, app), pid, "process changed");
    const load = parseProcessLoad(adb("exec-out", "run-as", app, "cat", `/proc/${pid}/stat`), pid);
    const uptimeSeconds = Number(adb("shell", "cat", "/proc/uptime").trim().split(/\s+/)[0]);
    assert.ok(Number.isFinite(uptimeSeconds) && uptimeSeconds >= load.startTicks / clockTicks);
    return { ...load, ageMs: Math.round((uptimeSeconds - load.startTicks / clockTicks) * 1000) };
  };
  startTicks = state().startTicks;
  const admission = () => {
    page(); assert.equal(state().startTicks, startTicks);
    assert.match(adb("shell", "content", "call", "--uri", `content://${app}.inspector`, "--method", "capture"), /result=ok/);
    const tree = JSON.parse(adb("exec-out", "run-as", app, "cat", "no_backup/inspector-hierarchy.json"));
    const result = businessTextAdmission(tree, text, Number(pid));
    writeFileSync(join(output, `admission-${records.length}.json`), JSON.stringify(result, null, 2));
    assert.equal(result.eligible, true, result.reasons.join("; "));
    instance ??= result.processInstance; assert.equal(result.processInstance, instance);
    return result.target!;
  };
  const target = admission();
  for (const enabled of [false, true, true, false]) {
    const current = admission(); assert.equal(current.ref, target.ref);
    const before = state();
    const args = [join(import.meta.dirname, "../../device-health-check.ts"), `--serial=${serial}`, "--require-device",
      `--app=${app}`, "--reuse-app", "--single-attempt", "--refresh-node", "--refresh-pixels", `--refresh-text=${text}`];
    if (baseline) args.push(`--expected-refresh-sha=${baseline}`);
    const child = spawn(process.execPath, args, { env: { ...process.env, INSPECTOR_ENABLE_SDK_TEXT_REFRESH: enabled ? "1" : "0" } });
    let log = ""; child.stdout.on("data", value => { log += value.toString(); }); child.stderr.on("data", value => { log += value.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    writeFileSync(join(output, `block-${records.length}.log`), log);
    const directory = /Device health check output: (.+)/.exec(log)?.[1];
    const after = state();
    const record: any = { enabled, code, before, after, directory: directory ?? null };
    records.push(record); writeFileSync(join(output, "attempts.json"), JSON.stringify(records, null, 2));
    assert.equal(after.startTicks, startTicks); page(); assert.equal(code, 0, "health/refresh failed; stop, keep original logs");
    assert.ok(directory && directory.startsWith(join(import.meta.dirname, "../../../.benchmarks/device-health-check/")));
    const names = readdirSync(directory);
    const captures = names.filter(n => /^health-\d+\.json$/.test(n)); assert.equal(captures.length, 1, "no probe retry allowed");
    const capture = JSON.parse(readFileSync(join(directory, captures[0]), "utf8"));
    assert.equal(capture.value.captureRequestDiagnostics?.totalAttempts, 1, "internally retried captures are not strict baselines");
    assert.equal(capture.value.debugProcessId, pid);
    record.captureMs = capture.durationMs; record.nodeCount = capture.value.nodeCount; record.coverage = capture.value.coverage;
    const refreshNames = names.filter(n => n.endsWith("-refresh.json")); assert.equal(refreshNames.length, 1);
    const refresh = JSON.parse(readFileSync(join(directory, refreshNames[0]), "utf8")); assert.equal(refresh.samples.length, 3);
    for (const sample of refresh.samples) {
      const v = sample.value;
      assert.equal(sample.accepted, true); assert.equal(sample.boundsMatchBaseline, true);
      assert.equal(v.ref, target.ref); assert.equal(v.className, target.className);
      assert.equal(v.hardwareAccelerated, "true"); assert.equal(v.route, enabled ? "sdk-text-hardware" : "jdwp");
      assert.equal(v.pixels.width, v.bounds.right - v.bounds.left);
      assert.equal(v.pixels.height, v.bounds.bottom - v.bounds.top);
      baseline ??= v.pixels.sha256; assert.equal(v.pixels.sha256, baseline);
      const next = JSON.stringify({ ref: v.ref, bounds: v.bounds, pixels: v.pixels });
      signature ??= next; assert.equal(next, signature);
    }
    record.refreshMs = refresh.samples.map((s: any) => s.durationMs); record.route = refresh.samples[0].value.route;
    assert.equal(admission().ref, target.ref);
    writeFileSync(join(output, "attempts.json"), JSON.stringify(records, null, 2));
    console.log(JSON.stringify({ block: records.length, enabled, captureMs: record.captureMs, refreshMs: record.refreshMs, ageMs: before.ageMs }));
  }
  writeFileSync(join(output, "summary.json"), JSON.stringify({ passed: true, records,
    scope: "same-process ABBA correctness and observed timings; not age-matched new-process performance acceptance" }, null, 2));
} catch (error) {
  writeFileSync(join(output, "summary.json"), JSON.stringify({ passed: false, error: String(error), records }, null, 2));
  console.error(String(error)); process.exitCode = 1;
}
