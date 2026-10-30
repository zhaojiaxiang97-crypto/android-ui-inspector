import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { commandSignal } from "./command-context";
import { helperServerTimingSchema } from "../../shared/helper-observation-timing";
import { DEBUG_TIMING_SPAN_LIMIT, type DebugCommandCategory, type DebugObservationReason, type DebugTimingOutcome,
  type DebugTimingPhase, type DebugTimingSpan, type DebugTimings } from "../../shared/debug-timing";

type TimingContext = { timing: DebugTiming; parentId: number | null; reason: DebugObservationReason };
const context = new AsyncLocalStorage<TimingContext>();
type TimingClock = { now: () => number; date: () => string };
type SpanMetadata = Pick<DebugTimingSpan, "commandCategory" | "backend" | "reason" | "helperEndpoint" | "helperDeviceTiming" | "helperReportedComplete">;
const round = (value: number) => Math.round(Math.max(0, value) * 1000) / 1000;

export class DebugTiming {
  private readonly origin: number;
  private readonly startedAt: string;
  private readonly spans: DebugTimingSpan[] = [];
  private readonly active = new Set<number>();
  private readonly commandCounts: DebugTimings["commandCounts"] = {};
  private readonly observationCounts: DebugTimings["observationCounts"] = {};
  private droppedSpans = 0;
  private ended: { offset: number; status: DebugTimingOutcome } | undefined;
  readonly correlationId = randomUUID();
  constructor(private readonly clock: TimingClock = { now: () => performance.now(), date: () => new Date().toISOString() }) {
    this.origin = clock.now(); this.startedAt = clock.date();
  }
  private offset() { return round(this.clock.now() - this.origin); }
  begin(phase: DebugTimingPhase, parentId: number | null, metadata: SpanMetadata = {}) {
    if (this.ended) return undefined;
    if (phase === "device_command" && metadata.commandCategory) this.commandCounts[metadata.commandCategory] = (this.commandCounts[metadata.commandCategory] ?? 0) + 1;
    if (phase === "observation") {
      const reason = metadata.reason ?? "unspecified";
      metadata = { ...metadata, reason };
      this.observationCounts[reason] = (this.observationCounts[reason] ?? 0) + 1;
    }
    if (this.spans.length >= DEBUG_TIMING_SPAN_LIMIT) { this.droppedSpans++; return undefined; }
    const span: DebugTimingSpan = { id: this.spans.length + 1, parentId, phase, startOffsetMs: this.offset(), durationMs: 0, status: "running", ...structuredClone(metadata) };
    this.spans.push(span); this.active.add(span.id);
    return span;
  }
  end(span: DebugTimingSpan | undefined, status: DebugTimingOutcome) {
    if (!span || !this.active.has(span.id) || this.ended) return;
    span.durationMs = round(this.offset() - span.startOffsetMs); span.status = status; this.active.delete(span.id);
  }
  recordHelperServerTiming(spanId: number | null, value: unknown) {
    if (this.ended || spanId === null || !this.active.has(spanId)) return;
    const span = this.spans.find(item => item.id === spanId);
    if (span?.phase !== "helper_request_headers" || span.helperEndpoint !== "snapshot" || span.helperServerTiming !== undefined) return;
    const parsed = helperServerTimingSchema.safeParse(value);
    if (parsed.success) span.helperServerTiming = structuredClone(parsed.data);
  }
  peek(): DebugTimings {
    const durationMs = this.ended?.offset ?? this.offset();
    return { version: 1, correlationId: this.correlationId, startedAt: this.startedAt, durationMs, status: this.ended?.status ?? "running",
      spans: this.spans.map(span => ({ ...structuredClone(span), ...(this.active.has(span.id) ? { durationMs: round(durationMs - span.startOffsetMs) } : {}) })),
      droppedSpans: this.droppedSpans, commandCount: Object.values(this.commandCounts).reduce((a, b) => a + b, 0), commandCounts: { ...this.commandCounts },
      observationCount: Object.values(this.observationCounts).reduce((a, b) => a + b, 0), observationCounts: { ...this.observationCounts } };
  }
  finish(status: DebugTimingOutcome): DebugTimings {
    if (!this.ended) {
      const offset = this.offset();
      for (const span of this.spans) if (this.active.has(span.id)) { span.durationMs = round(offset - span.startOffsetMs); span.status = status; }
      this.active.clear(); this.ended = { offset, status };
    }
    return this.peek();
  }
}

export function createDebugTiming(clock?: TimingClock) { return new DebugTiming(clock); }
export function runWithDebugTiming<T>(timing: DebugTiming, operation: () => T): T {
  return context.run({ timing, parentId: null, reason: "unspecified" }, operation);
}
export function getDebugTimings() { return context.getStore()?.timing.peek(); }
/** Only the currently active snapshot response-header span can receive these optional diagnostics. */
export function recordHelperServerTiming(value: unknown) {
  const current = context.getStore();
  current?.timing.recordHelperServerTiming(current.parentId, value);
}
export function withDebugObservationReason<T>(reason: DebugObservationReason, operation: () => T): T {
  const current = context.getStore();
  return current ? context.run({ ...current, reason }, operation) : operation();
}
export function debugTimingErrorOutcome(error: unknown, signal = commandSignal()): DebugTimingOutcome {
  const candidate = error as { name?: unknown; code?: unknown; evidence?: { classification?: unknown } } | undefined;
  return candidate?.name === "AbortError" || candidate?.code === "ABORT_ERR" || candidate?.evidence?.classification === "cancelled"
    || signal?.aborted && signal.reason?.name !== "TimeoutError" ? "cancelled" : "failed";
}
export async function measureDebugPhase<T>(phase: DebugTimingPhase, operation: () => Promise<T> | T, metadata: SpanMetadata = {}): Promise<T> {
  const current = context.getStore();
  if (!current) return operation();
  const span = current.timing.begin(phase, current.parentId, phase === "observation" ? { reason: current.reason, ...metadata } : metadata);
  try {
    const result = await context.run({ ...current, parentId: span?.id ?? current.parentId }, operation);
    current.timing.end(span, "success"); return result;
  } catch (error) { current.timing.end(span, debugTimingErrorOutcome(error)); throw error; }
}

/** Synchronous writers share the same parent span; accidentally async work must use measureDebugPhase. */
export function measureDebugPhaseSync<T>(phase: DebugTimingPhase,
  operation: () => T & (T extends PromiseLike<unknown> ? never : unknown), metadata: SpanMetadata = {}): T {
  const invoke = (): T => {
    const result = operation();
    if (result !== null && (typeof result === "object" || typeof result === "function")
      && typeof (result as { then?: unknown }).then === "function")
      throw new Error("同步计时不能接受 Promise，请使用 measureDebugPhase。");
    return result;
  };
  const current = context.getStore();
  if (!current) return invoke();
  const span = current.timing.begin(phase, current.parentId, phase === "observation" ? { reason: current.reason, ...metadata } : metadata);
  try {
    const result = context.run({ ...current, parentId: span?.id ?? current.parentId }, invoke);
    current.timing.end(span, "success");
    return result;
  } catch (error) { current.timing.end(span, debugTimingErrorOutcome(error)); throw error; }
}

export async function measureDebugCommand<T>(category: DebugCommandCategory, operation: () => Promise<T>, outcome?: (result: T) => DebugTimingOutcome): Promise<T> {
  const current = context.getStore();
  if (!current) return operation();
  const span = current.timing.begin("device_command", current.parentId, { commandCategory: category });
  try { const result = await operation(); current.timing.end(span, outcome?.(result) ?? "success"); return result; }
  catch (error) { current.timing.end(span, debugTimingErrorOutcome(error)); throw error; }
}

/** Only fixed categories leave this function. Never store command strings, arguments or replies. */
export function debugCommandCategory(command: string, args: readonly string[]): DebugCommandCategory {
  if (!/^adb(?:\.exe)?$/i.test(basename(command))) return "other";
  const parts = args[0] === "-s" ? args.slice(2) : args;
  if (parts[0] === "forward" || parts[0] === "reverse") return "forward";
  const inner = parts[0] === "shell" || parts[0] === "exec-out" ? parts.slice(1) : parts;
  if (inner[0] === "input") return "input";
  if (inner[0] === "uiautomator") return "hierarchy_dump";
  if (inner[0] === "cat" && inner[1]?.startsWith("/data/local/tmp/android-ui-inspector-")) return "hierarchy_read";
  if (inner[0] === "rm") return "cleanup";
  if (inner[0] === "screencap") return "screenshot";
  if (inner[0] === "pidof" || inner[0] === "run-as" && inner[2] === "id") return "target";
  if (inner[0] === "dumpsys" && ["window", "activity"].includes(inner[1])) return "target";
  if (inner[0] === "wm" || inner[0] === "dumpsys" && ["display", "input"].includes(inner[1])) return "display";
  if (["devices", "get-state", "getprop"].includes(inner[0])) return "device_query";
  return "other";
}
