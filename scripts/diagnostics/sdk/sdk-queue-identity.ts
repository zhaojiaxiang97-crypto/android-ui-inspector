// Read-only adapters. APK verification is preflight work, never part of the 250ms queue window.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { verifyAppProcessName } from "../../../electron/device/app-process";
import { parseProcessLoad } from "./sdk-device-load";

type Target = { serial: string; packageName: string };
type Execute = (args: string[], timeoutMs: number, signal: AbortSignal) => Promise<Buffer>;
const executeAdb: Execute = async (args, timeout, signal) =>
  (await promisify(execFile)("adb", args, { timeout, signal, encoding: "buffer", maxBuffer: 8192 })).stdout;
function validate(target: Target) {
  if (!/^[\w.-]+$/.test(target.serial) || !/^[\w]+(?:\.[\w]+)+$/.test(target.packageName)) throw Error("Invalid identity target");
}
async function read(target: Target, args: string[], timeout: number, signal: AbortSignal, execute: Execute) {
  signal.throwIfAborted();
  const value = await execute(["-s", target.serial, ...args], timeout, signal);
  signal.throwIfAborted();
  if (!Buffer.isBuffer(value) || value.length > 8192) throw Error("Invalid identity reply");
  return value;
}
function apkPath(output: Buffer) {
  // Split APKs require a complete multi-artifact admission; do not silently hash just base.apk.
  const match = /^package:(\/data\/app\/[A-Za-z0-9_./=+~-]+\.apk)\s*$/.exec(output.toString());
  if (!match || match[1].includes("..")) throw Error("APK path unavailable or split install unsupported");
  return match[1];
}

/** Confirms installed single APK bytes against a caller's known artifact hash.
 * This does NOT prove which SDK build was incorporated into that APK.
 */
export async function verifyInstalledQueueApk(target: Target, expectedSha256: string, signal: AbortSignal,
  execute: Execute = executeAdb) {
  target = { ...target };
  validate(target);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw Error("Known APK digest required");
  const path = apkPath(await read(target, ["shell", "pm", "path", target.packageName], 1500, signal, execute));
  const digest = (await read(target, ["shell", "sha256sum", path], 5000, signal, execute)).toString().trim();
  if (digest !== `${expectedSha256}  ${path}`) throw Error("Installed APK digest mismatch");
  const after = apkPath(await read(target, ["shell", "pm", "path", target.packageName], 1500, signal, execute));
  if (after !== path) throw Error("Installed APK replaced during verification");
  return { apkSha256: expectedSha256, installedPath: path };
}

/** One read-only run-as cat brackets cmdline with real /proc stats. No SDK identity substitutes.
 * /proc/stat ends in LF; Android main cmdline is its name plus NUL padding. Reject ambiguous
 * framing/extra arguments instead of guessing or falling back to additional commands.
 */
export async function verifyQueueProcess(target: Target & { pid: number; startTicks: string }, signal: AbortSignal,
  execute: Execute = executeAdb) {
  target = { ...target };
  validate(target);
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || !/^\d+$/.test(target.startTicks)) throw Error("Invalid process identity");
  const statPath = `/proc/${target.pid}/stat`;
  const output = await read(target, ["exec-out", "run-as", target.packageName, "cat",
    statPath, `/proc/${target.pid}/cmdline`, statPath], 250, signal, execute);
  return parseProcessIdentity(output, target, target.startTicks);
}

function parseProcessIdentity(output: Buffer, target: Target & { pid: number }, expectedStart?: string) {
  const firstEnd = output.indexOf(10), nameEnd = output.indexOf(0, firstEnd + 1);
  if (firstEnd < 1 || nameEnd <= firstEnd + 1) throw Error("Invalid process identity framing");
  const before = String(parseProcessLoad(output.subarray(0, firstEnd).toString(), String(target.pid)).startTicks);
  if (expectedStart !== undefined && before !== expectedStart) throw Error("Process start identity changed");
  verifyAppProcessName(0, output.subarray(firstEnd + 1, nameEnd + 1), target.packageName);
  let lastStart = nameEnd + 1;
  while (output[lastStart] === 0) lastStart++;
  if (output.indexOf(10, lastStart) !== output.length - 1 || output.indexOf(0, lastStart) !== -1)
    throw Error("Invalid process identity framing");
  const after = String(parseProcessLoad(output.subarray(lastStart, -1).toString(), String(target.pid)).startTicks);
  if (after !== before) throw Error("Process start identity changed");
  return { pid: target.pid, startTicks: before };
}

/** Observe an already requested main-process launch, not App/UI readiness.
 * pidof may return empty immediately after am start; only this absence is observed again.
 * Fixed 1s/10-read limit, no launch/tree/SDK calls. Once a PID is found, identity errors stop.
 * The business diagnostic still requires the resulting pinned identity explicitly.
 */
export async function observeQueueMainProcess(target: Target, signal: AbortSignal, dependencies: {
  execute?: Execute; now?: () => number; wait?: (ms: number, signal: AbortSignal) => Promise<void>;
} = {}) {
  target = { ...target }; validate(target); signal.throwIfAborted();
  const execute = dependencies.execute ?? executeAdb, now = dependencies.now ?? (() => performance.now());
  const wait = dependencies.wait ?? ((ms, checkSignal) => delay(ms, undefined, { signal: checkSignal }));
  const started = now(), deadline = started + 1000;
  for (let pidReads = 1; pidReads <= 10; pidReads++) {
    signal.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) break;
    let output: Buffer;
    try { output = await read(target, ["shell", "pidof", target.packageName], Math.min(250, Math.ceil(remaining)), signal, execute); }
    catch (error) {
      signal.throwIfAborted();
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      // Node execFile's exit 1 with empty stdout/stderr is pidof's ordinary "not present".
      if (failure?.code !== 1 || !Buffer.isBuffer(failure.stdout) || failure.stdout.length
        || !Buffer.isBuffer(failure.stderr) || failure.stderr.length) throw error;
      output = Buffer.alloc(0);
    }
    signal.throwIfAborted();
    const pidText = output.toString().trim();
    if (now() >= deadline) throw Error("Main process observation deadline exceeded");
    if (pidText) {
      if (!/^[1-9]\d*$/.test(pidText) || !Number.isSafeInteger(Number(pidText))) throw Error("Main PID unavailable or ambiguous");
      const pid = Number(pidText), statPath = `/proc/${pid}/stat`;
      const process = parseProcessIdentity(await read(target, ["exec-out", "run-as", target.packageName, "cat",
        statPath, `/proc/${pid}/cmdline`, statPath], Math.min(250, Math.ceil(deadline - now())), signal, execute), { ...target, pid });
      if (now() >= deadline) throw Error("Main process observation deadline exceeded");
      return { ...process, pidReads, elapsedMs: now() - started };
    }
    if (pidReads < 10) await wait(Math.min(100, deadline - now()), signal);
  }
  throw Error("Main process not observed within 1000ms; no diagnostic issued");
}
