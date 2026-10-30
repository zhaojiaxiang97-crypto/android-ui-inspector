// Sample-only bounded overlap/serial experiment. Validates the real image stream and sidecars.
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { createHash } from "node:crypto";
import { parseCapturedViewLayers } from "../../../electron/capture/view-protocol";
import { parseCaptureGeometryFile } from "../../../electron/capture/layer-images";
import { parseProcessLoad } from "./sdk-device-load";
import { parseMethodProfile } from "./sdk-method-profile";
import { parseThreadStat } from "./sdk-thread-scheduler-probe";
import { parseSchedstat } from "./sdk-scheduler-probe";
import { validatePipelineWaits, validateSnapshotWaits } from "../../pipeline-wait-validation";
import { outputCases, outputFirstCases, validateBufferedOutput } from "../../buffered-output-validation";
import { validateFormatCachePipeline } from "../../format-cache-pipeline-validation";

const [serial, token, pipelineCase] = process.argv.slice(2);
const formatCase = pipelineCase === "format-cache-pipeline";
const snapshotWaitCase = pipelineCase === "snapshot-wait-diagnostic";
const systemTraceCase = pipelineCase === "snapshot-system-trace";
const methodTraceCase = pipelineCase === "snapshot-method-trace";
const managedCases = ["continuous-managed-control", "continuous-managed-profile"];
const matchedCases = ["continuous-matched-control", "continuous-matched-stages", "hardware-pipeline-comparison", "continuous-pipeline-waits", "continuous-pipeline-waits-control", ...outputCases.slice(0, 2)];
const gateCases = ["software-pixel-gate", "hardware-reuse-pixel-gate"];
const reuseCases = ["hardware-reuse-comparison", "hardware-reuse-safety"];
const continuousCases = [...matchedCases, ...managedCases, "continuous-cpu-control", "continuous-clean", "continuous-long-clean", "continuous-fixtures", "continuous-preflight", "continuous-protocol", "continuous-faults",
  "continuous-preflight-protocol", "continuous-preflight-faults", "continuous-protocol-faults"];
if (pipelineCase && !["snapshot-method-trace", "snapshot-system-trace", "snapshot-wait-diagnostic", "format-cache-pipeline", ...outputCases, ...reuseCases, ...gateCases, "original", "candidate", "serial", "lightweight", "lightweight-comparison", "ui-batch-comparison", "ui-dispatch-comparison", ...continuousCases, "lightweight-safety", "sdk-geometry"].includes(pipelineCase)) throw new Error("Invalid pipeline case");
if (!serial || !/^[\w.:-]+$/.test(serial) || !token || !/^[\w-]{1,100}$/.test(token)) throw new Error("Usage: bun scripts/diagnostics/sdk/sdk-geometry-pipeline-probe.ts SERIAL TOKEN");
const pkg = "com.androiduiinspector.sample";
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 5000, maxBuffer: 64_000_000 });
const firstCapture = process.argv.includes("--first-capture");
const idle40 = process.argv.includes("--idle40");
if (process.argv.includes("--first-capture-matrix")) {
  assert.ok(!firstCapture && !idle40, "Matrix owns its first-capture/idle arguments");
  const run = promisify(execFile);
  const samples: any[] = [];
  const identities = new Set<string>();
  const reverse = process.argv.includes("--reverse");
  const outputMatrix = outputFirstCases.includes(pipelineCase);
  const paths = outputMatrix ? outputFirstCases : ["original", "lightweight"];
  for (const idle of [false, true]) for (let index = 0; index < 3; index++) {
    const order = (index % 2 === 0) !== reverse ? paths : [...paths].reverse();
    for (const path of order) {
      console.error(`First capture ${samples.length + 1}/12: ${path}, ${idle ? "idle40" : "immediate"}`);
      const args = [fileURLToPath(import.meta.url), serial, `${token}-${samples.length}`, path, "--first-capture", ...(idle ? ["--idle40"] : [])];
      try {
        const { stdout } = await run(process.execPath, args, { timeout: 210_000, maxBuffer: 4_000_000 });
        const sample = JSON.parse(stdout);
        assert.ok(!identities.has(sample.osIdentity), "A new sample process is required");
        identities.add(sample.osIdentity);
        if (samples.length) {
          assert.equal(sample.imageManifestSha256, samples[0].imageManifestSha256, "Cross-process image mismatch");
          assert.equal(sample.rounds[0].geometryManifestSha256, samples[0].rounds[0].geometryManifestSha256, "Cross-process geometry mismatch");
        }
        samples.push(sample);
        console.error(`Validated: ${(sample.rounds[0].wallNanos / 1e9).toFixed(3)}s`);
      } catch (error) {
        console.log(JSON.stringify({ passed: false, comparison: "sample-first-capture", samples,
          failedCase: { path, idle, index }, error: String(error) }, null, 2));
        throw error; // Keep all completed rounds; never retry away a failed sample.
      }
    }
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = [0, 40_000].map(idle => {
    const group = (lightweight: boolean) => samples.filter(sample => sample.requestedIdleMillis === idle && (outputMatrix ? sample.rounds[0].bufferedOutput : sample.rounds[0].lightweight) === lightweight);
    return { idleMillis: idle,
      originalSeconds: group(false).map(sample => sample.rounds[0].wallNanos / 1e9),
      [outputMatrix ? "candidateSeconds" : "lightweightSeconds"]: group(true).map(sample => sample.rounds[0].wallNanos / 1e9),
      originalMedianSeconds: median(group(false).map(sample => sample.rounds[0].wallNanos / 1e9)),
      [outputMatrix ? "candidateMedianSeconds" : "lightweightMedianSeconds"]: median(group(true).map(sample => sample.rounds[0].wallNanos / 1e9)) };
  });
  console.log(JSON.stringify({ passed: true, comparison: "sample-first-capture", noExternalSampler: true,
    productionSdkChanged: false, outputMatrix, newProcesses: identities.size, reverse, summary, samples }, null, 2));
  process.exit(0);
}
assert.ok(!idle40 || firstCapture || pipelineCase === "continuous-clean" || gateCases.includes(pipelineCase), "Idle requires first capture, continuous-clean or pixel gate");
assert.ok(!firstCapture || ["original", "lightweight", ...outputFirstCases].includes(pipelineCase), "First capture requires one path");
const readIdentity = () => {
  const pid = adb("shell", "pidof", pkg).toString().trim();
  assert.match(pid, /^\d+$/);
  return `${pid}:${parseProcessLoad(adb("exec-out", "run-as", pkg, "cat", `/proc/${pid}/stat`).toString(), pid).startTicks}`;
};
let osIdentity: string | undefined;
let startupMs: number | undefined;
if (firstCapture) {
  const began = performance.now();
  const launch = adb("shell", "am", "start", "-S", "-W", "-n", `${pkg}/.MainActivity`,
    "--es", "mode", "stress-rectangle", "--ez", "geometrySerializationProbe", "true", "--ez", "geometryPipelineProbe", "true",
    "--es", "geometryPipelineCase", pipelineCase, "--es", "probeToken", token,
    "--ez", "geometryFirstCapture", "true", "--ei", "geometryIdleMillis", idle40 ? "40000" : "0").toString();
  assert.match(launch, /Status: ok/);
  startupMs = Math.round(performance.now() - began);
  osIdentity = readIdentity();
}
let report: any;
const deadline = performance.now() + 210_000;
// Keep report polling sparse: even a tiny adb read can perturb device scheduling.
await wait(idle40 ? 55_000 : 15_000); // No report polling during the idle interval.
do {
  try {
    const candidate = JSON.parse(adb("exec-out", "run-as", pkg, "cat", "files/isolation-probe/geometry-pipeline.json").toString());
    if (candidate.probeToken === token) { report = candidate; break; }
  } catch {}
  await wait(5000);
} while (performance.now() < deadline);
assert.ok(report, "Fresh pipeline report missing");
if (!report.passed) console.log(JSON.stringify(report, null, 2));
assert.equal(report.passed, true, JSON.stringify(report));
if (pipelineCase === "sdk-geometry") {
  assert.equal(report.sdkGeometry.images, 407);
  assert.equal(report.sdkGeometry.records, 405);
  assert.equal(report.sdkGeometry.pixelAndProtocolVerified, true);
  assert.equal(report.sdkGeometry.noUiJson, true);
  console.log(JSON.stringify(report, null, 2)); process.exit(0);
}
if (pipelineCase === "lightweight-safety") {
  assert.equal(report.safety.cases.length, 9);
  assert.ok(report.safety.cases.every((row: any) => row.rejected && row.bitmapRecycled));
  assert.ok(report.safety.cases.filter((row: any) => row.case.startsWith("cancel-") || row.case === "timeout-late")
    .every((row: any) => row.callerStopped));
  assert.equal(report.safety.recovered, true);
  assert.equal(report.safety.fixtureRemoved, true);
  if (report.safety.sdkDrawMutationsRejected !== 0) {
    assert.equal(report.safety.sdkDrawMutationsRejected, 5);
    assert.equal(report.safety.sdkQueueOwnership, true);
  }
  console.log(JSON.stringify(report, null, 2)); process.exit(0);
}
assert.equal(report.workers, 2);
assert.equal(report.queueBudget, 4);
assert.equal(report.validatedLayers, 407);
assert.equal(report.retention, "bounded-metadata");
assert.equal(report.immutableProtocolVerified, !methodTraceCase && !systemTraceCase && !snapshotWaitCase && !formatCase && !firstCapture && ![...outputCases, ...reuseCases, ...gateCases, ...matchedCases, ...managedCases, "continuous-cpu-control", "continuous-clean", "continuous-long-clean", "continuous-faults", "continuous-preflight", "continuous-preflight-faults"].includes(pipelineCase));
assert.equal(report.preflightCapture, !methodTraceCase && !systemTraceCase && !snapshotWaitCase && !formatCase && !firstCapture && ![...outputCases, ...reuseCases, ...gateCases, ...matchedCases, ...managedCases, "continuous-cpu-control", "continuous-clean", "continuous-long-clean", "continuous-faults", "continuous-protocol", "continuous-protocol-faults"].includes(pipelineCase));
assert.equal(report.firstCaptureBenchmark, firstCapture);
if (firstCapture) {
  assert.equal(readIdentity(), osIdentity, "Sample process changed");
  assert.equal(report.requestedIdleMillis, idle40 ? 40_000 : 0);
  if (idle40) assert.ok(report.idleNanos >= 40_000_000_000 && report.idleNanos <= 60_000_000_000);
  report.osIdentity = osIdentity;
  report.startupMs = startupMs;
}
assert.equal(report.pipelineCase, pipelineCase ?? "abba");
assert.equal(report.rounds.length, snapshotWaitCase ? 2 : formatCase ? 6 : pipelineCase === "buffered-output-chain-safety" ? 5 : pipelineCase === "buffered-output-safety" ? 4 : reuseCases.includes(pipelineCase) ? 2 : pipelineCase === "continuous-long-clean" ? 12
  : ["lightweight-comparison", "ui-batch-comparison", "ui-dispatch-comparison", ...continuousCases].includes(pipelineCase) ? 6 : pipelineCase ? 1 : 8);
if (outputCases.includes(pipelineCase)) {
  validateBufferedOutput(report, pipelineCase);
}
if (formatCase) validateFormatCachePipeline(report);
if (snapshotWaitCase) report.snapshotWaitSummary = validateSnapshotWaits(report);
if (systemTraceCase || methodTraceCase) {
  assert.equal(report.productionSdkChanged, false);
  const row = report.rounds[0];
  if (systemTraceCase) { assert.equal(row.traceMarkers, true); assert.equal(row.traceCaptureCount, 407); }
  else {
    assert.equal(row.methodTrace, true); assert.equal(row.traceMarkers, undefined);
    const window = row.methodWindow;
    assert.equal(window.file, "methods-0.trace"); assert.equal(window.pid, row.boundaryBefore.pid);
    assert.equal(window.softBound, true); assert.equal(window.intervalUs, 2000);
    assert.equal(window.bufferBytes, 8 * 1024 * 1024);
    for (const key of ["windowNanos", "startNanos", "stopNanos", "bytes"])
      assert.ok(Number.isSafeInteger(window[key]) && window[key] > 0);
    assert.ok(window.windowNanos >= 1e9 && window.windowNanos <= 15e9);
    const trace = adb("exec-out", "run-as", pkg, "cat", "files/isolation-probe/methods-0.trace");
    assert.equal(trace.length, window.bytes);
    window.profile = parseMethodProfile(trace, String(window.pid), "geometry-encode");
  }
  assert.equal(row.schedulerFileReads, 0); assert.equal(row.extraCaptures, 0);
  assert.equal(row.pipelineWaits, undefined);
  assert.equal(row.uiBatchGeometry, "sdk-immutable"); assert.equal(row.uiBatchSize, 1);
  assert.equal(row.uiPosts, 407); assert.equal(row.formatMode, "platform");
  assert.equal(row.cacheWorkers.length, 0); assert.equal(row.encodedBytesVerified, true);
  assert.equal(row.outputRootVerified, true); assert.ok(row.wallNanos > 0 && row.wallNanos <= 15e9);
}
if (pipelineCase === "hardware-pipeline-comparison") {
  assert.equal(typeof report.reversed, "boolean");
  for (const [index, round] of report.rounds.entries()) {
    const reused = (index % 2 === 1) !== report.reversed;
    assert.equal(round.hardwareReuse, reused);
    assert.equal(round.replacedLayers, reused ? 64 : 0);
    assert.equal(round.rendererCreations, reused ? 1 : 0);
    assert.equal(round.rendererClosed, true);
    assert.equal(round.reuseDrawIncludesCpuCopy, reused);
    assert.ok(Number.isSafeInteger(round.rendererCloseNanos) && round.rendererCloseNanos >= 0);
    if (reused) assert.ok(round.rendererCloseNanos > 0 && round.rendererCloseNanos < round.wallNanos);
    const endAge = round.boundaryAfterPipeline.uptimeMs - round.boundaryAfterPipeline.processStartUptimeMs;
    if (index < 3) assert.ok(endAge < 30_000, "Early full pipeline missed startup period");
  }
}
if (continuousCases.includes(pipelineCase)) {
  const setups: Record<string, string> = { "continuous-matched-control": "none", "continuous-matched-stages": "none", "continuous-managed-control": "none", "continuous-managed-profile": "none", "continuous-cpu-control": "none", "continuous-clean": "none", "continuous-long-clean": "none", "continuous-fixtures": "preflight-and-faults",
    "continuous-pipeline-waits": "none", "continuous-pipeline-waits-control": "none",
    "continuous-preflight": "preflight-only", "continuous-protocol": "protocol-only", "continuous-faults": "faults-only",
    "continuous-preflight-protocol": "preflight-and-protocol", "continuous-preflight-faults": "preflight-and-faults-only",
    "continuous-protocol-faults": "protocol-and-faults" };
  assert.equal(report.setup, setups[pipelineCase]);
  assert.equal(report.requestedIdleMillis, idle40 ? 40_000 : 0);
  if (idle40) assert.ok(report.idleNanos >= 40_000_000_000 && report.idleNanos <= 60_000_000_000);
  if (!["continuous-fixtures", "continuous-faults", "continuous-preflight-faults", "continuous-protocol-faults"].includes(pipelineCase)) assert.equal(report.uiBatchSafety, undefined);
  else {
    assert.equal(report.uiBatchSafety.cases.length, 4);
    assert.equal(report.uiBatchSafety.recovered, true);
    assert.equal(report.uiBatchSafety.lateResultsRejected, true);
  }
  let previous: any;
  let cpuChecksum: string | undefined;
  let expectedCpuChecksum: string | undefined;
  if (pipelineCase === "continuous-cpu-control" || managedCases.includes(pipelineCase)) {
    const input = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < input.length; index++) input[index] = (index * 31 + 7) & 255;
    const hash = createHash("sha256");
    for (let index = 0; index < 64; index++) hash.update(input);
    expectedCpuChecksum = hash.digest("hex");
  }
  let loopChecksum = 0x12345678;
  let jsonChecksum = 0;
  if (managedCases.includes(pipelineCase)) {
    for (let index = 0; index < 4_000_000; index++) loopChecksum = Math.imul(loopChecksum ^ (loopChecksum >>> 13), 0x5bd1e995);
    for (let index = 0; index < 4096; index++) {
      const json = JSON.stringify({ i: index, label: `node-${index}`, visible: true });
      for (let at = 0; at < json.length; at++) jsonChecksum = (Math.imul(jsonChecksum, 31) + json.charCodeAt(at)) | 0;
    }
  }
  for (const round of report.rounds) {
    if (pipelineCase === "continuous-pipeline-waits") validatePipelineWaits(round);
    else assert.equal(round.pipelineWaits, undefined);
    if (matchedCases.includes(pipelineCase)) {
      const age = round.boundaryBefore.uptimeMs - round.boundaryBefore.processStartUptimeMs;
      if (report.rounds.indexOf(round) >= 3) assert.ok(age >= 40_000);
      else {
        assert.ok(age < 30_000, "Early matched range missed startup period");
        if (pipelineCase.startsWith("continuous-pipeline-waits"))
          assert.ok(round.boundaryAfterPipeline.uptimeMs - round.boundaryAfterPipeline.processStartUptimeMs < 30_000);
      }
    }
    if (pipelineCase === "continuous-matched-stages") {
      const stages = round.matchedStages;
      assert.equal(stages.first, 32); assert.equal(stages.end, 96);
      assert.equal(stages.proxyRows.length, 64);
      assert.equal(stages.proxyPixelsVerified, true); assert.equal(stages.proxyIsAdditionalWork, true);
      assert.equal(stages.explicitCopyIsNotSdkReadback, true);
      assert.ok(Number.isSafeInteger(stages.observerNanos) && stages.observerNanos >= 0);
      assert.ok(Number.isSafeInteger(stages.extraDiagnosticNanos) && stages.extraDiagnosticNanos > 0);
      assert.equal(stages.threads.length, 3);
      assert.equal(new Set(stages.threads.map((row: any) => row.before.tid)).size, 3);
      assert.equal(stages.threads.filter((row: any) => row.before.role === "main").length, 1);
      assert.equal(stages.threads.filter((row: any) => row.before.role === "encoder").length, 2);
      for (const row of stages.threads) {
        assert.equal(row.before.tid, row.after.tid); assert.equal(row.before.role, row.after.role);
        if (row.before.role === "main") assert.equal(row.before.tid, round.boundaryBefore.pid);
        for (const boundary of [row.before, row.after]) {
          if (boundary.unavailable) continue;
          assert.ok(Number.isInteger(boundary.priority));
          if (boundary.stat !== undefined) boundary.parsedStat = parseThreadStat(boundary.stat, String(boundary.tid));
          else assert.equal(boundary.statUnavailable, true);
          if (boundary.schedstat !== undefined) boundary.parsedScheduler = parseSchedstat(boundary.schedstat);
          else assert.equal(boundary.schedstatUnavailable, true);
        }
        if (row.before.parsedStat && row.after.parsedStat) {
          assert.equal(row.before.parsedStat.startTicks, row.after.parsedStat.startTicks);
          assert.ok(row.after.parsedStat.cpuTicks >= row.before.parsedStat.cpuTicks);
        }
        if (row.before.parsedScheduler && row.after.parsedScheduler)
          for (const key of ["runtimeNs", "waitNs", "slices"]) assert.ok(row.after.parsedScheduler[key] >= row.before.parsedScheduler[key]);
      }
      for (const value of Object.values(stages.primary)) assert.ok(Number.isSafeInteger(value) && (value as number) >= 0);
      for (const key of ["uiCalls", "encodeCalls", "jsonCalls"]) assert.equal(stages.primary[key], 64);
    } else assert.equal(round.matchedStages, undefined);
    if (pipelineCase === "continuous-cpu-control" || managedCases.includes(pipelineCase)) {
      for (const sample of [round.fixedCpuBefore, round.fixedCpuAfter]) {
        assert.equal(sample.bytes, 67_108_864);
        assert.match(sample.sha256, /^[a-f0-9]{64}$/);
        assert.equal(sample.sha256, expectedCpuChecksum, "Fixed work differs from host reference");
        if (cpuChecksum) assert.equal(sample.sha256, cpuChecksum);
        cpuChecksum = sample.sha256;
        if (managedCases.includes(pipelineCase)) {
          assert.equal(sample.managed.iterations, 4_000_000);
          assert.equal(sample.managed.loopChecksum, loopChecksum);
          assert.equal(sample.managed.jsonRecords, 4096);
          assert.equal(sample.managed.jsonChecksum, jsonChecksum);
          for (const key of ["processAgeMs", "loopWallNanos", "loopCpuNanos", "jsonWallNanos", "jsonCpuNanos"])
            assert.ok(Number.isSafeInteger(sample.managed[key]) && sample.managed[key] >= 0);
        } else assert.equal(sample.managed, undefined);
        for (const key of ["processAgeMs", "wallNanos", "cpuNanos"]) assert.ok(Number.isSafeInteger(sample[key]) && sample[key] >= 0);
        for (const observation of [sample.before, sample.after]) {
          assert.ok(Number.isInteger(observation.tid) && observation.tid > 0);
          assert.ok(Number.isInteger(observation.priority));
          assert.ok(Number.isSafeInteger(observation.observerNanos) && observation.observerNanos >= 0);
          if (observation.schedstat !== undefined) assert.match(observation.schedstat, /^\d+\s+\d+\s+\d+$/);
          else assert.equal(observation.schedstatUnavailable, true);
          for (const policy of observation.frequencies) {
            assert.match(policy.policy, /^policy\d+$/);
            if (policy.currentKHz !== undefined) assert.match(policy.currentKHz, /^\d+$/);
            else assert.equal(policy.currentKHzUnavailable, true);
          }
        }
      }
      if (report.rounds.indexOf(round) >= 3) assert.ok(round.fixedCpuBefore.processAgeMs >= 40_000);
    }
    const index = report.rounds.indexOf(round);
    if (pipelineCase === "continuous-managed-profile" && [1, 4].includes(index)) {
      const window = round.methodWindow;
      assert.equal(window.file, `methods-${index}.trace`);
      assert.equal(window.pid, round.boundaryBefore.pid);
      assert.equal(window.softBound, true);
      assert.equal(window.intervalUs, 2000); assert.equal(window.bufferBytes, 8 * 1024 * 1024);
      for (const key of ["windowNanos", "startNanos", "stopNanos", "bytes"]) assert.ok(Number.isSafeInteger(window[key]) && window[key] > 0);
      assert.ok(window.windowNanos <= 15_000_000_000, "Sample window exceeded existing task bounds");
      const trace = adb("exec-out", "run-as", pkg, "cat", `files/isolation-probe/${window.file}`);
      assert.equal(trace.length, window.bytes);
      window.profile = parseMethodProfile(trace, String(window.pid), "geometry-encode");
    } else assert.equal(round.methodWindow, undefined);
    assert.equal(round.timedGeometryDigest, true);
    assert.equal(round.uiBatchSize, 1); assert.equal(round.uiPosts, 407); assert.equal(round.twoFrameTasks, 0);
    assert.equal(round.uiDispatch, "normal"); assert.equal(round.uiBatchGeometry, "sdk-immutable");
    assert.ok(!round.serial && !round.candidate && !round.lightweight);
    for (const key of ["uiQueueNanos", "uiTaskNanos", "uiTaskMaxNanos", "validationNanos"])
      assert.ok(Number.isSafeInteger(round[key]) && round[key] >= 0);
    for (const boundary of [round.boundaryBefore, round.boundaryAfterPipeline, round.boundaryAfterValidation]) {
      for (const key of ["pid", "processStartUptimeMs", "processCpuMs", "uptimeMs", "javaUsedBytes", "nativeAllocatedBytes", "observerNanos"])
        assert.ok(Number.isSafeInteger(boundary[key]) && boundary[key] >= 0);
      assert.ok(boundary.pid > 0);
      assert.ok(boundary.processStartUptimeMs > 0 && boundary.uptimeMs >= boundary.processStartUptimeMs);
      if (boundary.thermalStatus !== undefined) assert.ok(Number.isInteger(boundary.thermalStatus) && boundary.thermalStatus >= 0 && boundary.thermalStatus <= 6);
      if (boundary.batteryCelsius !== undefined) assert.ok(Number.isFinite(boundary.batteryCelsius));
      for (const [key, value] of Object.entries(boundary.runtimeStats)) {
        assert.match(key, /^art\.gc\./); assert.ok(Number.isSafeInteger(value) && (value as number) >= 0);
        if (previous?.runtimeStats[key] !== undefined) assert.ok((value as number) >= previous.runtimeStats[key]);
      }
      if (previous) {
        assert.equal(boundary.pid, previous.pid);
        assert.equal(boundary.processStartUptimeMs, previous.processStartUptimeMs);
        assert.ok(boundary.processCpuMs >= previous.processCpuMs && boundary.uptimeMs >= previous.uptimeMs);
      }
      previous = boundary;
    }
  }
} else if (pipelineCase === "ui-dispatch-comparison") {
  assert.equal(report.uiDispatchFixtures.length, 4);
  for (const async of [false, true]) {
    const barrier = report.uiDispatchFixtures.filter((c: any) => c.case === "barrier" && c.async === async);
    const busy = report.uiDispatchFixtures.filter((c: any) => c.case === "busy-ui" && c.async === async);
    assert.equal(barrier.length, 1); assert.equal(busy.length, 1);
    assert.equal(barrier[0].barrierActiveAtCapture, async);
    assert.equal(busy[0].ranAfterBusyWork, true);
    for (const c of [...barrier, ...busy]) assert.ok(Number.isSafeInteger(c.queueNanos) && c.queueNanos >= 0);
  }
  assert.equal(report.uiDispatchSafety.cases.length, 4);
  assert.equal(report.uiDispatchSafety.recovered, true);
  assert.equal(report.uiDispatchSafety.lateResultsRejected, true);
  for (const dispatch of ["normal", "async"])
    assert.equal(report.rounds.filter((r: any) => r.uiDispatch === dispatch).length, 3);
  for (const round of report.rounds) {
    assert.equal(round.uiBatchSize, 1); assert.equal(round.uiPosts, 407); assert.equal(round.twoFrameTasks, 0);
    assert.equal(round.uiBatchGeometry, "sdk-immutable");
    assert.ok(!round.serial && !round.candidate && !round.lightweight);
    for (const k of ["uiQueueNanos", "uiTaskNanos", "uiTaskMaxNanos"])
      assert.ok(Number.isSafeInteger(round[k]) && round[k] >= 0);
    assert.ok(round.uiTaskMaxNanos <= round.uiTaskNanos);
  }
} else if (pipelineCase === "ui-batch-comparison") {
  assert.equal(report.uiBatchSafety.cases.length, 4);
  assert.equal(report.uiBatchSafety.recovered,true);
  assert.equal(report.uiBatchSafety.lateResultsRejected,true);
  assert.equal(report.rounds.filter((r: any)=>r.uiBatchSize===1).length,3);
  assert.equal(report.rounds.filter((r: any)=>r.uiBatchSize===2).length,3);
  for(const round of report.rounds) {
    assert.equal(round.uiBatchGeometry,"sdk-immutable");
    assert.ok(!round.serial && !round.candidate && !round.lightweight);
    assert.equal(round.uiPosts+round.twoFrameTasks,407);
    assert.ok(round.uiPosts>=204 && round.uiPosts<=407);
    if(round.uiBatchSize===1) assert.equal(round.twoFrameTasks,0);
    for(const k of ["uiQueueNanos","uiTaskNanos","uiTaskMaxNanos"]) assert.ok(Number.isSafeInteger(round[k])&&round[k]>=0);
    assert.ok(round.uiTaskMaxNanos<=round.uiTaskNanos);
  }
} else if (pipelineCase === "lightweight-comparison") {
  assert.equal(report.rounds.filter((round: any) => round.lightweight).length, 3);
  assert.equal(report.rounds.filter((round: any) => !round.lightweight).length, 3);
  assert.ok(report.rounds.every((round: any) => !round.serial && !round.candidate));
} else if (pipelineCase) {
  assert.equal(report.rounds[0].serial, pipelineCase === "serial");
  assert.equal(report.rounds[0].candidate, pipelineCase === "candidate");
  assert.equal(report.rounds[0].lightweight, pipelineCase === "lightweight");
} else {
  assert.equal(report.rounds.filter((round: any) => round.serial && !round.candidate).length, 2);
  assert.equal(report.rounds.filter((round: any) => !round.serial && round.candidate).length, 2);
  assert.equal(report.rounds.filter((round: any) => !round.serial && !round.candidate).length, 4);
}
const imageStream = adb("exec-out", "run-as", pkg, "cat", "files/isolation-probe/geometry-load-images.bin");
if (outputFirstCases.includes(pipelineCase) || pipelineCase === "buffered-output-chain-safety") assert.equal(createHash("sha256").update(imageStream).digest("hex"), report.rounds.at(-1).outputSha256, "Published file digest mismatch");
assert.equal(imageStream.subarray(0, 8).toString("hex"), report.rounds.at(-1).geometryNonce);
const images = parseCapturedViewLayers(imageStream);
assert.equal(images.length, 407);
if (pipelineCase === "hardware-reuse-comparison") {
  assert.equal(report.hardwareReuseComparisons.length, 6);
  for (const [index, block] of report.hardwareReuseComparisons.entries()) {
    assert.equal(block.index, index); assert.equal(block.rows.length, 64);
    assert.equal(block.rendererCreations, 1); assert.equal(block.captures, 64); assert.equal(block.resourcesClosed, true);
    assert.equal(block.initializationIncluded, true); assert.equal(block.bothPathsIncludeCpuCopy, true); assert.equal(block.productionSdkChanged, false);
    assert.ok(block.endAgeMs >= block.processAgeMs);
    if (index < 3) assert.ok(block.endAgeMs < 30_000, "Early block left startup period");
    else assert.ok(block.processAgeMs >= 40_000);
    for (const key of ["closeWallNanos", "closeCpuNanos"]) assert.ok(Number.isSafeInteger(block[key]) && block[key] >= 0);
    for (const [offset, target] of block.rows.entries()) {
      assert.equal(target.ordinal, 32 + offset); assert.equal(target.ref, images[target.ordinal].name);
      assert.equal(target.width, images[target.ordinal].width); assert.equal(target.height, images[target.ordinal].height);
      assert.equal(target.reuseFirst, ((target.ordinal + index) % 2 === 0) !== block.reverse);
      assert.match(target.sdkRgbaSha256, /^[0-9a-f]{64}$/); assert.equal(target.reusedRgbaSha256, target.sdkRgbaSha256);
      for (const key of ["reuseWallNanos", "originalWallNanos", "reuseCpuNanos", "originalCpuNanos", "reuseQueueNanos", "originalQueueNanos"])
        assert.ok(Number.isSafeInteger(target[key]) && target[key] >= 0);
    }
  }
}
if (pipelineCase === "hardware-reuse-safety") {
  const safety = report.hardwareReuseSafety;
  assert.deepEqual(safety.cases.map((row: any) => row.case), ["wrong-size", "occupied-image-reentry-close", "readback-failure", "closed-renderer", "cancel-before", "cancel-active", "timeout-late"]);
  assert.ok(safety.cases.every((row: any) => row.rejected));
  for (const row of safety.cases.slice(4)) {
    assert.equal(row.callerStopped, true); assert.equal(row.resourcesClosed, true);
    assert.equal(row.lateResultsRecycled, row.case === "cancel-before" ? 0 : 1);
  }
  assert.equal(safety.recoveredPixelsVerified, true); assert.equal(safety.resourcesClosed, true);
  assert.equal(safety.productionSdkChanged, false); assert.equal(safety.saturatedBufferQueueTested, false);
}
if (gateCases.includes(pipelineCase)) {
  const hardwareReuse = pipelineCase === "hardware-reuse-pixel-gate";
  const gate = hardwareReuse ? report.hardwareReuseGate : report.softwareGate;
  assert.equal(gate.first, 32); assert.equal(gate.end, 96);
  assert.equal(report.requestedIdleMillis, idle40 ? 40_000 : 0);
  if (idle40) {
    assert.ok(report.idleNanos >= 40_000_000_000 && report.idleNanos <= 60_000_000_000);
    assert.ok(gate.processAgeMs >= 40_000);
  } else if (gate.processAgeMs !== undefined) assert.ok(gate.processAgeMs < 30_000, "Early pixel gate missed startup period");
  assert.equal(gate.productionSdkChanged, false); assert.equal(gate.performanceBenchmarkRun, false);
  assert.ok(gate.rows.length > 0 && gate.rows.length <= 64);
  for (const [offset, target] of gate.rows.entries()) {
    assert.equal(target.ordinal, 32 + offset); assert.equal(target.ref, images[target.ordinal].name);
    assert.equal(target.width, images[target.ordinal].width); assert.equal(target.height, images[target.ordinal].height);
    assert.equal(target.geometryVerified, true);
    const actual = hardwareReuse ? target.reusedRgbaSha256 : target.softwareRgbaSha256;
    assert.match(target.sdkRgbaSha256, /^[0-9a-f]{64}$/); assert.match(actual, /^[0-9a-f]{64}$/);
    assert.equal(target.pixelsMatch, target.sdkRgbaSha256 === actual);
    if (offset < gate.rows.length - 1) assert.equal(target.pixelsMatch, true);
  }
  assert.equal(gate.accepted, gate.rows.length === 64 && gate.rows.at(-1).pixelsMatch);
  assert.equal(gate.stoppedOnMismatch, !gate.rows.at(-1).pixelsMatch);
  if (hardwareReuse) {
    assert.equal(gate.rendererCreations, 1); assert.equal(gate.captures, gate.rows.length);
    assert.equal(gate.resourcesClosed, true); assert.equal(gate.fixedSizeOnly, true);
  }
}
const pageHash = createHash("sha256");
for (const image of images) pageHash.update(JSON.stringify([image.name.replace(/@[0-9a-f]+$/i, ""), image.x, image.y,
  image.width, image.height, createHash("sha256").update(image.imageDataUrl!).digest("hex")]));
report.imageManifestSha256 = pageHash.digest("hex");
for (const round of report.rounds) {
  if (round.matchedStages) for (const [offset, target] of round.matchedStages.proxyRows.entries()) {
    assert.equal(target.ordinal, 32 + offset);
    assert.equal(target.ref, images[target.ordinal].name);
    assert.equal(target.width, images[target.ordinal].width); assert.equal(target.height, images[target.ordinal].height);
    for (const key of ["canvasWallNanos", "canvasCpuNanos", "recordWallNanos", "recordCpuNanos", "bitmapWallNanos", "bitmapCpuNanos", "copyWallNanos", "copyCpuNanos"])
      assert.ok(Number.isSafeInteger(target[key]) && target[key] >= 0);
  }
  if (round.sampledMemory) {
    for (const key of ["samples", "baselinePssKb", "peakPssKb", "peakNativeBytes", "peakJavaBytes"])
      assert.ok(Number.isSafeInteger(round.sampledMemory[key]) && round.sampledMemory[key] > 0, key);
    assert.equal(round.sampledMemory.intervalMs, 250);
    assert.ok(round.sampledMemory.peakPssKb >= round.sampledMemory.baselinePssKb);
  }
  assert.equal(round.images, 407);
  assert.equal(round.geometryRecords, 405);
  assert.equal(round.pixelsVerified, true);
  assert.match(round.pixelSha256, /^[0-9a-f]{64}$/);
  assert.equal(round.pixelSha256, report.rounds[0].pixelSha256);
  assert.equal(round.peakDepth, round.serial ? 1 : 4);
  assert.match(round.geometryNonce, /^[0-9a-f]{16}$/);
  assert.ok(Number.isSafeInteger(round.geometryBytes) && round.geometryBytes > 0 && round.geometryBytes <= 3_900_000);
  for (const key of ["wallNanos", "encodeWallNanos", "jsonWallNanos", "geometryCheckWallNanos", "encodeCpuNanos", "jsonCpuNanos"]) {
    if (key.endsWith("CpuNanos") && round[key] === undefined) continue;
    assert.ok(Number.isSafeInteger(round[key]) && round[key] >= 0, key);
  }
  const name = `no_backup/inspector-geometry-${round.geometryNonce}.json`;
  const bytes = adb("exec-out", "run-as", pkg, "cat", name);
  assert.equal(bytes.length, round.geometryFileBytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), round.geometrySha256);
  const records = parseCaptureGeometryFile(bytes, round.geometryNonce, round.processInstance, round.rootRef, images);
  assert.equal(records.size, 405);
  // Compare process-independent structure too; identity edges stay linked by ordinal,
  // rather than dropping refs or treating same-class siblings as the same object.
  const identities = new Map<string, number>();
  const identity = (ref: string) => {
    if (!ref) return "";
    if (!identities.has(ref)) identities.set(ref, identities.size);
    return [ref.replace(/@[0-9a-f]+$/i, ""), identities.get(ref)];
  };
  const geometryHash = createHash("sha256");
  for (const record of records.values()) {
    const { started, ended, ref, rootRef, chain, clipContext, ...rest } = record;
    assert.ok(ended >= started);
    geometryHash.update(JSON.stringify({ ref: identity(ref), rootRef: identity(rootRef), ...rest,
      chain: chain.map(row => [identity(String(row[0])), identity(String(row[1])), ...row.slice(2)]),
      clipContext: clipContext?.map(({ ref, ...clip }) => ({ ref: identity(ref), ...clip })) }));
  }
  round.geometryManifestSha256 = geometryHash.digest("hex");
  if (pipelineCase?.startsWith("continuous-") || formatCase || snapshotWaitCase)
    assert.equal(round.geometryManifestSha256, report.rounds[0].geometryManifestSha256, "Continuous geometry mismatch");
  adb("shell", "run-as", pkg, "rm", "-f", name); // Only this probe's validated generated sidecar.
}
console.log(JSON.stringify(report, null, 2));
