// Read-only startup gate. No default device executor, SDK, socket, launch or sampling here.
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { verifyInstalledQueueApk, verifyQueueProcess } from "../sdk/sdk-queue-identity";

type ProcessTarget = { serial: string; packageName: string; pid: number; startTicks: string };
export type StartupAdmissionTarget = ProcessTarget & { component: string; apkSha256: string };
export type StartupLaunchOrigin = { runId: string; startedAt: number; authorized: true };
export type StartupReadExecute = (args: string[], timeoutMs: number, signal: AbortSignal) => Promise<Buffer>;
type Owner = { component: string; activityRecord: string; pid: number };
type WindowState = { mainWindow: boolean; focus: string | null };
type GateResult = { status: "window-ready" | "sample-due"; state: WindowState; observedMs: number };
const { waitForStackWindow } = createRequire(import.meta.url)("../../lib/startup-stack-observer.cjs") as {
  waitForStackWindow: (read: (remaining: number, signal: AbortSignal) => Promise<WindowState>, options: {
    startedAt: number; signal: AbortSignal; now: () => number; sleep: (ms: number) => Promise<void>;
  }) => Promise<GateResult>;
};
const dumpLimit = 2 * 1024 * 1024;
const budgetMs = 15000, triggerMs = 12000;
const canonical = (value: string) => value.replace(/\/\./, `/${value.split("/")[0]}.`);
function component(value: string, packageName: string) {
  if (typeof value !== "string" || !/^[\w]+(?:\.[\w]+)+\/(?:\.)?[\w.$]+$/.test(value)
    || value.split("/")[0] !== packageName) throw Error("Invalid startup component");
  return canonical(value);
}
function dump(text: string, header: string) {
  if (typeof text !== "string" || Buffer.byteLength(text) > dumpLimit || text.includes("\0")
    || !text.split(/\r?\n/).some(line => line.trim() === header)) throw Error("Unknown or oversized startup dump");
  return text.replace(/\r\n/g, "\n");
}
function one<T extends RegExpMatchArray>(matches: T[], message: string): T {
  if (matches.length !== 1) throw Error(message);
  return matches[0];
}
function record(text: string) {
  const match = /^ActivityRecord\{([a-f0-9]+) u0 ([\w.$/]+) t\d+[^}]*\}$/i.exec(text);
  if (!match) throw Error("Unknown startup Activity record");
  return { activityRecord: match[1].toLowerCase(), component: canonical(match[2]) };
}

/** Use the resumed record's exact token, not the first same-name historical task. */
export function parseStartupActivity(text: string, target: Pick<StartupAdmissionTarget, "component" | "packageName" | "pid">): Owner {
  const expected = component(target.component, target.packageName);
  text = dump(text, "ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)");
  const resumed = [...text.matchAll(/^\s*(?:topResumedActivity|mResumedActivity)[:=]\s*(.*)$/gm)];
  if (!resumed.length || resumed.length > 8) throw Error("Startup resumed Activity unavailable");
  const owners = resumed.map(value => record(value[1].trim()));
  const owner = owners[0];
  if (owners.some(value => value.activityRecord !== owner.activityRecord || value.component !== expected))
    throw Error("Startup foreground Activity changed or ambiguous");
  const headers = [...text.matchAll(/^[ \t]*\* Hist\s+#\d+: (ActivityRecord\{[^\n]+\})[ \t]*$/gm)];
  if (headers.length > 512 || (text.match(/^[ \t]*\* Hist\b/gm) ?? []).length !== headers.length)
    throw Error("Unknown startup Activity list");
  const matches = headers.filter(header => {
    const value = record(header[1]);
    return value.activityRecord === owner.activityRecord;
  });
  const header = one(matches, "Startup Activity owner unavailable or ambiguous");
  if (record(header[1]).component !== expected) throw Error("Startup Activity record changed");
  const at = headers.indexOf(header), block = text.slice(header.index! + header[0].length, headers[at + 1]?.index ?? text.length);
  const fields = one([...block.matchAll(/^\s*packageName=(\S+) processName=(\S+)\s*$/gm)], "Startup Activity process fields unavailable");
  const app = one([...block.matchAll(/^\s*app=(.*)$/gm)], "Startup Activity process unavailable");
  const process = /^ProcessRecord\{[a-f0-9]+ ([1-9]\d*):([^/\s]+)\/[^}]+\}$/i.exec(app[1].trim());
  if (fields[1] !== target.packageName || fields[2] !== target.packageName || !process
    || process[2] !== target.packageName || Number(process[1]) !== target.pid)
    throw Error("Startup Activity belongs to another or unavailable process");
  return { ...owner, pid: target.pid };
}

/** Missing/unsupported dump fields are unknown, never proof that no main window exists.
 * Only a window's own attributes/session/Activity establish ownership; references do not.
 */
export function parseStartupWindows(windows: string, displays: string,
  target: Pick<StartupAdmissionTarget, "component" | "packageName" | "pid">, owner: Owner): WindowState {
  if (owner.component !== component(target.component, target.packageName) || owner.pid !== target.pid
    || !/^[a-f0-9]+$/.test(owner.activityRecord)) throw Error("Startup window owner target changed");
  windows = dump(windows, "WINDOW MANAGER WINDOWS (dumpsys window windows)");
  displays = dump(displays, "WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)");
  const top = one([...windows.matchAll(/^\s*mTopFocusedDisplayId=(\d+)\s*$/gm)], "Unknown focused display");
  const display = one([...displays.matchAll(/^\s*Display: mDisplayId=(\d+)\b[^\n]*$/gm)], "Unknown or multiple displays");
  if (top[1] !== "0" || display[1] !== "0") throw Error("Startup is not on the primary display");
  const focusedApp = one([...displays.matchAll(/^\s*mFocusedApp=(.*)$/gm)], "Unknown focused App");
  const focusedOwner = record(focusedApp[1].trim());
  if (focusedOwner.component !== owner.component || focusedOwner.activityRecord !== owner.activityRecord)
    throw Error("Startup focused Activity changed");
  const focus = one([...displays.matchAll(/^\s*mCurrentFocus=(.*)$/gm)], "Unknown or ambiguous window focus")[1].trim();
  const focusedWindow = /^Window\{([a-f0-9]+) u0 ([^}\n]+)\}$/i.exec(focus);
  if (focus !== "null" && !focusedWindow) throw Error("Unknown focused window format");
  const headers = [...windows.matchAll(/^[ \t]*Window #\d+ Window\{([a-f0-9]+) u(\d+) ([^}\n]+)\}:[ \t]*$/gmi)];
  if (headers.length > 256 || (windows.match(/^[ \t]*Window #/gm) ?? []).length !== headers.length
    || new Set(headers.map(header => header[1].toLowerCase())).size !== headers.length) throw Error("Unknown or ambiguous window list");
  const applicationTypes = new Set(["BASE_APPLICATION", "APPLICATION", "DRAWN_APPLICATION", "1", "2", "4"]);
  let mainWindow = false;
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i], block = windows.slice(header.index! + header[0].length, headers[i + 1]?.index ?? windows.length);
    const attrs = one([...block.matchAll(/^\s*mAttrs=([^\n]*)$/gm)], "Unknown window attributes");
    const type = one([...attrs[1].matchAll(/\bty=([A-Z_]+|\d+)\b/g)], "Unknown window type")[1];
    const pkg = one([...block.matchAll(/^\s*mOwnerUid=\d+[^\n]*\bpackage=([^\s]+)[^\n]*$/gm)], "Unknown window package")[1];
    if (canonical(header[3]) === owner.component && pkg !== target.packageName) throw Error("Conflicting window ownership");
    if (pkg !== target.packageName) continue;
    if (type === "APPLICATION_STARTING" || type === "3") continue; // A splash is not a main window.
    if (!applicationTypes.has(type)) throw Error("Unsupported target window type");
    const session = one([...block.matchAll(/^\s*mDisplayId=(\d+)[^\n]*\bmSession=Session\{[a-f0-9]+ ([1-9]\d*):[^}]+\}/gmi)], "Unknown window session");
    const activity = record(one([...block.matchAll(/^\s*mActivityRecord=(.*)$/gm)], "Unknown window Activity")[1].trim());
    if (header[2] !== "0" || session[1] !== "0" || Number(session[2]) !== target.pid
      || activity.component !== owner.component || activity.activityRecord !== owner.activityRecord)
      throw Error("Main window belongs to another process or Activity");
    if (focusedWindow && focusedWindow[1].toLowerCase() !== header[1].toLowerCase()) throw Error("Other focused window");
    mainWindow = true;
  }
  if (!mainWindow && focusedWindow) throw Error("Other or unverified focused window");
  return { mainWindow, focus: focusedWindow?.[1].toLowerCase() ?? null };
}

/** Caller supplies reviewed APK digest and an authorized same-run monotonic launch origin.
 * This checks the assertion's binding/timing, not human authorization or launch provenance.
 * A sample-due result is a candidate, not a reusable permission to pause. Full sampling is separate.
 */
export function createStartupWindowAdmission(target: StartupAdmissionTarget, launch: StartupLaunchOrigin, dependencies: {
  execute: StartupReadExecute; now?: () => number; wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const pinned = Object.freeze({ ...target }), origin = Object.freeze({ ...launch });
  component(pinned.component, pinned.packageName);
  if (!/^[\w.-]+$/.test(pinned.serial) || !/^[\w]+(?:\.[\w]+)+$/.test(pinned.packageName)
    || !Number.isSafeInteger(pinned.pid) || pinned.pid <= 0 || pinned.pid > 0x7fffffff || !/^[1-9]\d*$/.test(pinned.startTicks)
    || !/^[a-f0-9]{64}$/.test(pinned.apkSha256) || origin.authorized !== true
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(origin.runId)
    || !Number.isFinite(origin.startedAt) || origin.startedAt < 0 || typeof dependencies.execute !== "function")
    throw Error("Invalid startup identity or authorized origin");
  const execute = dependencies.execute, clock = dependencies.now ?? (() => performance.now());
  const wait = dependencies.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  let last = origin.startedAt, used = false, rechecked = false, due = false, observations = 0;
  let runSignal: AbortSignal | undefined;
  let installedPath: string | undefined, owner: Owner | undefined;
  const now = () => {
    const value = clock();
    if (!Number.isFinite(value) || value < last) throw Error("Startup monotonic clock changed");
    last = value; return value;
  };
  const deadline = origin.startedAt + budgetMs;
  const check = (signal: AbortSignal) => {
    signal.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) throw Error("Startup observation deadline exceeded");
    return remaining;
  };
  const bounded: StartupReadExecute = async (args, timeout, signal) => {
    const reply = await execute(args, Math.min(timeout, Math.ceil(check(signal))), signal);
    check(signal);
    if (!Buffer.isBuffer(reply) || reply.length > dumpLimit) throw Error("Invalid startup command reply");
    return reply;
  };
  const read = async (args: string[], signal: AbortSignal) =>
    (await bounded(["-s", pinned.serial, ...args], 750, signal)).toString("utf8");
  const pathCheck = async (signal: AbortSignal) => {
    if ((await read(["shell", "pm", "path", pinned.packageName], signal)).trim() !== `package:${installedPath}`)
      throw Error("Startup installed package path changed");
  };
  const readState = async (_remaining: number, signal: AbortSignal) => {
    if (++observations > 16) throw Error("Startup observation read limit exceeded");
    await pathCheck(signal);
    await verifyQueueProcess(pinned, signal, bounded);
    const before = parseStartupActivity(await read(["shell", "dumpsys", "activity", "activities"], signal), pinned);
    if (owner && (owner.activityRecord !== before.activityRecord || owner.component !== before.component))
      throw Error("Startup Activity instance changed");
    owner ??= Object.freeze(before);
    const windows = await read(["shell", "dumpsys", "window", "windows"], signal);
    const displays = await read(["shell", "dumpsys", "window", "displays"], signal);
    const state = parseStartupWindows(windows, displays, pinned, owner);
    const after = parseStartupActivity(await read(["shell", "dumpsys", "activity", "activities"], signal), pinned);
    if (after.activityRecord !== owner.activityRecord || after.component !== owner.component) throw Error("Startup Activity instance changed");
    await verifyQueueProcess(pinned, signal, bounded);
    await pathCheck(signal); check(signal);
    if (state.mainWindow) return Object.freeze(state);
    // Refresh after the identity bracket: a window that appeared during those reads wins.
    const freshWindows = await read(["shell", "dumpsys", "window", "windows"], signal);
    const freshDisplays = await read(["shell", "dumpsys", "window", "displays"], signal);
    return Object.freeze(parseStartupWindows(freshWindows, freshDisplays, pinned, owner));
  };
  return {
    async run(signal: AbortSignal): Promise<GateResult & { runId: string; owner: Owner; installedPath: string }> {
      if (used) throw Error("Startup observation already consumed");
      used = true; runSignal = signal; check(signal);
      const installed = await verifyInstalledQueueApk(pinned, pinned.apkSha256, signal, bounded);
      installedPath = installed.installedPath;
      const result = await waitForStackWindow(readState, { startedAt: origin.startedAt, signal, now,
        sleep: async ms => { check(signal); await wait(ms, signal); check(signal); } });
      due = result.status === "sample-due";
      return Object.freeze({ ...result, runId: origin.runId, owner: owner!, installedPath });
    },
    async recheckBeforeSample(signal: AbortSignal): Promise<GateResult> {
      if (!due || rechecked) throw Error("Startup candidate unavailable or recheck already consumed");
      rechecked = true;
      runSignal!.throwIfAborted();
      if (signal !== runSignal) throw Error("Startup cancellation signal changed");
      check(signal);
      const state = await readState(check(signal), signal); check(signal);
      if (now() - origin.startedAt < triggerMs) throw Error("Startup sampling threshold not reached");
      return Object.freeze({ status: state.mainWindow ? "window-ready" : "sample-due", state, observedMs: now() - origin.startedAt });
    },
  };
}
