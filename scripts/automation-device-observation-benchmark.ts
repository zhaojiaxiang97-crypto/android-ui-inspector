#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";
import { debugTimingsSchema, type DebugTimings } from "../shared/debug-timing";
import { assessCaptureGeometry } from "../shared/screen-coordinates";

type Backend = "uiautomator" | "accessibility-helper";
type Options = { cli: string; session: string; out: string; node: string; warmSamples: number; timeoutMs: number;
  first: Backend; snapshotFile?: string; serial?: string; packageName?: string };
type Identity = { id: string; serial: string; packageName: string; expiresAt: string };
type Failure = { code: string; stage: string; exitCode?: number | null; signal?: string | null };
type Sample = { index: number; phase: "first" | "warm"; pair: number; backend: Backend; startedAt: string; finishedAt?: string;
  status: "running" | "ok" | "failed"; wallMs: number | null; metadataWallMs: number; captureDurationMs: number | null;
  timings: DebugTimings | null; snapshot: { id: string; source: Backend; nodeCount: number; geometry: unknown;
    windowId: null; helperServiceInstanceId: null; identityEvidence: "unavailable-in-public-cli" } | null;
  stepId: number | null; failure?: Failure };
type Json = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const backends: Backend[] = ["uiautomator", "accessibility-helper"];
const record = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const round = (v: number) => Math.round(v * 1000) / 1000;
class BenchmarkFailure extends Error {
  constructor(readonly detail: Failure, readonly data?: Json) { super(`${detail.stage}: ${detail.code}`); }
}
function fail(code: string, stage: string): never { throw new BenchmarkFailure({ code, stage }); }

const help = `只读观察性能对照（通过已构建 CLI 与桌面现有授权）

用法：
  bun scripts/automation-device-observation-benchmark.ts --cli /绝对路径/dist-electron/cli.cjs --session UUID --out-dir /绝对路径/新的结果目录

必需：--cli PATH  已构建 CLI 文件；--session UUID  已授权会话；--out-dir DIR  尚不存在的结果目录
可选：--node PATH  Node 可执行文件，默认 node；--snapshot-file PATH  CLI 共享位置
      --warm-samples N  每个后端热样本数，10–100，默认 10
      --first uiautomator|accessibility-helper  每对先采集的后端，默认 uiautomator
      --timeout-ms N  单次 CLI 上限，1000–140000，默认 60000
      --serial SERIAL --package APP  额外核对已授权设备和 App
      --self-test  只运行本地假 CLI 测试，不连接桌面或手机
      -h / --help

每个后端先记录一次首样 first，再交替采集至少 10 个热样本。会话可能已有观察，不重启或清空缓存，不代表设备冷启动。
capture 的墙钟计时包含 CLI 启动和产品留证；attach/snapshot 元数据查询计时单列，不计入 capture。
输出 samples.jsonl 和 summary.json；保存原始数值计时，不保存页面文本、截图、令牌或原始 CLI 输出。
当前公共 CLI 未提供窗口 ID / Helper 服务实例 ID，结果明确记为 unavailable，不能据此声称跨样本同窗。
中位数、最大值按成功热样本计算；至少 30 个成功热样本才给 P95。不同后端语义树不保证节点数相等。
异常、会话变更、忙碌、几何变化或取消立即停止；已完成和失败样本保留，不重试、不切源补样。
脚本只调用 attach、capture、snapshot，不安装、不配对、不授权、不发送点击或滑动。
`;

function options(argv: string[]): Options | "help" | "self-test" {
  const parsed = parseArgs({ args: argv, strict: true, allowPositionals: false, tokens: true, options: {
    cli: { type: "string" }, session: { type: "string" }, "out-dir": { type: "string" }, node: { type: "string" },
    "warm-samples": { type: "string" }, first: { type: "string" }, "timeout-ms": { type: "string" },
    "snapshot-file": { type: "string" }, serial: { type: "string" }, package: { type: "string" },
    help: { type: "boolean", short: "h" }, "self-test": { type: "boolean" },
  } });
  const seen = new Set<string>();
  for (const token of parsed.tokens) if (token.kind === "option") {
    if (seen.has(token.name)) throw Error(`--${token.name} 重复。`); seen.add(token.name);
  }
  if (parsed.values.help) return "help";
  if (parsed.values["self-test"]) {
    if (seen.size !== 1) throw Error("--self-test 不能与真实采集参数混用。");
    return "self-test";
  }
  const v = parsed.values;
  const path = (name: "cli" | "out-dir" | "snapshot-file", required: boolean) => {
    const value = v[name];
    if (!value && required) throw Error(`缺少 --${name}。`);
    if (value !== undefined && (!value.trim() || !isAbsolute(value))) throw Error(`--${name} 必须为非空绝对路径。`);
    return value;
  };
  const cli = path("cli", true)!, out = path("out-dir", true)!;
  if (!/\.(?:cjs|mjs|js)$/.test(cli)) throw Error("--cli 必须指向已构建的 .cjs/.mjs/.js 文件。");
  if (!v.session || !uuid.test(v.session)) throw Error("--session 必须为已有授权会话的 UUID。");
  const number = (name: "warm-samples" | "timeout-ms", fallback: number, min: number, max: number) => {
    const raw = v[name] ?? String(fallback);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max)
      throw Error(`--${name} 必须为 ${min}–${max} 的整数。`);
    return Number(raw);
  };
  const first = v.first ?? "uiautomator";
  if (!backends.includes(first as Backend)) throw Error("--first 只接受 uiautomator 或 accessibility-helper。");
  if (v.node !== undefined && !v.node.trim()) throw Error("--node 不能为空。");
  if (v.serial !== undefined && !/^[\w.-]+$/.test(v.serial)) throw Error("--serial 格式无效。");
  if (v.package !== undefined && !/^[\w]+(?:\.[\w]+)+$/.test(v.package)) throw Error("--package 格式无效。");
  return { cli, out, session: v.session.toLowerCase(), node: v.node ?? "node", first: first as Backend,
    warmSamples: number("warm-samples", 10, 10, 100), timeoutMs: number("timeout-ms", 60_000, 1000, 140_000),
    snapshotFile: path("snapshot-file", false), serial: v.serial, packageName: v.package };
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { count: n, medianMs: n ? round(n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null,
    maxMs: n ? round(sorted[n - 1]) : null,
    ...(n >= 30 ? { p95Ms: round(sorted[Math.ceil(n * 0.95) - 1]), p95Method: "nearest-rank" } : { p95Unavailable: "fewer-than-30-successful-samples" }) };
}

async function cli(o: Options, args: string[], signal: AbortSignal): Promise<{ data: Json; wallMs: number }> {
  signal.throwIfAborted();
  const started = performance.now(), stage = args[0];
  return new Promise((resolve, reject) => {
    const child = spawn(o.node, [o.cli, ...args, ...(o.snapshotFile ? ["--snapshot-file", o.snapshotFile] : [])],
      { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutSize = 0, stderrSize = 0, problem: string | undefined, kill: ReturnType<typeof setTimeout> | undefined;
    const stop = (code: string) => {
      if (problem) return; problem = code; child.kill("SIGINT");
      kill = setTimeout(() => child.kill("SIGKILL"), 3000); kill.unref();
    };
    const abort = () => stop("cancelled");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => stop("cli_timeout"), o.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdoutSize += chunk.length; if (stdoutSize > 8 * 1024 * 1024) stop("cli_output_limit"); else stdout.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderrSize += chunk.length; if (stderrSize > 512 * 1024) stop("cli_output_limit"); else stderr.push(chunk); });
    child.once("error", () => { problem = "cli_start_failed"; });
    child.once("close", (exitCode, exitSignal) => {
      clearTimeout(timer); if (kill) clearTimeout(kill); signal.removeEventListener("abort", abort);
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(exitCode === 0 ? stdout : stderr).toString("utf8")); } catch { /* Never persist raw output. */ }
      if (problem || exitCode !== 0 || !record(data) || data.isError === true) {
        reject(new BenchmarkFailure({ code: problem ?? (exitCode !== 0 ? "cli_failed" : "invalid_cli_json"), stage, exitCode, signal: exitSignal }, record(data) ? data : undefined)); return;
      }
      resolve({ data, wallMs: round(performance.now() - started) });
    });
  });
}

function identity(data: Json, o: Options, previous?: Identity): Identity {
  if (data.id !== o.session || data.active !== true || data.busy !== false || typeof data.serial !== "string" || typeof data.packageName !== "string"
    || typeof data.expiresAt !== "string" || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= Date.now()) fail("session_inactive_busy_or_mismatched", "attach");
  if (previous && (previous.serial !== data.serial || previous.packageName !== data.packageName)
    || o.serial !== undefined && o.serial !== data.serial || o.packageName !== undefined && o.packageName !== data.packageName) fail("device_or_package_changed", "attach");
  return { id: o.session, serial: data.serial, packageName: data.packageName, expiresAt: data.expiresAt };
}

async function run(o: Options, signal: AbortSignal) {
  if (!lstatSync(o.cli).isFile()) throw Error("--cli 必须是普通文件。");
  mkdirSync(o.out, { mode: 0o700 }); // Exclusive run directory; never overwrite an existing benchmark.
  const samples: Sample[] = [], startedAt = new Date().toISOString();
  const samplePath = join(o.out, "samples.jsonl"), summaryPath = join(o.out, "summary.json");
  const fd = openSync(samplePath, "wx", 0o600);
  let current: Identity | undefined, failure: Failure | undefined, status = "running", geometry: string | undefined;
  const append = (value: unknown) => { appendFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); };
  const save = () => {
    const summaries = Object.fromEntries(backends.map(backend => {
      const all = samples.filter(s => s.backend === backend), warm = all.filter(s => s.phase === "warm" && s.status === "ok");
      return [backend, { first: all.find(s => s.phase === "first") ?? null, warm: { planned: o.warmSamples, successful: warm.length,
        wall: stats(warm.flatMap(s => s.wallMs === null ? [] : [s.wallMs])), capture: stats(warm.flatMap(s => s.captureDurationMs === null ? [] : [s.captureDurationMs])),
        step: stats(warm.flatMap(s => s.timings ? [s.timings.durationMs] : [])) }, failed: all.filter(s => s.status === "failed").length }];
    }));
    const summary = { version: 1, status, startedAt, updatedAt: new Date().toISOString(), session: current ?? { id: o.session },
      configuration: { cli: o.cli, node: o.node, first: o.first, warmSamplesPerBackend: o.warmSamples, timeoutMs: o.timeoutMs },
      coldStartVerified: false, rawSamples: "samples.jsonl", identityFields: { windowId: "unavailable-in-public-cli", helperServiceInstanceId: "unavailable-in-public-cli" },
      notes: ["first 只是本次首样；会话可能已有观察，未重启桌面/App/Helper，未清空缓存，不代表设备冷启动。", "capture 墙钟包含 CLI 启动和产品留证；元数据查询不计入。", "当前 CLI 无窗口/服务实例摘要；只验证同授权设备/App及屏幕几何，不能证明跨样本同窗。",
        "两后端语义树可能不同；动态页面会影响样本，不自动补样或重试。", "本脚本不保存页面内容；桌面自身仍按现有机制保存采集证据。"],
      samples: { planned: 2 * (o.warmSamples + 1), completed: samples.filter(s => s.status === "ok").length, failed: samples.filter(s => s.status === "failed").length },
      backends: summaries, ...(failure ? { failure } : {}) };
    const temporary = join(o.out, ".summary.tmp");
    const handle = openSync(temporary, "wx", 0o600);
    try { writeFileSync(handle, `${JSON.stringify(summary, null, 2)}\n`); fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(temporary, summaryPath);
  };
  try {
    save(); current = identity((await cli(o, ["attach"], signal)).data, o); save();
    const order = [o.first, ...backends.filter(b => b !== o.first)];
    for (let pair = 0; pair <= o.warmSamples; pair++) for (const backend of order) {
      const sample: Sample = { index: samples.length + 1, pair, phase: pair === 0 ? "first" : "warm", backend,
        startedAt: new Date().toISOString(), status: "running", wallMs: null, metadataWallMs: 0, captureDurationMs: null, timings: null, snapshot: null, stepId: null };
      samples.push(sample); append({ event: "sample_started", ...sample }); save();
      let captureStarted: number | undefined;
      try {
        const before = await cli(o, ["attach"], signal); sample.metadataWallMs += before.wallMs; identity(before.data, o, current);
        captureStarted = performance.now();
        const capture = await cli(o, ["capture", "--session", o.session, "--mode", "fast", "--backend", backend], signal);
        sample.wallMs = capture.wallMs;
        const data = capture.data;
        if (data.source !== backend || data.mode !== "fast" || typeof data.snapshotId !== "string" || !uuid.test(data.snapshotId)
          || !Number.isSafeInteger(data.stepId) || !Number.isSafeInteger(data.nodeCount) || Number(data.nodeCount) < 1
          || !finite(data.captureDurationMs)) fail("capture_summary_mismatch", "capture");
        sample.stepId = Number(data.stepId); sample.captureDurationMs = data.captureDurationMs;
        const timing = debugTimingsSchema.safeParse(data.timings);
        if (!timing.success || timing.data.status !== "success") fail("complete_timings_unavailable", "capture");
        sample.timings = timing.data;
        if (data.recordingWarning || Array.isArray(data.recordingErrors) && data.recordingErrors.length) fail("capture_recording_failed", "capture");
        const snapshot = await cli(o, ["snapshot"], signal); sample.metadataWallMs += snapshot.wallMs;
        const s = snapshot.data;
        if (s.snapshotId !== data.snapshotId || s.serial !== current.serial || s.source !== backend || s.captureMode !== "fast"
          || s.nodeCount !== data.nodeCount || assessCaptureGeometry(s.geometry).status !== "checked") fail("snapshot_changed_or_invalid", "snapshot");
        // Only the public geometry shape is retained; root labels/text never enter an output file.
        const g = s.geometry as { hierarchyRotation: number; beforeScreenshot: Json; afterScreenshot: Json; screenshotSize: Json };
        const frame = (v: Json) => ({ width: v.width, height: v.height, ...(v.rotation === undefined ? {} : { rotation: v.rotation }) });
        const safeGeometry = { hierarchyRotation: g.hierarchyRotation, beforeScreenshot: frame(g.beforeScreenshot), afterScreenshot: frame(g.afterScreenshot), screenshotSize: frame(g.screenshotSize) };
        const signature = JSON.stringify(safeGeometry);
        if (geometry && geometry !== signature) fail("display_geometry_changed", "snapshot");
        geometry = signature;
        sample.snapshot = { id: data.snapshotId, source: backend, nodeCount: Number(data.nodeCount), geometry: safeGeometry,
          windowId: null, helperServiceInstanceId: null, identityEvidence: "unavailable-in-public-cli" };
        const after = await cli(o, ["attach"], signal); sample.metadataWallMs += after.wallMs; identity(after.data, o, current);
        const steps = Array.isArray(after.data.steps) ? after.data.steps : [];
        const step = steps.find(s => record(s) && s.id === data.stepId);
        if (after.data.snapshotId !== data.snapshotId || !record(step) || step.action !== "capture_ui" || step.status !== "done"
          || step.afterId !== data.snapshotId || !record(step.input) || step.input.backend !== backend || step.input.sessionId !== o.session
          || !record(step.timings) || step.timings.correlationId !== sample.timings.correlationId
          || steps.some(s => record(s) && typeof s.id === "number" && s.id > Number(data.stepId))) fail("concurrent_step_or_snapshot_changed", "attach");
        sample.status = "ok";
      } catch (error) {
        if (sample.wallMs === null && captureStarted !== undefined) sample.wallMs = round(performance.now() - captureStarted);
        sample.status = "failed";
        sample.failure = error instanceof BenchmarkFailure ? error.detail : { code: signal.aborted ? "cancelled" : "unexpected_failure", stage: "sample" };
        if (error instanceof BenchmarkFailure && error.data) {
          const timing = debugTimingsSchema.safeParse(error.data.timings); if (timing.success) sample.timings = timing.data;
          if (Number.isSafeInteger(error.data.stepId)) sample.stepId = Number(error.data.stepId);
        }
        throw error;
      } finally {
        sample.finishedAt = new Date().toISOString(); sample.metadataWallMs = round(sample.metadataWallMs);
        append({ event: "sample_finished", ...sample }); save();
      }
    }
    status = "completed";
  } catch (error) {
    status = signal.aborted ? "cancelled" : "failed";
    failure = error instanceof BenchmarkFailure ? error.detail : { code: signal.aborted ? "cancelled" : "unexpected_failure", stage: "benchmark" };
  } finally { try { save(); } finally { closeSync(fd); } }
  return { summaryPath, samplePath, status };
}

async function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "inspector-observation-benchmark-")), session = "22222222-2222-4222-8222-222222222222";
  try {
    assert.throws(() => options(["--cli", "/test.cjs", "--session", session, "--out-dir", "/tmp/out", "--warm-samples", "9"]));
    assert.throws(() => options(["--self-test", "--session", session]));
    assert.equal("p95Ms" in stats(Array.from({ length: 29 }, (_, i) => i + 1)), false);
    const thirty = stats(Array.from({ length: 30 }, (_, i) => i + 1));
    assert.ok("p95Ms" in thirty); assert.equal(thirty.p95Ms, 29);
    for (const scenario of ["success", "capture-failed", "session-changed", "snapshot-race", "wrong-session"]) {
      const fake = join(root, `${scenario}.cjs`), state = join(root, `${scenario}.state`), out = join(root, `${scenario}-out`);
      writeFileSync(fake, `const fs=require('fs'),crypto=require('crypto'); const p=${JSON.stringify(state)},scenario=${JSON.stringify(scenario)},session=${JSON.stringify(session)};
let s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{count:0,steps:[]};const args=process.argv.slice(2),cmd=args[0];let result;
const frame={width:10,height:20,rotation:0};const geometry={hierarchyRotation:0,beforeScreenshot:frame,afterScreenshot:frame,screenshotSize:{width:10,height:20}};
if(cmd==='attach')result={id:scenario==='session-changed'&&s.count?crypto.randomUUID():session,serial:'fixture-device',packageName:'fixture.app',active:true,busy:false,expiresAt:new Date(Date.now()+600000).toISOString(),steps:s.steps.slice(-20),snapshotId:s.snapshotId||null,privateText:'DO_NOT_SAVE_CANARY'};
else if(cmd==='capture') {if(args[args.indexOf('--session')+1]!==session)process.exit(9);const backend=args[args.indexOf('--backend')+1];s.count++;s.snapshotId=crypto.randomUUID();s.source=backend;const timings={version:1,correlationId:crypto.randomUUID(),startedAt:new Date().toISOString(),durationMs:2,status:'success',spans:[],droppedSpans:0,commandCount:0,commandCounts:{},observationCount:0,observationCounts:{}};s.steps.push({id:s.count,action:'capture_ui',status:'done',input:{sessionId:session,backend},afterId:s.snapshotId,timings});result={snapshotId:s.snapshotId,mode:'fast',source:backend,nodeCount:2,captureDurationMs:1,stepId:s.count,timings};if(scenario==='capture-failed'){fs.writeFileSync(p,JSON.stringify(s));process.stderr.write(JSON.stringify({...result,isError:true,message:'DO_NOT_SAVE_CANARY'}));process.exit(1)}}
else if(cmd==='snapshot')result={snapshotId:scenario==='snapshot-race'?crypto.randomUUID():s.snapshotId,serial:'fixture-device',source:s.source,captureMode:'fast',nodeCount:2,geometry,root:{text:'DO_NOT_SAVE_CANARY'}};else process.exit(10);
fs.writeFileSync(p,JSON.stringify(s));process.stdout.write(JSON.stringify(result));`, { mode: 0o600 });
      const result = await run({ cli: fake, session: scenario === "wrong-session" ? "33333333-3333-4333-8333-333333333333" : session,
        out, node: "node", warmSamples: 10, timeoutMs: 5000, first: "uiautomator" }, new AbortController().signal);
      const report = JSON.parse(readFileSync(result.summaryPath, "utf8"));
      const raw = readFileSync(result.samplePath, "utf8");
      assert.equal(raw.includes("DO_NOT_SAVE_CANARY"), false); assert.equal(JSON.stringify(report).includes("DO_NOT_SAVE_CANARY"), false);
      assert.equal(report.status, scenario === "success" ? "completed" : "failed");
      if (scenario === "success") { assert.equal(report.samples.completed, 22); assert.equal(report.backends.uiautomator.warm.successful, 10); }
      else if (scenario === "wrong-session") { assert.equal(report.samples.failed, 0); assert.equal(JSON.parse(readFileSync(state, "utf8")).count, 0); }
      else { assert.equal(report.samples.failed, 1); assert.equal(JSON.parse(readFileSync(state, "utf8")).count, 1); }
    }
    process.stdout.write("离线验证通过：22 次交替观察、失败即停、身份/快照竞态、内容脱敏、P95 门槛和参数校验。未连接手机。\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function main() {
  const o = options(process.argv.slice(2));
  if (o === "help") { process.stdout.write(help); return; }
  if (o === "self-test") { await selfTest(); return; }
  const controller = new AbortController(), stop = () => controller.abort(new Error("benchmark cancelled"));
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const result = await run(o, controller.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`); if (result.status !== "completed") process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "基准启动失败"}；使用 --help 查看用法。\n`); process.exitCode = 1; });
