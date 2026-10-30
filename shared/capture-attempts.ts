import type { CaptureAttempt, CaptureRequestDiagnostics, UiSnapshot } from "./types";
import { copyCaptureReadiness, isCaptureReadiness } from "./capture-readiness";

const MAX_ATTEMPTS = 8;
const text = (value: string | null | undefined) => value == null ? null : value.slice(0, 1024);

function isViewHierarchyDiagnostics(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).length === 4
    && typeof fields["view-property-probe-requests"] === "string" && /^\d{1,2}$/.test(fields["view-property-probe-requests"]) && Number(fields["view-property-probe-requests"]) <= 32
    && typeof fields["view-property-export-requests"] === "string" && /^[0-2]$/.test(fields["view-property-export-requests"])
    && ["true", "false"].includes(String(fields["view-property-success"])) && typeof fields["view-property-success"] === "string"
    && ["connect", "windows", "probe", "export", "decode", "identity", "complete"].includes(String(fields["view-property-phase"])) && typeof fields["view-property-phase"] === "string";
}

/** Copy only bounded diagnostics, never trees, screenshots or live objects. */
export function recordCaptureAttempt(previous: CaptureAttempt[], snapshot: UiSnapshot, attempt: number,
  startedMs: number, durationMs: number): CaptureAttempt[] {
  const attributes = snapshot.root?.attributes ?? {};
  const rejected = !snapshot.root && snapshot.error && isCaptureRequestDiagnostics(snapshot.captureRequestDiagnostics)
    ? snapshot.captureRequestDiagnostics.attempts[0] : undefined;
  const entry: CaptureAttempt = {
    attempt, startedMs: Math.round(startedMs), durationMs: Math.round(durationMs),
    error: text(snapshot.error), warning: text(snapshot.warning), processId: text(attributes["debug-process-id"] ?? rejected?.processId),
    timings: Object.fromEntries(Object.entries(snapshot.captureTimings ?? {})
      .filter(([key, value]) => key.length <= 128 && Number.isFinite(value) && value >= 0).slice(0, 64)),
    sdkFailure: rejected ? { ...rejected.sdkFailure } : Object.fromEntries(Object.entries(attributes)
      .filter(([key]) => /^sdk-visible-failure-(phase|target|wait-ms|completed|phase-started-ms|phase-wait-ms|timing|geometry)$/.test(key))
      .map(([key, value]) => [key, value.slice(0, /-(timing|geometry)$/.test(key) ? 2048 : 256)])),
    sdkTasks: rejected ? { ...rejected.sdkTasks } : Object.fromEntries(Object.entries(attributes)
      .filter(([key]) => /^(sdk-task-(queue-buckets|queue-max-ms|slow)|sdk-preview-io)$/.test(key))
      .map(([key, value]) => [key, value.slice(0, 3000)])),
    sdkGeometry: rejected ? { ...rejected.sdkGeometry } : Object.fromEntries(Object.entries(attributes)
      .filter(([key, value]) => /^sdk-geometry-(summary|phases)$/.test(key) && value.length <= 16000)),
  };
  const readiness = snapshot.captureReadiness ?? rejected?.readiness;
  const viewHierarchy = rejected?.viewHierarchy ?? Object.fromEntries(Object.entries(attributes).filter(([key]) => /^view-property-(probe-requests|export-requests|success|phase)$/.test(key)));
  if (isViewHierarchyDiagnostics(viewHierarchy)) entry.viewHierarchy = { ...viewHierarchy };
  if (isCaptureReadiness(readiness)) entry.readiness = copyCaptureReadiness(readiness);
  // Keep the first attempt and the newest seven, not an unbounded retry history.
  return previous.length < MAX_ATTEMPTS ? [...previous, entry] : [previous[0], ...previous.slice(2), entry];
}

export function isCaptureRequestDiagnostics(value: unknown): value is CaptureRequestDiagnostics {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value as CaptureRequestDiagnostics;
  const time = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const message = (v: unknown) => v === null || typeof v === "string" && v.length <= 1024;
  const map = (v: unknown, max: number, check: (key: string, value: unknown) => boolean) =>
    Boolean(v && typeof v === "object" && !Array.isArray(v) && Object.entries(v).length <= max
      && Object.entries(v).every(([key, value]) => check(key, value)));
  return time(d.totalDurationMs) && time(d.totalAttempts) && d.totalAttempts > 0
    && time(d.droppedAttempts) && Array.isArray(d.attempts) && d.attempts.length > 0 && d.attempts.length <= MAX_ATTEMPTS
    && d.droppedAttempts === d.totalAttempts - d.attempts.length
    && d.attempts[0]?.attempt === 1 && d.attempts.at(-1)?.attempt === d.totalAttempts
    && d.attempts.every((a, index) => Boolean(a && time(a.attempt) && a.attempt > 0
      && (!index || a.attempt > d.attempts[index - 1].attempt)
      && time(a.startedMs) && time(a.durationMs) && a.startedMs + a.durationMs <= d.totalDurationMs + 1
      && message(a.error) && message(a.warning) && message(a.processId)
      && (a.readiness === undefined || isCaptureReadiness(a.readiness) && a.readiness.elapsedMs <= a.durationMs + 1)
      && map(a.timings, 64, (key, v) => key.length <= 128 && typeof v === "number" && Number.isFinite(v) && v >= 0)
      && map(a.sdkFailure, 8, (key, v) => /^sdk-visible-failure-(phase|target|wait-ms|completed|phase-started-ms|phase-wait-ms|timing|geometry)$/.test(key)
        && typeof v === "string" && v.length <= (/-(timing|geometry)$/.test(key) ? 2048 : 256))
      && (a.sdkTasks === undefined || map(a.sdkTasks, 4, (key, v) => /^(sdk-task-(queue-buckets|queue-max-ms|slow)|sdk-preview-io)$/.test(key)
        && typeof v === "string" && v.length <= 3000))
      && (a.sdkGeometry === undefined || map(a.sdkGeometry, 2, (key, v) => /^sdk-geometry-(summary|phases)$/.test(key)
        && typeof v === "string" && v.length <= 16000))
      && (a.viewHierarchy === undefined || isViewHierarchyDiagnostics(a.viewHierarchy))));
}
