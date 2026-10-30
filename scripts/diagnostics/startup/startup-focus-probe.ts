// Bounded cold-start diagnosis, not a capture/performance acceptance test.
// --restart --system-only: five sparse system-only samples; no App tree, SDK or process reads.
// Cannot combine --system-only with --first-dump. SIGINT/SIGTERM saves partial observations.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseFocusedWindowState } from "../../../electron/device/target";
import { verifyAppProcessName } from "../../../electron/device/app-process";
import { parseProcessLoad } from "../sdk/sdk-device-load";
import { startupDumpEvidence, startupDumpTarget } from "./startup-focus-validation";
import { observeStartupSystem } from "./startup-system-baseline";
const serial = process.argv[2], app = process.argv[3], activity = process.argv[4];
assert.ok(serial && /^[\w.-]+$/.test(serial));
assert.ok(app && /^[\w]+(?:\.[\w]+)+$/.test(app));
assert.ok(activity && /^[\w.$]+$/.test(activity));
const restart = process.argv.includes("--restart");
const withFirstDump = process.argv.includes("--first-dump");
const systemOnly = process.argv.includes("--system-only");
assert.ok(!systemOnly || !withFirstDump, "--system-only 禁止 --first-dump");
const output = join(import.meta.dirname, "../../../.benchmarks/startup-focus", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
console.log(output);
let deadline: number | null = null;
const adb = (...args: string[]) => {
  const remaining = deadline === null ? 6000 : Math.floor(deadline - performance.now());
  if (remaining < 1500) throw new Error("观察预算已耗尽，不再发起查询");
  return execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: Math.min(6000, remaining), maxBuffer: 5000000 });
};
const launchStarted = performance.now();
if (restart) {
  adb("shell", "am", "force-stop", app);
  adb("shell", "am", "start", "-n", `${app}/${activity}`);
}
const launchEnded = performance.now();
if (systemOnly) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("用户取消启动观察"));
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const launch = { restart, component: `${app}/${activity}`, startCommandAndStopMs: Math.round(launchEnded - launchStarted),
    launchStartedAtUtc: new Date(Date.now() - (performance.now() - launchStarted)).toISOString(),
    launchEndedAtUtc: new Date(Date.now() - (performance.now() - launchEnded)).toISOString(),
    observationOrigin: "after launch command returned; no hidden warmup" };
  const partial: unknown[] = [];
  try {
    const result = await observeStartupSystem({ component: `${app}/${activity}`, now: () => performance.now(), signal: controller.signal,
      sleep: (ms, signal) => delay(ms, undefined, { signal }),
      read: async (args, timeout, signal) => (await promisify(execFile)("adb", ["-s", serial, ...args],
        { encoding: "utf8", timeout, signal, maxBuffer: 5000000 })).stdout,
      onSample(sample) {
        partial.push(sample);
        writeFileSync(join(output, "summary.json"), JSON.stringify({ launch, systemOnly, status: "in-progress", records: partial }, null, 2));
        console.log(JSON.stringify(sample));
      },
    });
    writeFileSync(join(output, "summary.json"), JSON.stringify({ launch, systemOnly, ...result }, null, 2));
    process.exitCode = result.status === "cancelled" ? 130 : result.status === "budget-exhausted" ? 1 : 0;
  } finally {
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  }
  process.exit(process.exitCode ?? 0);
}
const started = performance.now(), records: any[] = [];
deadline = started + 30000;
let firstDump: Record<string, unknown> | null = null;
const save = () => writeFileSync(join(output, "summary.json"), JSON.stringify({ restart, withFirstDump,
  dumpTrigger: "confirmed foreground instance and unique live process", firstDump, records,
  scope: "bounded system-window diagnosis; no image requests" }, null, 2));
const processIdentity = () => {
  const activities = adb("shell", "dumpsys", "activity", "activities");
  const pidOutput = adb("shell", "pidof", app);
  const target = startupDumpTarget(activities, `${app}/${activity}`, pidOutput);
  verifyAppProcessName(0, Buffer.from(adb("exec-out", "run-as", app, "cat", `/proc/${target.pid}/cmdline`)), app);
  const { startTicks } = parseProcessLoad(adb("exec-out", "run-as", app, "cat", `/proc/${target.pid}/stat`), String(target.pid));
  return { ...target, startTicks };
};
for (const at of [0, 2000, 6000, 10000, 14000, 18000, 22000]) {
  if (deadline - performance.now() < 1500) break;
  const remaining = at - (performance.now() - started);
  if (remaining > 0) await delay(remaining);
  const record: any = { elapsedMs: Math.round(performance.now() - started) };
  for (const [name, args] of [["activities", ["shell", "dumpsys", "activity", "activities"]],
    ["windows", ["shell", "dumpsys", "window", "windows"]], ["displays", ["shell", "dumpsys", "window", "displays"]]] as const) {
    try {
      const text = adb(...args);
      writeFileSync(join(output, `${at}-${name}.txt`), text);
      record[name] = { observedMs: Math.round(performance.now() - started), ...parseFocusedWindowState(text), lines: text.split(/\r?\n/).filter(line =>
        /mCurrentFocus=|mTopFocusedDisplayId=|Display: mDisplayId=|topResumedActivity=|mResumedActivity:/.test(line)).slice(0, 16) };
    } catch (error) { record[name] = { error: String(error) }; }
  }
  // Both groups use the same read-only eligibility checks. Only one group issues the App dump.
  let identity: ReturnType<typeof processIdentity> | null = null;
  try { identity = processIdentity(); record.process = { observedMs: Math.round(performance.now() - started), ...identity }; }
  catch (error) { record.process = { observedMs: Math.round(performance.now() - started), error: String(error) }; }
  records.push(record);
  save();
  console.log(JSON.stringify({ elapsedMs: record.elapsedMs, windows: record.windows.focus, displays: record.displays.focus }));
  if (!firstDump && withFirstDump && identity && deadline - performance.now() >= 6000) {
    const dumpStarted = Math.round(performance.now() - started);
    firstDump = { startedMs: dumpStarted, before: identity };
    save(); // An interrupted/failed request must still count as the one allowed dump.
    try {
      const text = adb("shell", "dumpsys", "activity", app);
      writeFileSync(join(output, "first-activity-dump.txt"), text);
      Object.assign(firstDump, { completedMs: Math.round(performance.now() - started), bytes: Buffer.byteLength(text) });
      const evidence = startupDumpEvidence(text, identity);
      const after = processIdentity();
      const identityStable = after.activityRecordId === identity.activityRecordId && after.pid === identity.pid && after.startTicks === identity.startTicks;
      Object.assign(firstDump, { after, identityStable, ...evidence });
    } catch (error) {
      writeFileSync(join(output, "first-activity-dump-error.txt"), String(error));
      firstDump.completedMs ??= Math.round(performance.now() - started);
      firstDump.error = String(error);
    }
    save();
  }
  if (performance.now() - started > 30000) break;
}
