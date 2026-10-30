import type { CaptureReadiness, ReadinessObservation } from "./types";

const focusReasons = ["null-focus", "non-primary-display", "missing-primary-display", "missing-focus-field", "ambiguous-focus-field", "unrecognized-focus-format"];
type Outcome = { result: ReadinessObservation["result"]; component?: string; windowId?: string; focusReason?: ReadinessObservation["focusReason"] };

const phases = ["foreground", "debug-check", "focus-before", "tree", "focus-after", "ready"];
const time = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const label = (v: unknown): v is string => typeof v === "string" && v.length <= 1024;
const kinds = ["foreground", "focus-candidate", "focus-confirm-before", "focus-confirm-after", "poll-wait", "budget-stop"];
const results = ["returned", "match", "changed", "unavailable", "error", "waited", "insufficient-budget"];
const observationLimit = 64;

function validObservations(d: CaptureReadiness): boolean {
  const o = d.observations;
  return o === undefined || Boolean(o && typeof o === "object" && !Array.isArray(o) && time(o.totalCount) && time(o.droppedCount)
    && Array.isArray(o.entries) && o.entries.length === Math.min(observationLimit, o.totalCount)
    && o.droppedCount === o.totalCount - o.entries.length
    && o.entries.every((r, i) => r && kinds.includes(r.kind) && results.includes(r.result)
      && (r.kind === "budget-stop" ? r.result === "insufficient-budget" : r.result !== "insufficient-budget")
      && time(r.startedMs) && time(r.endedMs) && r.startedMs <= r.endedMs && r.endedMs <= d.elapsedMs
      && time(r.remainingMs) && r.remainingMs === Math.max(0, d.budgetMs - r.endedMs)
      && (r.component === null || label(r.component)) && (r.windowId === null || label(r.windowId))
      && (r.focusReason === undefined || focusReasons.includes(r.focusReason) && r.result === "unavailable"
        && ["focus-candidate", "focus-confirm-before", "focus-confirm-after"].includes(r.kind))
      && (!i || r.startedMs >= o.entries[i - 1].endedMs)));
}

export function isCaptureReadiness(value: unknown): value is CaptureReadiness {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value as CaptureReadiness;
  return time(d.budgetMs) && d.budgetMs > 0 && time(d.elapsedMs) && phases.includes(d.phase)
    && (d.firstFocusedWindowMs === null || time(d.firstFocusedWindowMs) && d.firstFocusedWindowMs <= d.elapsedMs)
    && (d.focus === null ? d.firstFocusedWindowMs === null : Boolean(d.focus && label(d.focus.component)
      && label(d.focus.windowId) && (d.focus.activityRecordId === null || label(d.focus.activityRecordId))
      && d.firstFocusedWindowMs !== null))
    && time(d.treeReadCount) && Array.isArray(d.treeReads) && d.treeReads.length === Math.min(8, d.treeReadCount)
    && d.treeReads.every((r, i) => r && time(r.startedMs) && time(r.endedMs) && r.startedMs <= r.endedMs
      && r.endedMs <= d.elapsedMs && (!i || r.startedMs >= d.treeReads[i - 1].endedMs))
    && validObservations(d) && (d.rejection === null || label(d.rejection))
    && (d.phase !== "ready" || d.focus !== null && d.treeReadCount > 0 && d.rejection === null);
}

/** Explicit scalar copy: unknown fields, pixels and live objects never enter saved diagnostics. */
export function copyCaptureReadiness(d: CaptureReadiness): CaptureReadiness {
  return { budgetMs: d.budgetMs, elapsedMs: d.elapsedMs, phase: d.phase,
    firstFocusedWindowMs: d.firstFocusedWindowMs,
    focus: d.focus ? { component: d.focus.component, activityRecordId: d.focus.activityRecordId, windowId: d.focus.windowId } : null,
    treeReadCount: d.treeReadCount, treeReads: d.treeReads.map(r => ({ startedMs: r.startedMs, endedMs: r.endedMs })),
    rejection: d.rejection,
    ...(d.observations ? { observations: { totalCount: d.observations.totalCount, droppedCount: d.observations.droppedCount,
      entries: d.observations.entries.map(r => ({ kind: r.kind, result: r.result, startedMs: r.startedMs,
        endedMs: r.endedMs, remainingMs: r.remainingMs, component: r.component, windowId: r.windowId,
        ...(r.focusReason !== undefined ? { focusReason: r.focusReason } : {}) })) } } : {}) };
}

export function createCaptureReadiness(budgetMs: number, now: () => number) {
  const state: CaptureReadiness = { budgetMs, elapsedMs: 0, phase: "foreground", firstFocusedWindowMs: null,
    focus: null, treeReadCount: 0, treeReads: [], rejection: null,
    observations: { totalCount: 0, droppedCount: 0, entries: [] } };
  const elapsed = () => Math.max(0, Math.round(now()));
  const record = (kind: ReadinessObservation["kind"], startedMs: number,
    outcome: Outcome) => {
    const endedMs = elapsed();
    const row: ReadinessObservation = { kind, startedMs, endedMs, remainingMs: Math.max(0, budgetMs - endedMs),
      result: outcome.result, component: outcome.component?.slice(0, 1024) ?? null, windowId: outcome.windowId?.slice(0, 1024) ?? null,
      ...(outcome.focusReason !== undefined && focusReasons.includes(outcome.focusReason) && outcome.result === "unavailable"
        && kind.startsWith("focus-") ? { focusReason: outcome.focusReason } : {}) };
    const o = state.observations!;
    o.totalCount++;
    o.entries = o.entries.length < observationLimit ? [...o.entries, row] : [o.entries[0], ...o.entries.slice(2), row];
    o.droppedCount = o.totalCount - o.entries.length;
  };
  return {
    async observe<T>(kind: ReadinessObservation["kind"], task: () => Promise<T>,
      describe: (value: T) => Outcome = () => ({ result: "returned" }),
      errorResult: (error: unknown) => ReadinessObservation["result"] | Outcome = () => "error"): Promise<T> {
      const startedMs = elapsed();
      let outcome: Outcome = { result: "error" };
      try { const value = await task(); outcome = describe(value); return value; }
      catch (error) { const result = errorResult(error); outcome = typeof result === "string" ? { result } : result; throw error; }
      finally { record(kind, startedMs, outcome); }
    },
    budgetStop() { record("budget-stop", elapsed(), { result: "insufficient-budget" }); },
    phase(phase: CaptureReadiness["phase"]) { state.phase = phase; },
    focused(focus: { component: string; activityRecordId?: string; windowId: string }) {
      state.firstFocusedWindowMs ??= elapsed();
      state.focus = { component: focus.component.slice(0, 1024), activityRecordId: focus.activityRecordId?.slice(0, 1024) ?? null,
        windowId: focus.windowId.slice(0, 1024) };
    },
    async read<T>(task: () => Promise<T>): Promise<T> {
      state.phase = "tree";
      const startedMs = elapsed();
      state.treeReadCount++;
      try { return await task(); }
      finally {
        const entry = { startedMs, endedMs: elapsed() };
        state.treeReads = state.treeReads.length < 8 ? [...state.treeReads, entry]
          : [state.treeReads[0], ...state.treeReads.slice(2), entry];
      }
    },
    ready() { state.phase = "ready"; state.elapsedMs = elapsed(); state.rejection = null; },
    snapshot(rejection?: string): CaptureReadiness {
      if (state.phase !== "ready") {
        state.elapsedMs = elapsed(); state.rejection = rejection?.slice(0, 1024) ?? null;
      }
      return copyCaptureReadiness(state);
    },
  };
}
