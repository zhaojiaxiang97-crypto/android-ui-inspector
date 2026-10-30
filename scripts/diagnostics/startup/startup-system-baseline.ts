import { foregroundTarget, parseFocusedWindowState } from "../../../electron/device/target";

const slots = [0, 6000, 12000, 18000, 24000];
const budgetMs = 30000;
const minReadMs = 1500;
type Read = { kind: "activities" | "windows" | "displays"; startedMs: number; endedMs: number; error: string | null };
type Target = { component: string; activityRecordId: string };
export type StartupSystemSample = {
  scheduledMs: number; startedMs: number; endedMs: number; reads: Read[];
  target: Target | null; focus: { id: string; packageName: string } | null;
  reason: string | null; candidate: boolean;
};
export type StartupSystemBaseline = {
  budgetMs: number; elapsedMs: number; status: "completed" | "budget-exhausted" | "cancelled";
  firstCandidateMs: number | null; records: StartupSystemSample[];
  scope: string;
};
const canonical = (component: string) => component.replace(/\/\./, `/${component.split("/")[0]}.`);

/** Sequential system observations only: not a capture, PID proof or authorization. */
export async function observeStartupSystem(options: {
  component: string; now: () => number; signal: AbortSignal;
  sleep: (ms: number, signal: AbortSignal) => Promise<unknown>;
  read: (args: string[], timeoutMs: number, signal: AbortSignal) => Promise<string>;
  onSample?: (sample: StartupSystemSample) => void;
}): Promise<StartupSystemBaseline> {
  const started = options.now();
  const elapsed = () => Math.max(0, Math.round(options.now() - started));
  const result: StartupSystemBaseline = { budgetMs, elapsedMs: 0, status: "completed", firstCandidateMs: null,
    records: [], scope: "sparse sequential system observations; candidate is not actual window creation time, atomic identity or capture authorization; no App tree/SDK/images/process queries" };
  const enough = () => budgetMs - elapsed() >= minReadMs;
  try {
    for (const at of slots) {
      options.signal.throwIfAborted();
      if (!enough()) { result.status = "budget-exhausted"; break; }
      if (at > elapsed()) await options.sleep(at - elapsed(), options.signal);
      options.signal.throwIfAborted();
      if (!enough()) { result.status = "budget-exhausted"; break; }
      const sample: StartupSystemSample = { scheduledMs: at, startedMs: elapsed(), endedMs: elapsed(), reads: [],
        target: null, focus: null, reason: null, candidate: false };
      result.records.push(sample);
      const read = async (kind: Read["kind"]) => {
        options.signal.throwIfAborted();
        if (!enough()) { result.status = "budget-exhausted"; throw new Error("观察预算不足，未发起查询"); }
        const r: Read = { kind, startedMs: elapsed(), endedMs: elapsed(), error: null };
        sample.reads.push(r);
        try {
          const args = kind === "activities" ? ["shell", "dumpsys", "activity", "activities"]
            : ["shell", "dumpsys", "window", kind];
          return await options.read(args, Math.min(6000, budgetMs - elapsed()), options.signal);
        } catch (error) { r.error = String(error).slice(0, 1024); throw error; }
        finally { r.endedMs = elapsed(); }
      };
      try {
        const activities = await read("activities");
        const targets = activities.split(/\r?\n/).map(line => foregroundTarget(line)).filter(t => t !== null);
        const unique = new Map(targets.map(t => [canonical(t.component) + ":" + t.activityRecordId, t]));
        const target = unique.size === 1 ? [...unique.values()][0] : null;
        if (target?.activityRecordId && canonical(target.component) === canonical(options.component))
          sample.target = { component: target.component, activityRecordId: target.activityRecordId };
        const windows = await read("windows");
        const focusOutput = windows.includes("mCurrentFocus=") ? windows : windows + "\n" + await read("displays");
        const state = parseFocusedWindowState(focusOutput);
        sample.focus = state.focus;
        sample.candidate = sample.target !== null && state.focus?.packageName === options.component.split("/")[0];
        sample.reason = !sample.target ? "前台实例缺失、歧义或不是目标页面" : state.reason
          ?? (sample.candidate ? null : "焦点不属于目标App");
        if (sample.candidate) result.firstCandidateMs ??= elapsed();
      } catch (error) {
        sample.reason = String(error).slice(0, 1024);
        options.signal.throwIfAborted();
      } finally {
        sample.endedMs = elapsed(); options.onSample?.(sample);
      }
      if (!enough()) { result.status = "budget-exhausted"; break; }
    }
  } catch (error) {
    if (!options.signal.aborted) throw error;
    result.status = "cancelled";
  }
  result.elapsedMs = elapsed();
  return result;
}
