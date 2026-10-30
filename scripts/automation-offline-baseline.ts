// Run with: bun scripts/automation-offline-baseline.ts [sample-count]
// Fixed mocks exercise the real observation orchestration. This does not measure a phone or model.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { debugTimingsSchema } from "../shared/debug-timing";

const sampleCount = Number(process.argv[2] ?? 10);
if (!Number.isSafeInteger(sampleCount) || sampleCount < 10 || sampleCount > 100) throw new Error("样本量须为 10—100；P95 至少需要 30 个样本。");
const results = [];
for (const scenario of ["success", "ordered", "empty-tree", "cancel"]) {
  const samples = [];
  for (let index = 0; index < sampleCount; index++) {
    const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("../tests/fixtures/debug-observation-timing.mjs", import.meta.url)), scenario],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 5000, encoding: "utf8" }));
    const timing = debugTimingsSchema.parse(result.timings);
    samples.push({ durationMs: timing.durationMs, status: timing.status, observations: timing.observationCount, inputCalls: result.inputCalls,
      stages: timing.spans.map(span => ({ phase: span.phase, startOffsetMs: span.startOffsetMs, durationMs: span.durationMs, status: span.status })) });
  }
  const sorted = samples.map(value => value.durationMs).sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  results.push({ scenario, sampleCount, medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    maxMs: sorted.at(-1), ...(sampleCount >= 30 ? { p95Ms: sorted[Math.ceil(sampleCount * 0.95) - 1] } : {}), samples });
}
console.log(JSON.stringify({ schemaVersion: 1, recordedAt: new Date().toISOString(), environment: { kind: "offline-mocked-observation", device: null,
  backend: "uiautomator-mock", page: "single-root-fixed-geometry", temperature: "isolated-process-per-sample; module startup excluded",
  toolCalls: null, modelDecisions: null, screenshotViews: null },
  limitation: "只验证固定离线流程的阶段、并行时序和失败/取消留证；设备命令均被模拟，不能用于手机或模型提速结论。", results }, null, 2));
