import { foregroundTarget, targetActivitySection } from "../../../electron/device/target";
import { hasActivityHierarchy } from "../../../electron/capture/native-tree";
import { parseAppPid, selectActivityPid } from "../../../electron/device/app-process";

export function startupDumpTarget(activities: string, component: string, pidOutput: string) {
  const target = foregroundTarget(activities);
  if (!target?.activityRecordId || target.component !== component) throw new Error("目标前台 Activity 实例尚未确认");
  // This probe does not guess an owner among forked helpers; ambiguity is an invalid sample.
  return { ...target, pid: parseAppPid(0, pidOutput) };
}

export function startupDumpEvidence(output: string, target: ReturnType<typeof startupDumpTarget>) {
  const section = targetActivitySection(output, target);
  if (selectActivityPid([target.pid], section) !== target.pid) throw new Error("读取期间 Activity 所属进程已变化");
  return { runningActivity: true, validHierarchy: hasActivityHierarchy(section, target),
    systemDumpTimeout: /Failure while dumping the activity:[^\n]*Timeout/.test(section) };
}
