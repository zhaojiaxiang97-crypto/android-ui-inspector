import type { UiSnapshot } from "../../shared/types";
import { assessCaptureGeometry } from "../../shared/screen-coordinates";
import { withCommandSignal } from "../device/command-context";
import { captureSignal } from "../device/runtime";
import type { InspectionOptions, InspectionPreview } from "./types";

type PreviewScreen = Pick<UiSnapshot, "screenshotDataUrl" | "captureGeometry">;
type PreviewOptions = {
  signal: AbortSignal;
  progressive: boolean;
  screenTimeoutMs: number;
  readScreen(): Promise<PreviewScreen>;
  verifyForeground(): Promise<boolean>;
  snapshot(screen: PreviewScreen | null): UiSnapshot;
  publish: NonNullable<InspectionOptions["onPreview"]>;
  timings: Record<string, number>;
  beforeBlockingScreen(): void;
};

/** Owns the optional screenshot until this attempt finishes; tree/layer delivery never waits for it in standard mode. */
export function createSnapshotPreview(options: PreviewOptions) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  let screen: PreviewScreen | null = null;
  let screenTask: Promise<void> | undefined;
  let screenDelivery: Promise<void> | undefined;
  let treePublished = false, screenPublished = false;
  const active = () => !signal.aborted;

  const beginTreeScreen = () => screenTask ??= (async () => {
    const started = performance.now();
    try {
      signal.throwIfAborted();
      const value = await withCommandSignal(captureSignal(signal, options.screenTimeoutMs), options.readScreen);
      if (active() && value.screenshotDataUrl && value.captureGeometry
        && assessCaptureGeometry(value.captureGeometry).status === "checked") screen = value;
    } catch {
      // An optional preview must not fail the capture. Caller cancellation is checked at publication boundaries.
    } finally { options.timings["首屏截图"] = Math.round(performance.now() - started); }
  })();

  const verified = async (phase: "tree" | "layers" | "screen") => {
    if (!active()) return false;
    const started = performance.now();
    const valid = await withCommandSignal(signal, options.verifyForeground);
    options.timings[phase === "tree" ? "树预览前台校验" : phase === "screen" ? "截图预览前台校验" : "图层预览前台校验"] = Math.round(performance.now() - started);
    return valid && active();
  };
  const deliverScreen = () => screenDelivery ??= (async () => {
    try {
      await beginTreeScreen();
      if (!treePublished || screenPublished || !screen || !await verified("screen")) return;
      screenPublished = true;
      options.publish("screen", options.snapshot(screen));
    } catch { /* Foreground changes and cancellation suppress optional late pixels. */ }
  })();

  const preview: InspectionPreview = Object.assign(async (phase: "tree" | "layers") => {
    try {
      options.signal.throwIfAborted();
      if (!active()) return;
      if (phase === "tree") {
        if (options.progressive) void beginTreeScreen();
        else { options.beforeBlockingScreen(); await beginTreeScreen(); }
      }
      if (!await verified(phase)) return;
      options.publish(phase, options.snapshot(screen));
      if (phase === "tree") {
        treePublished = true;
        screenPublished = screen !== null;
        if (options.progressive && !screenPublished) void deliverScreen();
      }
    } catch { options.signal.throwIfAborted(); }
  }, { beginTreeScreen });

  return {
    preview,
    async close() {
      lifetime.abort();
      // Drain owned commands before returning or retrying; nothing can publish into the next attempt.
      await Promise.all([screenTask, screenDelivery]);
    },
  };
}
