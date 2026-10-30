import { createHash } from "node:crypto";

export type ReadinessSample = { ready: boolean; signature?: string; reason: "ready" | "format" | "focus" | "foreground" };

/** Experimental system signal only. It cannot validate Accessibility roots or authorize a capture/input. */
export function parseObservationReadiness(accessibility: string, window: string, packageName: string): ReadinessSample {
  const no = (reason: ReadinessSample["reason"]): ReadinessSample => ({ ready: false, reason });
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)
    || accessibility.length > 2_000_000 || window.length > 2_000_000) return no("format");
  const lines = accessibility.split("\n").filter(line => line.includes("A11yWindow[AccessibilityWindowInfo["));
  if (!lines.length || lines.length > 16) return no("format");
  const ids = new Set<number>();
  const windows = [];
  for (const line of lines) {
    const field = (key: string) => new RegExp("(?:\\[|, )" + key + "=([^,\\]]+)").exec(line)?.[1];
    const id = Number(field("id")), display = field("displayId"), type = field("type"), layer = Number(field("layer"));
    const focused = field("focused"), active = field("active"), parent = field("hasParent"), transition = field("transitionTime");
    const rect = /bounds=Rect\((-?\d+),\s*(-?\d+) - (-?\d+),\s*(-?\d+)\)/.exec(line);
    const bounds = rect?.slice(1).map(Number);
    if (!Number.isSafeInteger(id) || id < 0 || ids.has(id) || display !== "0" || !Number.isSafeInteger(layer)
      || !["TYPE_APPLICATION", "TYPE_SYSTEM", "TYPE_INPUT_METHOD", "TYPE_ACCESSIBILITY_OVERLAY", "TYPE_SPLIT_SCREEN_DIVIDER"].includes(type ?? "")
      || ![focused, active, parent].every(v => v === "true" || v === "false") || !/^\d+$/.test(transition ?? "")
      || !bounds || !bounds.every(Number.isSafeInteger) || bounds[2] < bounds[0] || bounds[3] < bounds[1]) return no("format");
    ids.add(id); windows.push({ id, type, layer, focused, active, parent, transition, bounds });
  }
  const focused = windows.filter(w => w.focused === "true"), active = windows.filter(w => w.active === "true");
  if (focused.length !== 1 || active.length !== 1 || focused[0].id !== active[0].id
    || focused[0].type !== "TYPE_APPLICATION" || focused[0].parent !== "false") return no("focus");
  const focusLines = window.split("\n").filter(line => /\bmCurrentFocus=/.test(line));
  if (focusLines.length !== 1) return no("foreground");
  const component = /mCurrentFocus=Window\{\S+\s+u\d+\s+([^\s}]+)\}/.exec(focusLines[0])?.[1];
  if (!component?.startsWith(packageName + "/")) return no("foreground");
  windows.sort((a, b) => a.id - b.id);
  return { ready: true, reason: "ready", signature: createHash("sha256").update(JSON.stringify({ windows, component })).digest("hex") };
}

export async function waitForObservationReadiness(options: {
  read: (remainingMs: number) => Promise<ReadinessSample>; signal: AbortSignal;
  timeoutMs?: number; maxSamples?: number; now?: () => number;
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const timeoutMs = options.timeoutMs ?? 3000, maxSamples = options.maxSamples ?? 8;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 200 || timeoutMs > 5000
    || !Number.isInteger(maxSamples) || maxSamples < 2 || maxSamples > 10) throw Error("Invalid readiness budget");
  const now = options.now ?? (() => performance.now()), started = now(), deadline = started + timeoutMs;
  const pause = options.pause ?? ((ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(Error("Readiness cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }));
  let previous: string | undefined, since = started, samples = 0;
  let reason: ReadinessSample["reason"] | "unstable" | "read_failed" = "unstable";
  for (; samples < maxSamples && now() < deadline;) {
    options.signal.throwIfAborted();
    let sample: ReadinessSample;
    try { sample = await options.read(Math.max(1, Math.floor(deadline - now()))); }
    catch { options.signal.throwIfAborted(); return { ready: false, reason: "read_failed", samples: samples + 1, elapsedMs: Math.round(now() - started) }; }
    samples++; options.signal.throwIfAborted();
    if (now() >= deadline) break; // A late "ready" must never pass the budget.
    reason = sample.ready ? "unstable" : sample.reason;
    if (!sample.ready || !/^[a-f0-9]{64}$/.test(sample.signature ?? "")) previous = undefined;
    else if (previous === sample.signature && now() - since >= 100)
      return { ready: true, reason: "ready", samples, elapsedMs: Math.round(now() - started) };
    else if (previous !== sample.signature) { previous = sample.signature; since = now(); }
    const remaining = deadline - now();
    if (samples < maxSamples && remaining > 0) await pause(Math.min(100, remaining), options.signal);
  }
  options.signal.throwIfAborted();
  return { ready: false, reason, samples, elapsedMs: Math.round(now() - started) };
}
