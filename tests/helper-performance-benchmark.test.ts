import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { collectHelperBenchmark, compareHelperBenchmarks, parseBenchmarkOptions, type CaptureOptions, type CliRunner } from "../scripts/helper-performance-benchmark";

const session = "11111111-1111-4111-8111-111111111111";
const options: CaptureOptions = { mode: "capture", cli: "/tmp/android-ui.cjs", out: "/tmp/unused", node: "node", session,
  serial: "device123", packageName: "com.example.app", apkSha256: "a".repeat(64), pageCheck: "collection-still-01", warmSamples: 5, timeoutMs: 60000 };
const geometry = { hierarchyRotation: 0, beforeScreenshot: { width: 1080, height: 2400, rotation: 0 },
  afterScreenshot: { width: 1080, height: 2400, rotation: 0 }, screenshotSize: { width: 1080, height: 2400 } };

function fixture(mutate?: (command: string, data: Record<string, unknown>, count: number) => void) {
  const calls: string[][] = [], expiresAt = new Date(Date.now() + 3600000).toISOString();
  let count = 0, snapshotId: string | null = null, latest: Record<string, unknown> | undefined;
  const runner: CliRunner = async args => {
    calls.push([...args]); const command = args[0]; let data: Record<string, unknown>;
    if (command === "attach") data = { id: session, active: true, busy: false, serial: options.serial, packageName: options.packageName,
      expiresAt, snapshotId, steps: latest ? [{ id: count, action: "capture_ui", status: "done", afterId: snapshotId,
        input: { sessionId: session, backend: "accessibility-helper" }, timings: latest.timings }] : [], token: "secret-token", message: "private-page-body" };
    else if (command === "capture") {
      count++; snapshotId = randomUUID();
      const duration = count === 1 ? 900 : 100 + count;
      data = latest = { snapshotId, stepId: count, source: "accessibility-helper", mode: "fast", nodeCount: 971, captureDurationMs: duration,
        timings: { version: 1, correlationId: randomUUID(), startedAt: new Date().toISOString(), durationMs: duration, status: "success",
          spans: [{ id: 1, parentId: null, phase: "observation", startOffsetMs: 0, durationMs: duration, status: "success", backend: "accessibility-helper", reason: "explicit" }],
          droppedSpans: 0, commandCount: 0, commandCounts: {}, observationCount: 1, observationCounts: { explicit: 1 } },
        message: "private-page-body", token: "secret-token" };
    } else if (command === "snapshot") data = { snapshotId, serial: options.serial, source: "accessibility-helper", captureMode: "fast",
      nodeCount: 971, geometry: structuredClone(geometry), screenshotAvailable: true, root: { text: "private-page-body" }, warning: null };
    else throw new Error("unexpected command");
    mutate?.(command, data, count);
    return { data, wallMs: command === "capture" ? count === 1 ? 1000 : 120 + count : 5 };
  };
  return { runner, calls };
}

test("Helper benchmark separates first sample and uses only live attach/capture/snapshot without private text", async () => {
  const f = fixture(), summary = await collectHelperBenchmark(options, f.runner);
  assert.equal(summary.status, "completed"); assert.equal(summary.samples.length, 6);
  assert.deepEqual(summary.samples.map(s => s.phase), ["first", "warm", "warm", "warm", "warm", "warm"]);
  assert.deepEqual(f.calls.map(c => c[0]), Array.from({ length: 6 }, () => ["attach", "capture", "snapshot", "attach"]).flat());
  assert.ok(f.calls.filter(c => c[0] === "capture").every(c => c.join(" ") === `capture --session ${session} --mode fast --backend accessibility-helper`));
  assert.equal(summary.unavailable.pngBytes, "unavailable-in-public-cli");
  assert.doesNotMatch(JSON.stringify(summary), /private-page-body|secret-token/);
  const comparison = compareHelperBenchmarks(summary, summary, true);
  assert.equal(comparison.warm.captureWallMs.baseline.median, 124);
  assert.equal(comparison.warm.captureWallMs.baseline.count, 5);
  assert.equal(comparison.warm.captureWallMs.percentChange, 0);
  assert.match(comparison.limitations.join(" "), /人工/);
});

test("grant identity/busy/expiry failures stop before any capture", async () => {
  for (const change of [
    { active: false }, { busy: true }, { id: randomUUID() }, { serial: "other" }, { packageName: "com.other.app" }, { expiresAt: "2000-01-01T00:00:00.000Z" },
  ]) {
    const f = fixture((command, data) => { if (command === "attach") Object.assign(data, change); });
    const summary = await collectHelperBenchmark(options, f.runner);
    assert.equal(summary.status, "failed"); assert.deepEqual(f.calls.map(c => c[0]), ["attach"]);
  }
});

test("wrong backend, incomplete capture, mismatched metadata and changed page stop without retry", async () => {
  for (const change of [
    (c: string, d: Record<string, unknown>) => { if (c === "capture") d.source = "uiautomator"; },
    (c: string, d: Record<string, unknown>) => { if (c === "capture") d.recordingWarning = "private-page-body"; },
    (c: string, d: Record<string, unknown>) => { if (c === "capture") d.timings = {}; },
    (c: string, d: Record<string, unknown>) => { if (c === "snapshot") d.snapshotId = randomUUID(); },
    (c: string, d: Record<string, unknown>) => { if (c === "snapshot") d.screenshotAvailable = false; },
    (c: string, d: Record<string, unknown>) => { if (c === "snapshot") d.geometry = {}; },
    (c: string, d: Record<string, unknown>) => { if (c === "snapshot") d.nodeCount = 970; },
    (c: string, d: Record<string, unknown>) => { if (c === "attach" && d.snapshotId) d.active = false; },
    (c: string, d: Record<string, unknown>) => { if (c === "attach" && d.snapshotId) d.snapshotId = randomUUID(); },
  ]) {
    const f = fixture(change), summary = await collectHelperBenchmark(options, f.runner);
    assert.equal(summary.status, "failed"); assert.equal(f.calls.filter(c => c[0] === "capture").length, 1);
    assert.doesNotMatch(JSON.stringify(summary), /private-page-body/);
  }
  for (const field of ["geometry", "nodeCount"]) {
    const f = fixture((command, data, count) => {
      if (count !== 2) return;
      if (field === "nodeCount" && ["capture", "snapshot"].includes(command)) data.nodeCount = 972;
      if (field === "geometry" && command === "snapshot") data.geometry = { hierarchyRotation: 0,
        beforeScreenshot: { width: 1080, height: 2300, rotation: 0 }, afterScreenshot: { width: 1080, height: 2300, rotation: 0 }, screenshotSize: { width: 1080, height: 2300 } };
    });
    const summary = await collectHelperBenchmark(options, f.runner);
    assert.equal(summary.status, "failed"); assert.equal(summary.samples.length, 1);
    assert.equal(f.calls.filter(c => c[0] === "capture").length, 2);
  }
});

test("concurrent session activity and reused snapshot IDs are rejected", async () => {
  let oldId: unknown;
  const f = fixture((command, data, count) => {
    if (command === "capture") { if (count === 1) oldId = data.snapshotId; else data.snapshotId = oldId; }
  });
  assert.equal((await collectHelperBenchmark(options, f.runner)).status, "failed");
  const concurrent = fixture((command, data) => {
    if (command === "attach" && data.snapshotId) (data.steps as unknown[]).push({ id: 100, action: "tap_node", status: "done" });
  });
  assert.equal((await collectHelperBenchmark(options, concurrent.runner)).status, "failed");
  assert.equal(concurrent.calls.filter(c => c[0] === "capture").length, 1);
});

test("comparison requires external same-page confirmation, compatible identities/geometry/count/marker and successful runs", async () => {
  const summary = await collectHelperBenchmark(options, fixture().runner);
  assert.throws(() => compareHelperBenchmarks(summary, summary, false), /same_page_confirmation_required/);
  for (const edit of [
    (s: typeof summary) => { s.device.serial = "other"; },
    (s: typeof summary) => { s.device.packageName = "com.other.app"; },
    (s: typeof summary) => { s.pageCheck = "other-page"; },
    (s: typeof summary) => { s.status = "failed"; },
    (s: typeof summary) => { s.samples[0].snapshot.nodeCount++; },
    (s: typeof summary) => { s.samples[0].snapshot.geometry.screenshotSize.width++; },
    (s: typeof summary) => { s.samples.pop(); },
  ]) { const changed = structuredClone(summary); edit(changed); assert.throws(() => compareHelperBenchmarks(summary, changed, true)); }
  const candidate = structuredClone(summary); candidate.apkSha256 = "b".repeat(64); candidate.sessionId = randomUUID();
  assert.doesNotThrow(() => compareHelperBenchmarks(summary, candidate, true));
});

test("options default to five warm samples; bounded count; comparison cannot accidentally capture", () => {
  const args = ["--cli", options.cli, "--out-dir", options.out, "--session", session, "--serial", options.serial,
    "--package", options.packageName, "--apk-sha256", options.apkSha256, "--page-check", options.pageCheck];
  const parsed = parseBenchmarkOptions(args); assert.notEqual(parsed, "help"); assert.equal((parsed as CaptureOptions).warmSamples, 5);
  for (const count of ["1", "20"]) assert.equal((parseBenchmarkOptions([...args, "--warm-samples", count]) as CaptureOptions).warmSamples, Number(count));
  for (const count of ["0", "21", "1.5", "NaN"]) assert.throws(() => parseBenchmarkOptions([...args, "--warm-samples", count]));
  assert.throws(() => parseBenchmarkOptions([...args, "--backend", "uiautomator"]));
  assert.throws(() => parseBenchmarkOptions([...args, "--page-check", "duplicate"]));
  assert.throws(() => parseBenchmarkOptions(["--baseline", "/a", "--candidate", "/b", "--out-dir", "/out"]));
  assert.throws(() => parseBenchmarkOptions([...args, "--baseline", "/a", "--candidate", "/b", "--confirm-same-page"]));
});

test("public CLI process and saved summaries stay read-only, redact responses, and stop on command failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "helper-benchmark-offline-"));
  try {
    const fake = join(dir, "cli.cjs"), log = join(dir, "calls.json"), state = join(dir, "state.json");
    writeFileSync(fake, `const fs=require('fs'),crypto=require('crypto');
const log=${JSON.stringify(log)},statePath=${JSON.stringify(state)},command=process.argv[2];
const calls=fs.existsSync(log)?JSON.parse(fs.readFileSync(log)):[];calls.push(command);fs.writeFileSync(log,JSON.stringify(calls));
let state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath)):{count:0,id:null,expiresAt:new Date(Date.now()+3600000).toISOString()};
if(process.env.HELPER_BENCHMARK_TEST_FAIL==='1'&&command==='capture'){process.stderr.write('private-page-body secret-token');process.exit(1)}
let data;
if(command==='capture'){
state.count++;state.id=crypto.randomUUID();state.timings={version:1,correlationId:crypto.randomUUID(),startedAt:new Date().toISOString(),durationMs:10,status:'success',spans:[{id:1,parentId:null,phase:'observation',startOffsetMs:0,durationMs:10,status:'success',backend:'accessibility-helper',reason:'explicit'}],droppedSpans:0,commandCount:0,commandCounts:{},observationCount:1,observationCounts:{explicit:1}};
data={snapshotId:state.id,stepId:state.count,source:'accessibility-helper',mode:'fast',nodeCount:971,captureDurationMs:10,timings:state.timings};
}else if(command==='snapshot'){data={snapshotId:state.id,serial:'device123',source:'accessibility-helper',captureMode:'fast',nodeCount:971,screenshotAvailable:true,geometry:${JSON.stringify(geometry)},root:{text:'private-page-body'}}}
else if(command==='attach'){data={id:${JSON.stringify(session)},active:true,busy:false,serial:'device123',packageName:'com.example.app',expiresAt:state.expiresAt,snapshotId:state.id,steps:state.count?[{id:state.count,action:'capture_ui',status:'done',afterId:state.id,input:{sessionId:${JSON.stringify(session)},backend:'accessibility-helper'},timings:state.timings}]:[]}}
else process.exit(9);
fs.writeFileSync(statePath,JSON.stringify(state));process.stdout.write(JSON.stringify({...data,token:'secret-token',message:'private-page-body'}));`);
    const script = fileURLToPath(new URL("../scripts/helper-performance-benchmark.ts", import.meta.url));
    const args = [script, "--cli", fake, "--node", process.execPath, "--session", session, "--serial", options.serial, "--package", options.packageName,
      "--apk-sha256", options.apkSha256, "--page-check", options.pageCheck, "--warm-samples", "1"];
    const success = spawnSync(process.execPath, [...args, "--out-dir", join(dir, "success")], { encoding: "utf8" });
    assert.equal(success.status, 0, success.stderr);
    const raw = readFileSync(join(dir, "success/summary.json"), "utf8"); assert.doesNotMatch(raw, /private-page-body|secret-token/);
    assert.equal(JSON.parse(raw).samples.length, 2);
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), ["attach", "capture", "snapshot", "attach", "attach", "capture", "snapshot", "attach"]);
    const compared = spawnSync(process.execPath, [script, "--baseline", join(dir, "success/summary.json"), "--candidate", join(dir, "success/summary.json"),
      "--confirm-same-page", "--out-dir", join(dir, "comparison")], { encoding: "utf8" });
    assert.equal(compared.status, 0, compared.stderr);
    assert.doesNotMatch(readFileSync(join(dir, "comparison/comparison.json"), "utf8"), /private-page-body|secret-token/);
    const failed = spawnSync(process.execPath, [...args, "--out-dir", join(dir, "failure")], { encoding: "utf8", env: { ...process.env, HELPER_BENCHMARK_TEST_FAIL: "1" } });
    assert.equal(failed.status, 1); assert.doesNotMatch(failed.stdout + failed.stderr, /private-page-body|secret-token/);
    const failureRaw = readFileSync(join(dir, "failure/summary.json"), "utf8"); assert.doesNotMatch(failureRaw, /private-page-body|secret-token/);
    assert.equal(JSON.parse(failureRaw).failure.code, "cli_failed");
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")).slice(8), ["attach", "capture"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
