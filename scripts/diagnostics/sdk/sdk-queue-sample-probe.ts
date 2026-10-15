// Explicit independent sample only. No install/restart, and no device work on import.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { getDebugTarget } from "../../../electron/device/target";
import { waitForSessionProbeRestoration } from "../../session-probe-restoration";
import { createQueueDeviceAdapters, type QueueDeviceExecute } from "./sdk-queue-device";
import { createQueueObservation, type ObservationReport, type ObservationTarget } from "./sdk-queue-observation";
import { verifyLocalQueueBuild } from "./sdk-queue-build";
import { verifyInstalledQueueApk, verifyQueueProcess } from "./sdk-queue-identity";
import { parseProcessLoad } from "./sdk-device-load";
import type { QueueEvent } from "./sdk-queue-observer";
import { waitForQueueLog } from "./sdk-queue-log";

const pkg = "com.androiduiinspector.sample", component = `${pkg}/${pkg}.QueueObservationActivity`;
export function isQueueSampleComponent(value: string) {
  return value === component || value === `${pkg}/.QueueObservationActivity`;
}
type HoldState = { requestId: string; pid: number; postedMs: number; enteredMs: number; endedMs: number; observedMs: number; limitMs: number };
export function parseSampleHoldReply(reply: string, expected: { requestId: string; pid: number }): HoldState {
  if (Buffer.byteLength(reply) > 2048) throw Error("Sample hold reply limit exceeded");
  const match = /^Result: Bundle\[\{(?:result=ok, state=(\{[^\r\n]*\})|state=(\{[^\r\n]*\}), result=ok)\}\]$/.exec(reply.trim());
  if (!match) throw Error("Sample hold refused");
  const value = JSON.parse(match[1] ?? match[2]) as HoldState;
  const keys = ["requestId", "pid", "postedMs", "enteredMs", "endedMs", "observedMs", "limitMs"];
  if (!value || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(key => key in value)
    || value.requestId !== expected.requestId || value.pid !== expected.pid || value.limitMs !== 1800
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.requestId)
    || !Number.isSafeInteger(value.postedMs) || value.postedMs < 0
    || !Number.isSafeInteger(value.observedMs) || value.observedMs < value.postedMs
    || ![value.enteredMs, value.endedMs].every(n => n === -1 || Number.isSafeInteger(n) && n >= value.postedMs && n <= value.observedMs)
    || value.enteredMs !== -1 && value.endedMs !== -1 && value.endedMs < value.enteredMs)
    throw Error("Invalid sample hold identity/state");
  return value;
}

export function validateQueueSampleArgs(args: string[]) {
  if (args.length !== 2 || !/^[\w.-]+$/.test(args[0]) || args[1] !== "--run")
    throw Error("Usage: bun scripts/diagnostics/sdk/sdk-queue-sample-probe.ts SERIAL --run (installed Debug sample only)");
  return args[0];
}

// A lost release reply does not prove the Android operation failed. Still read once,
// preserving the original error; never replay release or treat it as a capture retry.
export async function finishSampleHold(control: (method: "release" | "read") => Promise<HoldState>) {
  const failures: string[] = [];
  let state: HoldState | undefined;
  try { await control("release"); }
  catch (error) { failures.push(`sample release: ${String(error).slice(0, 300)}`); }
  try {
    state = await control("read");
    if (state.endedMs === -1) failures.push("sample main hold not confirmed released");
  } catch (error) { failures.push(`sample release state: ${String(error).slice(0, 300)}`); }
  return { state, failures };
}

export async function runQueueSampleProbe(serial: string) {
  validateQueueSampleArgs([serial, "--run"]);
  const directory = resolve(".benchmarks"); mkdirSync(directory, { recursive: true });
  const output = mkdtempSync(join(directory, "queue-sample-"));
  const now = () => Math.floor(performance.now());
  const timings: Array<{ name: string; startMs: number; endMs?: number; error?: string }> = [];
  const failures: string[] = [];
  const attempts = { preparatoryTree: 0, sampleHold: 0, diagnosticCapture: 0 };
  const timed = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const row = { name, startMs: now() } as typeof timings[number];
    if (timings.length >= 64) throw Error("Sample observation timing limit exceeded");
    timings.push(row);
    try { return await work(); } catch (error) { row.error = String(error).slice(0, 300); throw error; }
    finally { row.endMs = now(); }
  };
  const adb = async (args: string[], timeout = 2000, signal?: AbortSignal, maxBuffer = 8192) =>
    (await promisify(execFile)("adb", ["-s", serial, ...args], { timeout, signal, maxBuffer, encoding: "utf8" })).stdout;
  const execute: QueueDeviceExecute = (args, timeout, signal) => {
    assert.deepEqual(args.slice(0, 2), ["-s", serial]);
    const name = args[2] === "forward" ? `forward ${args[3]}` : "SDK open-session";
    return timed(name, () => adb(args.slice(2), timeout, signal));
  };
  let previous: Awaited<ReturnType<typeof getDebugTarget>> | undefined;
  let opened = false, armAttempted = false, businessPid: string | undefined, forwardsBefore: string | undefined;
  let target: ObservationTarget | undefined, observation: ObservationReport | undefined;
  let idle: ReturnType<typeof createQueueDeviceAdapters> | undefined, idlePrepared = false;
  let queued: { event: QueueEvent; receivedHostMs: number; closedHostMs: number } | undefined;
  let arm: HoldState | undefined, holdAfter: HoldState | undefined, finalTask: QueueEvent | undefined;
  let cleanupConfirmed = false, foregroundRestored = false, identityConfirmed = false;
  let build: Awaited<ReturnType<typeof verifyLocalQueueBuild>> | undefined;
  const hold = (method: "arm" | "read" | "release", signal?: AbortSignal) => {
    assert.ok(target && target.packageName === pkg);
    const expected = target;
    return timed(`sample hold ${method}`, async () => parseSampleHoldReply(await adb(["shell", "content", "call", "--uri",
      `content://${pkg}.queue-hold`, "--method", method, "--arg", expected.requestId,
      // Content CLI startup alone was ~1125ms on this device. This control deadline
      // is outside queue-notice admission; the 1800ms hold and 250ms freshness stay fixed.
      "--extra", `pid:i:${expected.pid}`], 2000, signal), expected));
  };
  try {
    previous = await getDebugTarget(serial, undefined, AbortSignal.timeout(5000));
    assert.ok(previous.packageName === pkg || previous.packageName === "com.smile.gifmaker", "unrelated foreground app: stop");
    if (previous.packageName === "com.smile.gifmaker") businessPid = (await adb(["shell", "pidof", previous.packageName])).trim();
    assert.ok(!isQueueSampleComponent(previous.component), "sample hold is single-use; do not replay a prior sample session");
    forwardsBefore = (await adb(["forward", "--list"])).trim();
    opened = true; // A lost launch reply still requires guarded restoration.
    await adb(["shell", "am", "start", "-W", "-n", component], 5000);
    const active = await getDebugTarget(serial, pkg, AbortSignal.timeout(4000)); assert.ok(isQueueSampleComponent(active.component));
    const pid = Number((await adb(["shell", "pidof", pkg])).trim()); assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const stat = await adb(["exec-out", "run-as", pkg, "cat", `/proc/${pid}/stat`]);
    const startTicks = String(parseProcessLoad(stat, String(pid)).startTicks);
    // One plain preparatory tree establishes the live SDK instance; not the diagnostic request.
    const baselineRequest = randomUUID();
    attempts.preparatoryTree++;
    const baseline = await timed("preparatory tree (one)", () => adb(["shell", "content", "call", "--uri",
      `content://${pkg}.inspector`, "--method", "capture", "--arg", baselineRequest], 5000));
    assert.equal(baseline.trim(), "Result: Bundle[{result=ok}]");
    const tree = JSON.parse(await adb(["exec-out", "run-as", pkg, "head", "-c", "4000001", "no_backup/inspector-hierarchy.json"], 2000, undefined, 4_000_001));
    assert.equal(tree.packageName, pkg); assert.equal(tree.pid, pid); assert.ok(tree.root);
    target = { serial, packageName: pkg, pid, startTicks, processInstance: tree.processInstance, requestId: randomUUID(),
      apkPath: resolve("android/sample-app/build/outputs/apk/debug/sample-app-debug.apk"),
      aarPath: resolve("android/inspector-sdk/build/outputs/aar/inspector-sdk-debug.aar") };
    build = await verifyLocalQueueBuild(target.apkPath, target.aarPath, AbortSignal.timeout(5000));
    idle = createQueueDeviceAdapters(target, { execute });
    await idle.prepareCapture(target, AbortSignal.timeout(5000)); // Own independent scalar reader; capture uses the second client.
    idlePrepared = true;
    const reader = idle;
    const device = createQueueDeviceAdapters(target, { execute });
    const pinned = target;
    observation = await createQueueObservation(pinned, { ...device, now,
      captureOnce: async (actual, options, signal) => {
        assert.equal(actual.requestId, pinned.requestId); armAttempted = true; attempts.sampleHold++;
        arm = await hold("arm", signal); assert.ok(arm.enteredMs !== -1 && arm.endedMs === -1, "hold ended before request; stop");
        attempts.diagnosticCapture++;
        return timed("diagnostic capture (one)", () => device.captureOnce(actual, options, signal));
      },
      process: (actual, signal) => timed("system process recheck", () => verifyQueueProcess(actual, signal)),
      runtime: (actual, signal) => timed("runtime SDK recheck (session)", () => reader.readRuntime(actual, signal)),
      state: (actual, signal) => timed("queue state read (session)", () => reader.readState(actual, signal)),
      subscribe: async (actual, signal) => {
        const value = await waitForQueueLog(actual, signal, { now });
        queued = { event: JSON.parse(value.json), receivedHostMs: value.receivedHostMs, closedHostMs: now() };
        return value;
      },
    }).run(AbortSignal.timeout(20000));
  } catch (error) { failures.push(String(error).slice(0, 500)); }
  finally {
    if (target && armAttempted) {
      const released = await finishSampleHold(method => hold(method));
      holdAfter = released.state; failures.push(...released.failures);
      try {
        if (attempts.diagnosticCapture === 1 && observation?.identity) {
          assert.ok(idlePrepared && idle, "independent diagnostic reader unavailable");
          finalTask = await idle.readState({ ...target, identity: observation.identity }, AbortSignal.timeout(1000));
          assert.ok(finalTask.settledMs !== -1, "Android request still active; no recovery/capture retry");
        }
      } catch (error) { failures.push(`Android hold/task cleanup: ${String(error)}`); }
    }
    if (target && build) {
      try {
        await verifyQueueProcess(target, AbortSignal.timeout(1500));
        assert.ok(idlePrepared && idle, "independent diagnostic reader unavailable");
        await idle.readRuntime({ ...target, sourceSha256: build.sourceSha256 }, AbortSignal.timeout(2500));
        await verifyInstalledQueueApk(target, build.apkSha256, AbortSignal.timeout(7500)); identityConfirmed = true;
      } catch (error) { failures.push(`post observation identity: ${String(error)}`); }
    }
    try { await idle?.closeCapture(); } catch (error) { failures.push(`idle cleanup: ${String(error)}`); }
    try {
      if (forwardsBefore !== undefined) {
        assert.equal((await adb(["forward", "--list"])).trim(), forwardsBefore);
        cleanupConfirmed = observation?.cleanup.forwardRemoved === true && observation.cleanup.captureConnectionClosed === true;
      }
    } catch (error) { failures.push(`forward cleanup: ${String(error)}`); }
    if (opened && previous) {
      try {
        const active = await getDebugTarget(serial, pkg, AbortSignal.timeout(3000)); assert.ok(isQueueSampleComponent(active.component));
        await adb(["shell", "input", "keyevent", "KEYCODE_BACK"]); // Finish our sample only, never launch/restart business.
        await waitForSessionProbeRestoration(previous, signal => getDebugTarget(serial, previous!.packageName, signal));
        if (businessPid) assert.equal((await adb(["shell", "pidof", previous.packageName])).trim(), businessPid);
        foregroundRestored = true;
      } catch (error) { failures.push(`foreground restoration: ${String(error)}`); }
    }
  }
  const safetyPassed = failures.length === 0 && cleanupConfirmed && identityConfirmed && foregroundRestored
    && holdAfter?.endedMs !== undefined && holdAfter.endedMs !== -1 && finalTask?.settledMs !== undefined && finalTask.settledMs !== -1
    && observation?.logClosed === true && observation.captureReplySettled;
  const passed = safetyPassed && observation?.status === "queue-covered";
  writeFileSync(join(output, "report.json"), JSON.stringify({ passed, safetyPassed,
    scope: "one controlled sample hold + one preparatory tree + one diagnostic request; not business root cause/pixels/performance",
    previous: previous && { packageName: previous.packageName, component: previous.component, windowId: previous.windowId }, attempts,
    target, build, observation, queued, arm, holdAfter, finalTask, timings, failures,
    cleanupConfirmed, identityConfirmed, foregroundRestored, businessPid, idlePrepared,
  }, null, 2));
  return { passed, safetyPassed, status: observation?.status, error: observation?.error, output };
}

if (import.meta.main) {
  const serial = validateQueueSampleArgs(process.argv.slice(2));
  const result = await runQueueSampleProbe(serial); console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
