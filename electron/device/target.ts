import { parseAppPids, selectActivityPid } from "./app-process";
import { commandSignal, withCommandSignal } from "./command-context";
import type { FocusUnavailableReason } from "../../shared/types";
import { runDeviceAdb, findAdbPath, type CommandResult } from "./runtime";


export type ForegroundTarget = { packageName: string; activityName: string; component: string; activityRecordId?: string };

const foregroundFailureMessages = {
  "query-failed": "活动查询命令失败",
  "missing-field": "系统未提供前台 Activity 字段",
  "null-foreground": "系统前台 Activity 为空",
  "unrecognized-format": "前台 Activity 格式无法识别",
  "invalid-package": "前台 App 包名无效",
  "outside-grant": "前台 App 已离开授权范围，未执行操作",
} as const;

export class ForegroundUnavailableError extends Error {
  constructor(readonly foregroundReason: keyof typeof foregroundFailureMessages) {
    super(`无法确认前台 App：${foregroundFailureMessages[foregroundReason]}。`);
    this.name = "ForegroundUnavailableError";
  }
}

export function checkedForegroundTarget(result: Pick<CommandResult, "code" | "stdout" | "stderr">, expectedPackage?: string): ForegroundTarget {
  const output = result.stdout.toString("utf8");
  if (result.code !== 0 || /Permission\s+(?:Denial|denied)|\bSecurityException\b|Can't find service:|Error dumping service info:|\bDUMP TIMEOUT\b/i.test(`${output}\n${result.stderr}`))
    throw new ForegroundUnavailableError("query-failed");
  const target = foregroundTarget(output);
  if (!target) {
    const fields = [...output.matchAll(/(?:mResumedActivity|topResumedActivity)\s*[:=]([^\n]*)/g)];
    throw new ForegroundUnavailableError(fields.length === 0 ? "missing-field"
      : fields.every(field => /^\s*null\s*$/.test(field[1])) ? "null-foreground" : "unrecognized-format");
  }
  if (!/^[\w]+(?:\.[\w]+)+$/.test(target.packageName)) throw new ForegroundUnavailableError("invalid-package");
  if (expectedPackage && target.packageName !== expectedPackage) throw new ForegroundUnavailableError("outside-grant");
  return target;
}

export function foregroundTarget(output: string): ForegroundTarget | null {
  const match = output.match(/(?:mResumedActivity|topResumedActivity)[:=].*?\bu\d+\s+([^/\s]+)\/([^\s}\]]+)/);
  if (!match) return null;
  const activityRecordId = /ActivityRecord\{([0-9a-f]+)\b/i.exec(match[0])?.[1];
  return { packageName: match[1], activityName: match[2], component: `${match[1]}/${match[2]}`,
    ...(activityRecordId ? { activityRecordId } : {}) };
}

export function sameActivityInstance(target: ForegroundTarget, current: ForegroundTarget | null): boolean {
  return current?.component === target.component
    && (!target.activityRecordId || current.activityRecordId === target.activityRecordId);
}

export function targetActivitySection(output: string, target: ForegroundTarget) {
  const sections = [...output.matchAll(/(?:^|\n)[ \t]*ACTIVITY[ \t]+(\S+)[ \t]+(\S+)([^\n]*)/g)];
  const matches = sections.filter(section => section[1] === target.component
    && (!target.activityRecordId || section[2] === target.activityRecordId));
  // Force-stop retains old tasks with the same component. Never take the first
  // matching name or guess the newest PID; use the resumed ActivityRecord token.
  if (matches.length !== 1 || /pid=\(not running\)/.test(matches[0][3])) {
    throw new Error("前台 Activity 实例无法唯一确认或已停止，请重新采集。");
  }
  const selected = matches[0], index = sections.indexOf(selected);
  const start = selected.index! + selected[0].indexOf("ACTIVITY");
  return output.slice(start, sections[index + 1]?.index ?? output.length);
}

export async function singleAppPid(adbPath: string, serial: string, packageName: string, currentTarget?: DebugTarget) {
  // Only the immediate caller's checked target, never a session cache or previous confirmation.
  if (currentTarget && currentTarget.packageName !== packageName) throw new Error("进程查询的窗口不属于目标 App");
  const result = await runDeviceAdb(adbPath, serial, ["shell", "pidof", packageName]);
  const pids = parseAppPids(result.code, result.stdout.toString("utf8"));
  if (pids.length === 1) return pids[0];
  const target = currentTarget ?? await checkedDebugTarget(adbPath, serial, packageName);
  const activity = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", packageName]);
  if (activity.code !== 0) throw new Error("无法确认前台窗口所属进程");
  const pid = selectActivityPid(pids, targetActivitySection(activity.stdout.toString("utf8"), target));
  console.log(`[process] candidates=${pids.join(",")} activityOwner=${pid}`);
  return pid;
}

export type DebugTarget = ForegroundTarget & { windowId: string };

export class FocusUnavailableError extends Error {
  constructor(readonly focusReason: FocusUnavailableReason, reason: string) {
    super(`无法确认焦点窗口：${reason}。`);
    this.name = "FocusUnavailableError";
  }
}

export function parseFocusedWindowState(output: string): { focus: { id: string; packageName: string } | null; reason: string | null; reasonCode: FocusUnavailableReason | null } {
  const focusedDisplay = output.match(/mTopFocusedDisplayId=(\d+)/)?.[1];
  if (focusedDisplay && focusedDisplay !== "0") return { focus: null, reason: "焦点位于非主显示器", reasonCode: "non-primary-display" };
  if (/Display: mDisplayId=/.test(output)) {
    const display = output.match(/Display: mDisplayId=0\b[\s\S]*?(?=\n\s*Display: mDisplayId=|$)/)?.[0];
    if (!display) return { focus: null, reason: "系统未提供主显示器窗口状态", reasonCode: "missing-primary-display" };
    output = display;
  }
  const count = (output.match(/mCurrentFocus=/g) ?? []).length;
  if (count !== 1) return { focus: null, reason: count === 0 ? "系统未提供焦点字段" : "系统焦点字段不唯一", reasonCode: count === 0 ? "missing-focus-field" : "ambiguous-focus-field" };
  if (/mCurrentFocus=null\b/.test(output)) return { focus: null, reason: "系统焦点为空，窗口尚未就绪", reasonCode: "null-focus" };
  const match = output.match(/mCurrentFocus=Window\{([0-9a-f]+)\s+u\d+\s+([\w.]+)\//i);
  return match ? { focus: { id: match[1], packageName: match[2] }, reason: null, reasonCode: null }
    : { focus: null, reason: "焦点窗口格式无法识别", reasonCode: "unrecognized-focus-format" };
}

export function parseFocusedWindow(output: string): { id: string; packageName: string } | null {
  return parseFocusedWindowState(output).focus;
}

export async function checkedDebugTarget(adbPath: string, serial: string, expectedPackage?: string,
  options?: { parallelBoundary?: boolean }): Promise<DebugTarget> {
  let activities: CommandResult, debugRead: PromiseSettledResult<CommandResult> | undefined;
  if (options?.parallelBoundary && expectedPackage) {
    if (!/^[\w]+(?:\.[\w]+)+$/.test(expectedPackage)) throw new Error("授权 App 包名无效。");
    // Only the already authorized package can be probed early; join both reads before checking focus or returning.
    const reads = await Promise.allSettled([
      runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"]),
      runDeviceAdb(adbPath, serial, ["shell", "run-as", expectedPackage, "id"]),
    ]);
    commandSignal()?.throwIfAborted();
    if (reads[0].status === "rejected") throw new ForegroundUnavailableError("query-failed");
    activities = reads[0].value; debugRead = reads[1];
  } else {
    try { activities = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"]); }
    catch {
      commandSignal()?.throwIfAborted();
      throw new ForegroundUnavailableError("query-failed");
    }
  }
  const target = checkedForegroundTarget(activities, expectedPackage);
  if (debugRead?.status === "rejected") throw debugRead.reason;
  const debug = debugRead?.value ?? await runDeviceAdb(adbPath, serial, ["shell", "run-as", target.packageName, "id"]);
  if (debug.code !== 0) throw new Error(`仅支持 Debug App：${target.packageName} 不可调试。`);
  const focus = await readDebugFocus(adbPath, serial);
  if (focus.packageName !== target.packageName) throw new Error("焦点窗口不属于授权 App；请关闭系统弹窗后重试。");
  return { ...target, windowId: focus.id };
}

export const FOCUS_QUERY_CACHE_LIMIT = 32;
export const FOCUS_QUERY_CACHE_TTL_MS = 5 * 60_000;
type FocusQuery = "windows" | "all";

/** Cache the supported query shape, never a window identity or its contents. */
export function createDebugFocusReader(execute: typeof runDeviceAdb = runDeviceAdb, now = () => performance.now()) {
  const cache = new Map<string, { query?: FocusQuery; expiresAt: number }>();
  return async (adbPath: string, serial: string): Promise<{ id: string; packageName: string }> => {
    const key = JSON.stringify([adbPath, serial]), previous = cache.get(key), started = now();
    const entry = { query: previous && previous.expiresAt > started ? previous.query : undefined, expiresAt: started + FOCUS_QUERY_CACHE_TTL_MS };
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > FOCUS_QUERY_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    const first = entry.query ?? "windows";
    const queries: FocusQuery[] = [first, first === "windows" ? "all" : "windows"];
    try {
      for (let index = 0; index < queries.length; index++) {
        commandSignal()?.throwIfAborted();
        const query = queries[index];
        const result = await execute(adbPath, serial, query === "all" ? ["shell", "dumpsys", "window"] : ["shell", "dumpsys", "window", query]);
        commandSignal()?.throwIfAborted();
        const output = result.stdout.toString("utf8");
        // dumpsys can report permission/service errors with exit code zero.
        if (result.code !== 0 || /Permission\s+(?:Denial|denied)|\bSecurityException\b|Can't find service:|Error dumping service info:|\bDUMP TIMEOUT\b/i.test(`${output}\n${result.stderr}`))
          throw new Error("无法读取前台窗口焦点。");
        const focusedDisplays = [...output.matchAll(/\bmTopFocusedDisplayId=([^\s]*)/g)].map(match => match[1]);
        if (focusedDisplays.length > 1) throw new FocusUnavailableError("ambiguous-focus-field", "系统焦点显示器字段不唯一");
        if (focusedDisplays.length === 1 && !/^\d+$/.test(focusedDisplays[0]))
          throw new FocusUnavailableError("unrecognized-focus-format", "系统焦点显示器格式无法识别");
        if ([...output.matchAll(/Display: mDisplayId=0\b/g)].length > 1)
          throw new FocusUnavailableError("ambiguous-focus-field", "系统主显示器窗口段不唯一");
        const { focus, reason, reasonCode } = parseFocusedWindowState(output);
        if (focus) {
          // A per-display focus is insufficient by itself. The full dump must
          // also identify the globally focused display in this same response.
          if (query === "all" && focusedDisplays.length !== 1)
            throw new FocusUnavailableError("unrecognized-focus-format", "系统未提供完整焦点显示器字段");
          // A slower concurrent request must not overwrite a newer result or failure.
          if (cache.get(key) === entry) { entry.query = query; entry.expiresAt = now() + FOCUS_QUERY_CACHE_TTL_MS; }
          return focus;
        }
        // Only a missing field indicates a different dumpsys layout. A null,
        // ambiguous, malformed or non-primary focus must never be bypassed.
        if (index === 0 && reasonCode === "missing-focus-field" && !output.includes("mCurrentFocus=")) continue;
        throw new FocusUnavailableError(reasonCode!, reason!);
      }
      throw new Error("无法读取前台窗口焦点。");
    } catch (error) {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    }
  };
}

export const readDebugFocus = createDebugFocusReader();

export function automationAdb(serial: string) {
  if (!/^[\w.:-]{1,256}$/.test(serial)) throw new Error("设备序列号无效。");
  const path = findAdbPath();
  if (!path) throw new Error("未找到 ADB。");
  return path;
}

export function getDebugTarget(serial: string, expectedPackage?: string, signal?: AbortSignal) {
  return withCommandSignal(signal, () => checkedDebugTarget(automationAdb(serial), serial, expectedPackage));
}
