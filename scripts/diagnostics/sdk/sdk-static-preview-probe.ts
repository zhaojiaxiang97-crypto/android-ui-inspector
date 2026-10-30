// Four bounded production-path captures, changing optional layer polling only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createProviderSessionPool } from "../../../electron/sdk/provider-session";
import { inspectPreferredDevice } from "../../../electron/capture/inspection";
import { assertStaticWorkload, staticCaptureSummary } from "../../static-capture-comparison";

const serial = process.argv[2];
assert.ok(serial && /^[\w.:-]+$/.test(serial), "Usage: bun scripts/diagnostics/sdk/sdk-static-preview-probe.ts SERIAL");
const pkg = "com.androiduiinspector.sample";
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 15000 });
const directory = join(import.meta.dirname, "../../../.benchmarks/static-preview", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(directory, { recursive: true });
console.log(`Static comparison: ${directory}`);
const previous = /(?:mResumedActivity:|topResumedActivity=).*?\s([\w.]+\/[\w.$]+)\s/.exec(adb("shell", "dumpsys", "activity", "activities"))?.[1];
const rounds: unknown[] = [];
const save = (passed: boolean, error?: string) => writeFileSync(join(directory, "summary.json"), JSON.stringify({
  passed, error, order: [true, false, false, true], warmMs: 2000, maxRoundMs: 30000, rounds,
  scope: "same-process static sample; encoded-image equality, not RGBA/business/cold-start acceptance",
}, null, 2));
const provider = createProviderSessionPool();
try {
  adb("shell", "am", "start", "-S", "-W", "-n", `${pkg}/.MainActivity`, "--es", "mode", "stress-rectangle");
  await delay(2000);
  let reference: ReturnType<typeof staticCaptureSummary> | undefined;
  for (const layerPreviewPolling of [true, false, false, true]) {
    const started = performance.now();
    const previews: { phase: string; receivedMs: number }[] = [];
    const snapshot = await inspectPreferredDevice(provider, serial, { expectedPackage: pkg, preferVisibleSdk: true,
      startupRetry: false, allowAppRestart: false, signal: AbortSignal.timeout(30000), layerPreviewPolling,
      onPreview: phase => previews.push({ phase, receivedMs: Math.round(performance.now() - started) }) });
    const durationMs = Math.round(performance.now() - started);
    const row: Record<string, unknown> = { round: rounds.length + 1, layerPreviewPolling, durationMs,
      error: snapshot.error, warning: snapshot.warning, timings: snapshot.captureTimings,
      attempts: snapshot.captureRequestDiagnostics, previews };
    rounds.push(row); save(false, "comparison incomplete");
    const workload = staticCaptureSummary(snapshot);
    row.workload = workload; save(false, "comparison incomplete");
    assert.ok(durationMs <= 15000, "health budget exceeded; do not run more pressure rounds");
    if (reference) assertStaticWorkload(reference, workload);
    else reference = workload;
    console.log(JSON.stringify({ round: rounds.length, layerPreviewPolling, durationMs, images: workload.images,
      previewIo: snapshot.root?.attributes?.["sdk-preview-io"] }));
  }
  save(true);
} catch (error) { save(false, String(error)); throw error; }
finally {
  await provider.dispose();
  if (previous && !previous.startsWith(`${pkg}/`)) adb("shell", "am", "start", "-n", previous);
}
