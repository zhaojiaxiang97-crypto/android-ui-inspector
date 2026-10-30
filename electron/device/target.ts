import { parseAppPids, selectActivityPid } from "./app-process";
import { withCommandSignal } from "./command-context";
import type { FocusUnavailableReason } from "../../shared/types";
import { runDeviceAdb, findAdbPath } from "./runtime";


export type ForegroundTarget = { packageName: string; activityName: string; component: string; activityRecordId?: string };

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

export async function checkedDebugTarget(adbPath: string, serial: string, expectedPackage?: string): Promise<DebugTarget> {
  const activities = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"]);
  const target = foregroundTarget(activities.stdout.toString("utf8"));
  if (activities.code !== 0 || !target || !/^[\w]+(?:\.[\w]+)+$/.test(target.packageName)) throw new Error("无法确认前台 App。");
  if (expectedPackage && target.packageName !== expectedPackage) throw new Error("前台 App 已离开授权范围，未执行操作。");
  const debug = await runDeviceAdb(adbPath, serial, ["shell", "run-as", target.packageName, "id"]);
  if (debug.code !== 0) throw new Error(`仅支持 Debug App：${target.packageName} 不可调试。`);
  const focus = await readDebugFocus(adbPath, serial);
  if (focus.packageName !== target.packageName) throw new Error("焦点窗口不属于授权 App；请关闭系统弹窗后重试。");
  return { ...target, windowId: focus.id };
}

export async function readDebugFocus(adbPath: string, serial: string): Promise<{ id: string; packageName: string }> {
  const windows = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "window", "windows"]);
  let focusOutput = windows.stdout.toString("utf8");
  // Newer Android versions put per-display focus in `displays`, not `windows`.
  if (!focusOutput.includes("mCurrentFocus=")) {
    const displays = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "window", "displays"]);
    if (displays.code !== 0) throw new Error("无法读取前台窗口焦点。");
    focusOutput += `\n${displays.stdout.toString("utf8")}`;
  }
  if (windows.code !== 0) throw new Error("无法读取前台窗口状态。");
  const { focus, reason, reasonCode } = parseFocusedWindowState(focusOutput);
  if (!focus) throw new FocusUnavailableError(reasonCode!, reason!);
  return focus;
}

export function automationAdb(serial: string) {
  if (!/^[\w.:-]{1,256}$/.test(serial)) throw new Error("设备序列号无效。");
  const path = findAdbPath();
  if (!path) throw new Error("未找到 ADB。");
  return path;
}

export function getDebugTarget(serial: string, expectedPackage?: string, signal?: AbortSignal) {
  return withCommandSignal(signal, () => checkedDebugTarget(automationAdb(serial), serial, expectedPackage));
}
