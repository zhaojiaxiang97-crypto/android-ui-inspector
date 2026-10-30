// Run against the SDK sample; no business screenshots are saved.
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { parseCaptureGeometryFile, parseCaptureGeometryEvidence } from "../../../electron/capture/layer-images";
import { parseCapturedViewLayers } from "../../../electron/capture/view-protocol";
import { rectangularCapturePlacement } from "../../../shared/capture-transform";
import { deviceLoadSampler, parseProcessLoad } from "./sdk-device-load";
import { startSchedulerProbe } from "./sdk-scheduler-probe";
import { startThreadSchedulerProbe } from "./sdk-thread-scheduler-probe";
import { parseMethodProfile } from "./sdk-method-profile";

const serial = process.argv[2];
if (!serial || !/^[\w.:-]+$/.test(serial)) throw new Error("Usage: bun scripts/diagnostics/sdk/sdk-full-geometry-probe.ts SERIAL");
const pkg = "com.androiduiinspector.sample";
const rectangle = process.argv[3] === "--rectangle";
const supported = process.argv.includes("--supported");
const idleComparison = process.argv.includes("--idle-comparison");
const threadSchedulerEnabled = process.argv.includes("--thread-scheduler");
const methodProfileEnabled = process.argv.includes("--method-profile");
assert.ok(!methodProfileEnabled || (idleComparison && !threadSchedulerEnabled), "--method-profile requires idle comparison without thread sampler");
assert.ok(!threadSchedulerEnabled || idleComparison, "--thread-scheduler requires --idle-comparison");
assert.ok(!idleComparison || !process.argv.includes("--lifecycle-comparison"), "Choose one comparison");
assert.ok(!process.argv.includes("--idle-first") || idleComparison, "--idle-first requires --idle-comparison");
assert.ok(!idleComparison || !process.argv.includes("--restart-first"), "Use --idle-first for idle comparisons");
const lifecycleComparison = process.argv.includes("--lifecycle-comparison") || idleComparison;
assert.ok(!lifecycleComparison || (supported && !rectangle && !process.argv.includes("--scheduler") && !process.argv.includes("--device-load") && !process.argv.includes("--serialization-fixture")),
  "Lifecycle comparison requires --supported without rectangle/external samplers");
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 70_000, maxBuffer: 65_000_000, stdio: ["ignore", "pipe", "pipe"] });
const execAsync = promisify(execFile);
const asyncAdb = async (...args: string[]) => (await execAsync("adb", ["-s", serial, ...args], { timeout: 70_000, maxBuffer: 65_000_000, encoding: "buffer" })).stdout;
const schedulerEnabled = process.argv.includes("--scheduler");
const schedulerPid = schedulerEnabled ? adb("shell", "pidof", pkg).toString().trim() : "";
const policies = schedulerEnabled || threadSchedulerEnabled ? adb("shell", "ls", "/sys/devices/system/cpu/cpufreq").toString().trim().split(/\s+/).filter(name => /^policy\d{1,3}$/.test(name)) : [];
const schedulerAdb = async (...args: string[]) => (await execAsync("adb", ["-s", serial, ...args], { timeout: 1500, maxBuffer: 2_000_000, encoding: "buffer" })).stdout;
const samples: Record<string, unknown>[] = [];
const loadSample = process.argv.includes("--device-load")
  ? deviceLoadSampler(adb, adb("shell", "pidof", pkg).toString().trim()) : undefined;
let refs: string[] = [];
const stableImages = new Map<string, string>();
let stablePageDigest: string | undefined;
const processGroups = new Map<string, string>();
const restartedProcesses = new Set<string>();
const lifecycleOrder = idleComparison
  ? (process.argv.includes("--idle-first") ? ["idle40", "immediate", "immediate", "idle40"] : ["immediate", "idle40", "idle40", "immediate"])
  : (process.argv.includes("--restart-first") ? ["restart", "continuous"] : ["continuous", "restart"]);
const rounds = idleComparison ? lifecycleOrder.map((mode, index) => ({ evidence: true, mode, index })) : lifecycleComparison
  ? lifecycleOrder.flatMap(mode => Array.from({ length: 6 }, (_, index) => ({ evidence: true, mode, index })))
  : (rectangle ? [true] : [false, true, true, false, false, true]).map((evidence, index) => ({ evidence, mode: "existing", index }));
// Warm the same render/encode path first; ABBA ordering limits cold-start/order bias.
if (!rectangle && !lifecycleComparison) adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "capture-visible", "--arg", randomBytes(8).toString("hex"));
for (const { evidence, mode, index } of rounds) {
  // Sample only. Startup is outside the provider timer; neither group has a preflight capture.
  let startupMs: number | undefined;
  let idleMs: number | undefined;
  let launchCompletedAt: number | undefined;
  let osProcessIdentity: string | undefined;
  let readOsIdentity: (() => string) | undefined;
  if (lifecycleComparison && (index === 0 || mode === "restart" || idleComparison)) {
    const start = performance.now();
    const launch = adb("shell", "am", "start", "-S", "-W", "-n", `${pkg}/.MainActivity`, "--es", "mode", "stress-rectangle").toString();
    assert.match(launch, /Status: ok/);
    startupMs = Math.round(performance.now() - start);
    launchCompletedAt = performance.now();
    stableImages.clear();
    if (idleComparison) {
      readOsIdentity = () => {
        const pid = adb("shell", "pidof", pkg).toString().trim();
        assert.match(pid, /^\d+$/);
        const stat = adb("exec-out", "run-as", pkg, "cat", `/proc/${pid}/stat`).toString().trim();
        return `${pid}:${parseProcessLoad(stat, pid).startTicks}`;
      };
      osProcessIdentity = readOsIdentity();
      const idleStarted = performance.now();
      if (mode === "idle40") {
        console.error(`Waiting 40s in fresh sample process, round ${index + 1}/4`);
        await wait(40_000); // No SDK call, external sampler, GC or power-setting changes.
      }
      idleMs = Math.round(performance.now() - idleStarted);
      if (mode === "idle40") assert.ok(idleMs >= 40_000 && idleMs <= 60_000, "Idle timer overshot its comparison window");
      assert.equal(readOsIdentity(), osProcessIdentity, "Process changed during idle interval");
    }
  }
  const nonce = randomBytes(8).toString("hex");
  const tracePath = `/data/local/tmp/inspector-hotspot-${nonce}.trace`;
  let methodProfile: ReturnType<typeof parseMethodProfile> | undefined;
  let profileStartMs: number | undefined;
  if (methodProfileEnabled) {
    const began = performance.now();
    try {
      adb("shell", "am", "profile", "start", "--clock-type", "dual", "--sampling", "2000", osProcessIdentity!.split(":")[0]!, tracePath);
    } catch (error) {
      adb("shell", "rm", "-f", tracePath);
      throw error;
    }
    profileStartMs = Math.round(performance.now() - began);
  }
  const deviceBefore = loadSample?.();
  const samplerStarted = performance.now();
  const scheduler = threadSchedulerEnabled
    ? await startThreadSchedulerProbe(schedulerAdb, osProcessIdentity!.split(":")[0]!, policies)
    : schedulerEnabled ? await startSchedulerProbe(schedulerAdb, schedulerPid, policies) : undefined;
  const schedulerBaselineMs = scheduler ? Math.round(performance.now() - samplerStarted) : undefined;
  const started = performance.now();
  const sinceLaunchCompleteMs = launchCompletedAt === undefined ? undefined : Math.round(started - launchCompletedAt);
  const host: Record<string, number> = {};
  let stageStarted = started;
  const mark = (name: string) => { const now = performance.now(); host[name] = Math.round(now - stageStarted); stageStarted = now; };
  const callArgs = ["shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "capture-visible", "--arg", nonce,
    ...(evidence ? ["--extra", "geometryFile:b:true"] : [])];
  let reply: string;
  let schedulerReport: unknown;
  try { reply = (scheduler ? await asyncAdb(...callArgs) : adb(...callArgs)).toString(); }
  finally {
    mark("providerCallMs");
    if (scheduler) { schedulerReport = await scheduler.stop(); mark("schedulerStopMs"); }
    if (methodProfileEnabled) {
      try {
        adb("shell", "am", "profile", "stop", osProcessIdentity!.split(":")[0]!);
        mark("profileStopMs");
        methodProfile = parseMethodProfile(adb("exec-out", "cat", tracePath), osProcessIdentity!.split(":")[0]!);
        mark("profilePullParseMs");
      } finally { adb("shell", "rm", "-f", tracePath); mark("profileCleanupMs"); }
    }
  }
  const field = (key: string) => new RegExp(`\\b${key}=([^,}\\]]+)`).exec(reply)?.[1];
  assert.equal(field("result"), "ok", reply);
  if (idleComparison) {
    assert.ok(readOsIdentity);
    assert.equal(readOsIdentity(), osProcessIdentity, "Process changed during capture");
    mark("processIdentityMs");
  }
  if (threadSchedulerEnabled) {
    const readings = (schedulerReport as { samples: Array<{ process?: { startTicks: number }; threads?: Array<{ tid: string; role: string; processor: number }> }> }).samples;
    const workers = new Set<string>();
    let mainSeen = false;
    for (const row of readings) {
      if (row.process) assert.equal(String(row.process.startTicks), osProcessIdentity!.split(":")[1], "Sampler process changed");
      for (const thread of row.threads ?? []) {
        if (thread.role === "main") mainSeen = true;
        else workers.add(thread.tid);
      }
    }
    assert.ok(mainSeen && workers.size === 2, "Need main and both real SDK encoder threads, not a global CPU reading");
    mark("threadValidationMs");
  }
  if (lifecycleComparison) {
    const instance = field("processInstance");
    assert.ok(instance, "Missing process identity");
    if (mode === "continuous") {
      if (index === 0) { assert.ok(!restartedProcesses.has(instance)); processGroups.set(mode, instance); }
      else assert.equal(instance, processGroups.get(mode), "Continuous group process changed");
      assert.ok(field("rootRef"), "Missing root identity");
      if (index === 0) processGroups.set("continuous-root", field("rootRef")!);
      else assert.equal(field("rootRef"), processGroups.get("continuous-root"), "Continuous group window changed");
    } else {
      assert.ok(!restartedProcesses.has(instance) && instance !== processGroups.get("continuous"), "Restart did not produce a fresh process");
      restartedProcesses.add(instance);
    }
  }
  const images = adb("exec-out", "run-as", pkg, "cat", "no_backup/inspector-visible-layers.bin");
  assert.ok(images.length <= 64_000_000, "Image file budget exceeded");
  mark("imagePullMs");
  assert.equal(createHash("sha256").update(images).digest("hex"), field("sha256"));
  mark("imageHashMs");
  const layers = parseCapturedViewLayers(images);
  mark("imageParseMs");
  let pageDigest: string | undefined;
  if (lifecycleComparison) {
    assert.equal(layers.length, 407);
    assert.equal(Number(field("count")), 407);
    assert.equal(Number(field("selected")), 407);
    assert.equal(Number(field("empty")), 0);
    assert.equal(images.subarray(0, 8).toString("hex"), nonce);
    const hash = createHash("sha256");
    for (const layer of layers) {
      assert.ok(layer.imageDataUrl);
      hash.update(JSON.stringify([layer.name.replace(/@[0-9a-f]+$/i, ""), layer.x, layer.y, layer.width, layer.height,
        createHash("sha256").update(layer.imageDataUrl).digest("hex")]));
    }
    pageDigest = hash.digest("hex");
    stablePageDigest ??= pageDigest;
    assert.equal(pageDigest, stablePageDigest, "Cross-process image bytes/order/geometry changed");
  }
  if (supported) {
    const first = stableImages.size === 0;
    if (!first) assert.equal(layers.length, stableImages.size);
    for (const layer of layers) {
      const digest = createHash("sha256").update(layer.imageDataUrl!).digest("hex");
      if (!first) assert.equal(digest, stableImages.get(layer.name), `Static sample pixels changed: ${layer.name}`);
      else stableImages.set(layer.name, digest);
    }
  }
  refs = layers.slice(0, 12).map(layer => layer.name);
  mark("pixelStabilityCheckMs");
  let metadataBytes = 0;
  if (evidence) {
    const bytes = adb("exec-out", "run-as", pkg, "cat", `no_backup/inspector-geometry-${nonce}.json`);
    mark("geometryPullMs");
    assert.equal(bytes.length, Number(field("geometryBytes")));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), field("geometrySha256"));
    const records = parseCaptureGeometryFile(bytes, nonce, field("processInstance")!, field("rootRef")!, layers);
    assert(records.size <= layers.length); // Unsupported parent/outline contexts keep the explicit legacy path.
    if (supported) assert(records.size >= 400, "Use stress-rectangle: real supported geometry must be measured");
    if (lifecycleComparison) assert.equal(records.size, 405);
    if (rectangle) {
      const parent = layers.find(layer => layer.name.includes("DecoratedParent@"));
      assert(parent, "Rectangle fixture parent missing");
      const evidence = records.get(parent.name);
      assert(evidence, "Rectangle fixture must exercise the qualified path");
      const placement = rectangularCapturePlacement(evidence, parent.width, parent.height);
      assert(placement && Math.abs(placement.opacity - 0.5) < 0.001);
      assert(Math.abs(placement.screen.width - parent.width * 0.8) < 0.1);
    }
    metadataBytes = bytes.length;
    mark("geometryValidationMs");
    if (process.argv.includes("--serialization-fixture")) {
      adb("shell", "run-as", pkg, "cp", `no_backup/inspector-geometry-${nonce}.json`, "no_backup/inspector-geometry-fixture.json");
      mark("geometryFixtureMs"); // Sample-only fixed input; excluded from serialization benchmarks.
    }
    adb("shell", "run-as", pkg, "rm", "-f", `no_backup/inspector-geometry-${nonce}.json`);
    mark("geometryCleanupMs");
  }
  const timing = Object.fromEntries(["uiQueueMs", "geometryMs", "drawMs", "verifyMs", "geometryWriteMs", "snapshotPrepareMs", "snapshotInvokeMs"].map(key => [key, Number(field(key))])) as Record<"uiQueueMs" | "geometryMs" | "drawMs" | "verifyMs" | "geometryWriteMs" | "snapshotPrepareMs" | "snapshotInvokeMs", number>;
  assert(Object.values(timing).every(value => Number.isSafeInteger(value) && value >= 0));
  const maxima: Record<string, number> = {};
  for (const key of ["uiTaskMaxMs", "snapshotInvokeMaxMs"]) {
    if (field(key) === undefined) continue; // Old SDKs do not expose maxima; never invent zero.
    const value = Number(field(key));
    assert(Number.isSafeInteger(value) && value >= 0 && value <= 65_000);
    maxima[key] = value;
  }
  const cpu: Record<string, number> = {};
  for (const key of ["geometryCpuMs", "drawCpuMs", "verifyCpuMs", "encodeCpuMs", "geometryWriteCpuMs"]) {
    if (process.argv.includes("--cpu-timing")) assert.notEqual(field(key), undefined, `CPU counter unavailable: ${key}`);
    if (field(key) === undefined) continue;
    const value = Number(field(key));
    const limit = key === "encodeCpuMs" || key === "geometryWriteCpuMs" ? 130_000 : 65_000;
    assert(Number.isSafeInteger(value) && value >= 0 && value <= limit);
    cpu[key] = value;
  }
  const geometryStages: Record<string, number> = {};
  for (const key of ["geometryJsonMs", "geometryUtf8Ms", "geometryDiskMs", "geometryJsonCpuMs", "geometryUtf8CpuMs", "geometryDiskCpuMs"]) {
    if (process.argv.includes("--geometry-timing")) assert.notEqual(field(key), undefined, `Geometry counter unavailable: ${key}`);
    if (field(key) === undefined) continue;
    const value = Number(field(key));
    assert(Number.isSafeInteger(value) && value >= 0 && value <= (key.startsWith("geometryDisk") ? 65_000 : 130_000));
    geometryStages[key] = value;
  }
  // Includes probe verification/cleanup, not desktop first-paint or renderer latency.
  const wallMs = Math.round(performance.now() - started);
  const deviceAfter = loadSample?.(); // Diagnostic overhead stays outside wallMs; boundary samples are not peak measurements.
  samples.push({ evidence, wallMs, ...host, durationMs: Number(field("durationMs")), renderMs: Number(field("renderMs")), encodeMs: Number(field("encodeMs")), ...timing, ...maxima, ...cpu, ...geometryStages, count: layers.length, metadataBytes,
    ...(lifecycleComparison ? { mode, round: index + 1, processInstance: field("processInstance"), rootRef: field("rootRef"), startupMs, pageDigest } : {}),
    ...(idleComparison ? { idleMs, sinceLaunchCompleteMs, osProcessIdentity } : {}),
    ...(threadSchedulerEnabled ? { schedulerBaselineMs, threadScheduler: schedulerReport } : {}),
    ...(methodProfileEnabled ? { profileStartMs, profileIntervalUs: 2000, methodProfile } : {}),
    ...(schedulerEnabled ? { scheduler: schedulerReport } : {}),
    ...(loadSample ? { deviceBefore, deviceAfter } : {}) });
  if (lifecycleComparison) console.error(`Validated ${mode} ${index + 1}/${idleComparison ? 4 : 6}: SDK ${field("durationMs")}ms, provider ${host.providerCallMs}ms`);
}
if (rectangle) {
  console.log(JSON.stringify({ samples, rectangle: true }, null, 2));
  process.exit(0);
}
assert.equal(refs.length, 12, "Use stress-large sample mode");
const nonce = randomBytes(8).toString("hex");
assert(refs.every(ref => /^[\w.$]+@[0-9a-f]+$/i.test(ref)));
const reply = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "capture-refs", "--arg", `'${refs.join(";")}'`, "--extra", `nonce:s:${nonce}`, "--extra", "geometryFile:b:true").toString();
const field = (key: string) => new RegExp(`\\b${key}=([^,}\\]]+)`).exec(reply)?.[1];
assert.equal(field("result"), "ok", reply);
const refImages = adb("exec-out", "run-as", pkg, "cat", "no_backup/inspector-ref-layers.bin");
assert.equal(createHash("sha256").update(refImages).digest("hex"), field("sha256"));
const layers = parseCapturedViewLayers(refImages);
const bytes = adb("exec-out", "run-as", pkg, "cat", `no_backup/inspector-geometry-${nonce}.json`);
assert.equal(createHash("sha256").update(bytes).digest("hex"), field("geometrySha256"));
assert.equal(parseCaptureGeometryFile(bytes, nonce, field("processInstance")!, field("rootRef")!, layers).size, layers.length);
adb("shell", "run-as", pkg, "rm", "-f", `no_backup/inspector-geometry-${nonce}.json`);
const singleNonce = randomBytes(8).toString("hex");
const singleRef = layers.find(layer => layer.name.includes("TextView@"))?.name;
assert.ok(singleRef, "Need a supported text View for single-control geometry regression");
const singleReply = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "capture-refs", "--arg", singleRef, "--extra", `nonce:s:${singleNonce}`, "--extra", "geometryEvidence:b:true").toString();
const singleField = (key: string) => new RegExp(`\\b${key}=([^,}\\]]+)`).exec(singleReply)?.[1];
assert.equal(singleField("result"), "ok", singleReply);
const singleImages = adb("exec-out", "run-as", pkg, "cat", "no_backup/inspector-ref-layers.bin");
assert.equal(createHash("sha256").update(singleImages).digest("hex"), singleField("sha256"));
const singleLayers = parseCapturedViewLayers(singleImages);
assert.equal(singleLayers.length, 1);
assert.equal(singleLayers[0].name, singleRef);
assert.equal(singleLayers[0].imageDataUrl, layers.find(layer => layer.name === singleRef)?.imageDataUrl);
assert.equal(singleImages.subarray(0, 8).toString("hex"), singleNonce);
assert.equal(parseCaptureGeometryEvidence(singleField("geometryEvidence"), [singleRef], singleField("rootRef")!).size, 1);
console.log(JSON.stringify({ samples, refBatch: layers.length, singleRef: singleLayers.length, stableImages: stableImages.size,
  ...(lifecycleComparison ? { lifecycleOrder, restartedProcesses: restartedProcesses.size, pageDigest: stablePageDigest } : {}) }, null, 2));
