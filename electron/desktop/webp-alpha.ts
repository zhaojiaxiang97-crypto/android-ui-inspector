import { Worker } from "node:worker_threads";
import { LAYER_ALPHA_BUDGET_MS, sameImageSize, webpImageSize, type ImageSize } from "./layer-image-alpha";

/** One sequential, lazy worker per pass; timeout/cancellation discard late results and stop it. */
export function createWebpAlphaDecoder(options: { workerFile: string; timeoutMs?: number; budgetMs?: number }) {
  let worker: Worker | null = null, stopped = false;
  const deadline = performance.now() + (options.budgetMs ?? LAYER_ALPHA_BUDGET_MS);
  let finishPending: ((value: boolean | undefined) => void) | null = null;
  let termination: Promise<unknown> | null = null;
  const stop = () => {
    stopped = true;
    finishPending?.(undefined);
    if (worker) {
      const current = worker; worker = null;
      termination = current.terminate().catch(() => undefined);
    }
  };
  return {
    async measure(data: Buffer, size: ImageSize, signal?: AbortSignal): Promise<boolean | undefined> {
      signal?.throwIfAborted();
      if (stopped || finishPending) return undefined;
      if (performance.now() >= deadline) { stop(); return undefined; }
      const actual = webpImageSize(data);
      if (!actual || !sameImageSize(actual, size)) return undefined;
      const starting = !worker;
      if (!worker) {
        try {
          worker = new Worker(options.workerFile, {
            resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
          });
          worker.on("error", stop);
          worker.on("exit", stop);
        } catch { stop(); return undefined; }
      }
      const current = worker;
      const empty = await new Promise<boolean | undefined>(resolve => {
        // First request includes native module loading. This never extends the whole-pass budget.
        const requestDeadline = Math.min(performance.now() + (options.timeoutMs ?? (starting ? 2000 : 1000)), deadline);
        const finish = (value: boolean | undefined) => {
          clearTimeout(timer); signal?.removeEventListener("abort", stop);
          current.removeListener("message", onMessage); finishPending = null; resolve(value);
        };
        const onMessage = (value: unknown) => {
          if (performance.now() >= requestDeadline) stop();
          else finish(typeof value === "boolean" ? value : undefined);
        };
        const timer = setTimeout(stop, Math.max(0, requestDeadline - performance.now()));
        finishPending = finish;
        current.once("message", onMessage); signal?.addEventListener("abort", stop, { once: true });
        try { current.postMessage({ bytes: data, size }); } catch { stop(); }
        if (signal?.aborted) stop();
      });
      signal?.throwIfAborted();
      return empty;
    },
    async dispose() { stop(); await termination; },
  };
}
