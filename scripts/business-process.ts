import { parseAppPids, selectActivityPid, verifyAppProcessName } from "../electron/device/app-process";

/** Settings probes must follow the Activity owner, not a forked helper's PID. */
export function businessSettingsPid(adb: (...args: string[]) => string, app: string): string {
  const pids = parseAppPids(0, adb("shell", "pidof", app));
  const activities = adb("shell", "dumpsys", "activity", app);
  const marker = `ACTIVITY ${app}/com.yxcorp.plugin.setting.activity.SettingsActivity `;
  const start = activities.indexOf(marker);
  if (start < 0) throw new Error("设置主页已切换，停止对照");
  const pid = String(selectActivityPid(pids, activities.slice(start)));
  verifyAppProcessName(0, Buffer.from(adb("exec-out", "run-as", app, "cat", `/proc/${pid}/cmdline`)), app);
  return pid;
}
