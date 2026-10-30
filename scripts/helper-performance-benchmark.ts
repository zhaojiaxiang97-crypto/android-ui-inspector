/** Read-only public CLI benchmark. Run with bun; this script never sends phone input. */
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { debugTimingsSchema, type DebugTimings } from "../shared/debug-timing";
import { assessCaptureGeometry } from "../shared/screen-coordinates";

type Json = Record<string, unknown>;
export type CaptureOptions = { mode: "capture"; cli: string; out: string; node: string; session: string; serial: string; packageName: string;
  apkSha256: string; pageCheck: string; warmSamples: number; timeoutMs: number; snapshotFile?: string };
type CompareOptions = { mode: "compare"; baseline: string; candidate: string; out: string; confirmSamePage: true };
export type CliRunner = (args: string[], signal: AbortSignal) => Promise<{ data: Json; wallMs: number }>;
const record = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const count = z.number().int().positive().safe(), ms = z.number().finite().nonnegative();
const frame = z.object({ width: count, height: count, rotation: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) });
const geometrySchema = z.object({ hierarchyRotation: frame.shape.rotation, beforeScreenshot: frame, afterScreenshot: frame,
  screenshotSize: z.object({ width: count, height: count }) });
const sampleSchema = z.object({ index: count, phase: z.enum(["first", "warm"]), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  captureWallMs: ms, metadataWallMs: ms, captureDurationMs: ms, stepId: count, timings: debugTimingsSchema,
  snapshot: z.object({ id: z.uuid(), source: z.literal("accessibility-helper"), captureMode: z.literal("fast"), nodeCount: count,
    screenshotAvailable: z.literal(true), geometry: geometrySchema }) });
const unavailable = { pngBytes: "unavailable-in-public-cli", androidPhaseTimings: "unavailable-in-public-cli",
  helperServiceIdentity: "unavailable-in-public-cli", treeStructureSignature: "unavailable-in-public-cli", fieldSignature: "unavailable-in-public-cli" } as const;
const limitations = [
  "必须由操作者在两次运行前后人工核对同一静止页面；pageCheck 仅记录核验标签，不能自动证明同页。",
  "公共 CLI 不提供 PNG 字节数、Android 内部阶段、Helper 服务身份、树结构和字段签名；需另从现有报告离线核对，当前摘要不证明它们相同。",
  "只比较公开接口耗时；首采是本次运行首次观察，不代表冷启动。默认首采后 5 次，少于 5 次只适合冒烟检查。",
  "分段区间可能嵌套或并行，不可直接相加；顺序、缓存、温度、后台负载和图片大小可能影响结果，不能单凭差值归因。",
];
const summarySchema = z.object({ format: z.literal("helper-performance-benchmark-v1"), status: z.enum(["running", "completed", "failed"]),
  sessionId: z.uuid(), device: z.object({ serial: z.string().min(1), packageName: z.string().min(1) }), backend: z.literal("accessibility-helper"),
  apkSha256: z.string().regex(/^[a-f0-9]{64}$/), artifactIdentity: z.literal("caller-declared-not-device-verified"),
  pageCheck: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/), warmSamples: count.max(20), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(),
  grant: z.object({ verification: z.literal("public-live-attach-before-and-after-each-capture"), expiresAt: z.iso.datetime() }).nullable(),
  unavailable: z.object(Object.fromEntries(Object.keys(unavailable).map(key => [key, z.literal("unavailable-in-public-cli")]))),
  samples: z.array(sampleSchema).max(21), failure: z.object({ code: z.string().regex(/^[a-z_]+$/), sample: count }).nullable(),
  limitations: z.array(z.string()) });
export type BenchmarkSummary = z.infer<typeof summarySchema>;
class BenchmarkFailure extends Error { constructor(readonly code: string) { super(code); } }
function fail(code: string): never { throw new BenchmarkFailure(code); }
const round = (n: number) => Math.round(n * 100) / 100;

export function parseBenchmarkOptions(args: string[]): CaptureOptions | CompareOptions | "help" {
  const strings = ["cli", "out-dir", "node", "session", "serial", "package", "apk-sha256", "page-check", "warm-samples", "timeout-ms", "snapshot-file", "baseline", "candidate"];
  const parsed = parseArgs({ args, strict: true, tokens: true, options: { ...Object.fromEntries(strings.map(key => [key, { type: "string" as const }])),
    help: { type: "boolean", short: "h" }, "confirm-same-page": { type: "boolean" } } });
  const seen = new Set<string>();
  for (const token of parsed.tokens) if (token.kind === "option") { if (seen.has(token.name)) fail("duplicate_option"); seen.add(token.name); }
  if (parsed.values.help) return "help";
  const v: Record<string, string | boolean | undefined> = parsed.values, str = (key: string) => typeof v[key] === "string" ? v[key] as string : undefined;
  const path = (key: string) => { const value = str(key); if (!value || !isAbsolute(value)) fail("absolute_path_required"); return value; };
  const out = path("out-dir");
  if (seen.has("baseline") || seen.has("candidate")) {
    if ([...seen].some(key => !["baseline", "candidate", "out-dir", "confirm-same-page"].includes(key))) fail("mixed_modes");
    if (v["confirm-same-page"] !== true) fail("same_page_confirmation_required");
    return { mode: "compare", baseline: path("baseline"), candidate: path("candidate"), out, confirmSamePage: true };
  }
  if (seen.has("confirm-same-page")) fail("mixed_modes");
  const required = (key: string, pattern: RegExp) => { const value = str(key); if (!value || !pattern.test(value)) fail("invalid_required_option"); return value; };
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = str(key) ?? String(fallback), n = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) fail("invalid_numeric_option"); return n;
  };
  const cli = path("cli"); if (!/\.(cjs|mjs|js)$/.test(cli)) fail("built_cli_required");
  const session = str("session"); if (!z.uuid().safeParse(session).success) fail("invalid_session");
  if (str("node") !== undefined && !str("node")!.trim()) fail("invalid_node");
  return { mode: "capture", cli, out, node: str("node") ?? "node", session: session!, serial: required("serial", /^[\w.-]+$/),
    packageName: required("package", /^[\w]+(?:\.[\w]+)+$/), apkSha256: required("apk-sha256", /^[a-fA-F0-9]{64}$/).toLowerCase(),
    pageCheck: required("page-check", /^[a-zA-Z0-9._-]{1,80}$/), warmSamples: number("warm-samples", 5, 1, 20), timeoutMs: number("timeout-ms", 60000, 1000, 140000),
    ...(seen.has("snapshot-file") ? { snapshotFile: path("snapshot-file") } : {}) };
}

function grant(data: Json, o: CaptureOptions, expiresAt?: string) {
  if (data.id !== o.session || data.active !== true || data.busy !== false || data.serial !== o.serial || data.packageName !== o.packageName
    || typeof data.expiresAt !== "string" || !z.iso.datetime().safeParse(data.expiresAt).success || Date.parse(data.expiresAt) <= Date.now()
    || expiresAt !== undefined && data.expiresAt !== expiresAt) fail("live_grant_changed_or_unavailable");
  return data.expiresAt as string;
}
function lastStep(data: Json) {
  if (!Array.isArray(data.steps) || data.steps.some(s => !record(s) || !Number.isSafeInteger(s.id) || Number(s.id) < 1)) fail("invalid_live_steps");
  return Math.max(0, ...(data.steps as Json[]).map(s => Number(s.id)));
}

export async function collectHelperBenchmark(o: CaptureOptions, cli: CliRunner, signal = new AbortController().signal,
  save: (summary: BenchmarkSummary) => void = () => {}): Promise<BenchmarkSummary> {
  const summary: BenchmarkSummary = { format: "helper-performance-benchmark-v1", status: "running", sessionId: o.session,
    device: { serial: o.serial, packageName: o.packageName }, backend: "accessibility-helper", apkSha256: o.apkSha256,
    artifactIdentity: "caller-declared-not-device-verified", pageCheck: o.pageCheck, warmSamples: o.warmSamples,
    startedAt: new Date().toISOString(), finishedAt: null, grant: null, unavailable, samples: [], failure: null, limitations };
  try {
    save(summary);
    for (let i = 0; i <= o.warmSamples; i++) {
      signal.throwIfAborted(); const startedAt = new Date().toISOString();
      const before = await cli(["attach"], signal), expiresAt = grant(before.data, o, summary.grant?.expiresAt);
      summary.grant = { verification: "public-live-attach-before-and-after-each-capture", expiresAt };
      const previousStep = lastStep(before.data), previous = summary.samples.at(-1);
      if (previous && (previousStep !== previous.stepId || before.data.snapshotId !== previous.snapshot.id)) fail("concurrent_step_or_snapshot_changed");
      const captured = await cli(["capture", "--session", o.session, "--mode", "fast", "--backend", "accessibility-helper"], signal), c = captured.data;
      if (c.isError || c.source !== "accessibility-helper" || c.mode !== "fast" || !z.uuid().safeParse(c.snapshotId).success
        || !count.safeParse(c.nodeCount).success || !ms.safeParse(c.captureDurationMs).success || c.stepId !== previousStep + 1
        || c.recordingWarning || Array.isArray(c.recordingErrors) && c.recordingErrors.length) fail("capture_incomplete_or_mismatched");
      const timing = debugTimingsSchema.safeParse(c.timings);
      if (!timing.success || timing.data.status !== "success" || timing.data.droppedSpans !== 0
        || timing.data.observationCount !== 1 || timing.data.observationCounts.explicit !== 1 || timing.data.commandCounts.input
        || timing.data.spans.some(s => s.status !== "success" || s.phase === "input" || s.phase === "observation" && s.backend !== "accessibility-helper")) fail("complete_capture_timings_required");
      if (summary.samples.some(s => s.snapshot.id === c.snapshotId || s.timings.correlationId === timing.data.correlationId)) fail("reused_observation");
      const metadata = await cli(["snapshot"], signal), s = metadata.data;
      if (s.snapshotId !== c.snapshotId || s.serial !== o.serial || s.source !== "accessibility-helper" || s.captureMode !== "fast"
        || s.nodeCount !== c.nodeCount || s.screenshotAvailable !== true || assessCaptureGeometry(s.geometry).status !== "checked") fail("snapshot_changed_or_invalid");
      const geometry = geometrySchema.safeParse(s.geometry); if (!geometry.success) fail("snapshot_changed_or_invalid");
      const first = summary.samples[0];
      if (first && (first.snapshot.nodeCount !== s.nodeCount || JSON.stringify(first.snapshot.geometry) !== JSON.stringify(geometry.data))) fail("page_metadata_changed");
      const after = await cli(["attach"], signal); grant(after.data, o, expiresAt);
      const step = Array.isArray(after.data.steps) ? after.data.steps.find(step => record(step) && step.id === c.stepId) : undefined;
      if (after.data.snapshotId !== c.snapshotId || lastStep(after.data) !== c.stepId || !record(step) || step.action !== "capture_ui"
        || step.status !== "done" || step.afterId !== c.snapshotId || !record(step.input) || step.input.backend !== "accessibility-helper"
        || step.input.sessionId !== o.session || !record(step.timings) || step.timings.correlationId !== timing.data.correlationId) fail("concurrent_step_or_snapshot_changed");
      summary.samples.push(sampleSchema.parse({ index: i + 1, phase: i === 0 ? "first" : "warm", startedAt, finishedAt: new Date().toISOString(),
        captureWallMs: round(captured.wallMs), metadataWallMs: round(before.wallMs + metadata.wallMs + after.wallMs), captureDurationMs: c.captureDurationMs,
        stepId: c.stepId, timings: timing.data, snapshot: { id: c.snapshotId, source: s.source, captureMode: s.captureMode,
          nodeCount: s.nodeCount, screenshotAvailable: true, geometry: geometry.data } }));
      save(summary);
    }
    summary.status = "completed";
  } catch (error) {
    summary.status = "failed"; summary.failure = { code: error instanceof BenchmarkFailure ? error.code : signal.aborted ? "cancelled" : "unexpected_failure", sample: summary.samples.length + 1 };
  }
  summary.finishedAt = new Date().toISOString(); save(summary); return summary;
}

function validateCompleted(value: unknown) {
  const parsed = summarySchema.safeParse(value); if (!parsed.success) fail("invalid_saved_summary");
  const s = parsed.data;
  if (s.status !== "completed" || s.failure || !s.grant || !s.finishedAt || s.samples.length !== s.warmSamples + 1) fail("incomplete_saved_summary");
  const first = s.samples[0], snapshots = new Set<string>(), correlations = new Set<string>();
  for (const [i, sample] of s.samples.entries()) {
    if (sample.index !== i + 1 || sample.phase !== (i === 0 ? "first" : "warm") || sample.timings.status !== "success"
      || sample.timings.droppedSpans !== 0 || sample.snapshot.nodeCount !== first.snapshot.nodeCount
      || assessCaptureGeometry(sample.snapshot.geometry).status !== "checked" || JSON.stringify(sample.snapshot.geometry) !== JSON.stringify(first.snapshot.geometry)
      || snapshots.has(sample.snapshot.id) || correlations.has(sample.timings.correlationId)) fail("inconsistent_saved_summary");
    snapshots.add(sample.snapshot.id); correlations.add(sample.timings.correlationId);
  }
  return s;
}
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { count: sorted.length, min: round(sorted[0]), median: round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2), max: round(sorted.at(-1)!) };
}
function delta(before: number[], after: number[]) {
  const baseline = stats(before), candidate = stats(after), change = candidate.median - baseline.median;
  return { baseline, candidate, medianChange: round(change), percentChange: baseline.median ? round(change / baseline.median * 100) : null };
}
function phaseMs(t: DebugTimings, phase: string) {
  const spans = t.spans.filter(s => s.phase === phase).sort((a, b) => a.startOffsetMs - b.startOffsetMs);
  let total = 0, end = 0;
  for (const s of spans) { const finish = s.startOffsetMs + s.durationMs; total += Math.max(0, finish - Math.max(end, s.startOffsetMs)); end = Math.max(end, finish); }
  return total;
}
export function compareHelperBenchmarks(baseline: unknown, candidate: unknown, confirmedSamePage: boolean) {
  if (!confirmedSamePage) fail("same_page_confirmation_required");
  const a = validateCompleted(baseline), b = validateCompleted(candidate);
  if (a.device.serial !== b.device.serial || a.device.packageName !== b.device.packageName || a.pageCheck !== b.pageCheck
    || a.samples[0].snapshot.nodeCount !== b.samples[0].snapshot.nodeCount
    || JSON.stringify(a.samples[0].snapshot.geometry) !== JSON.stringify(b.samples[0].snapshot.geometry)) fail("incompatible_comparison");
  const x = a.samples.slice(1), y = b.samples.slice(1);
  const phases = new Set([...x, ...y].flatMap(s => s.timings.spans.map(span => span.phase)));
  return { format: "helper-performance-comparison-v1", device: a.device, pageCheck: a.pageCheck, manualSamePageConfirmation: true,
    baselineApkSha256: a.apkSha256, candidateApkSha256: b.apkSha256, artifactIdentity: a.artifactIdentity,
    first: { baseline: a.samples[0], candidate: b.samples[0] }, warm: {
      captureWallMs: delta(x.map(s => s.captureWallMs), y.map(s => s.captureWallMs)), captureDurationMs: delta(x.map(s => s.captureDurationMs), y.map(s => s.captureDurationMs)),
      hostPhases: Object.fromEntries([...phases].sort().map(phase => [phase, x.every(s => s.timings.spans.some(t => t.phase === phase)) && y.every(s => s.timings.spans.some(t => t.phase === phase))
        ? delta(x.map(s => phaseMs(s.timings, phase)), y.map(s => phaseMs(s.timings, phase))) : { unavailable: "phase-not-present-in-every-sample" }])) },
    unavailable, limitations };
}

function publicCli(o: CaptureOptions): CliRunner {
  return (args, signal) => new Promise((resolveResult, reject) => {
    const started = performance.now(), child = spawn(o.node, [o.cli, ...args, ...(o.snapshotFile ? ["--snapshot-file", o.snapshotFile] : [])], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", bytes = 0, failure: string | null = null, kill: ReturnType<typeof setTimeout> | undefined;
    const stop = (code: string) => { if (failure) return; failure = code; child.kill("SIGINT"); kill = setTimeout(() => child.kill("SIGKILL"), 3000); };
    const abort = () => stop("cancelled"), timeout = setTimeout(() => stop("cli_timeout"), o.timeoutMs);
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) stop("cli_output_limit"); else out += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) stop("cli_output_limit"); });
    const cleanup = () => { clearTimeout(timeout); if (kill) clearTimeout(kill); signal.removeEventListener("abort", abort); };
    child.once("error", () => { cleanup(); reject(new BenchmarkFailure("cli_start_failed")); });
    child.once("close", code => {
      cleanup(); if (failure || code !== 0) { reject(new BenchmarkFailure(failure ?? "cli_failed")); return; }
      try { const data: unknown = JSON.parse(out); if (!record(data) || data.isError) fail("cli_failed"); resolveResult({ data, wallMs: performance.now() - started }); }
      catch { reject(new BenchmarkFailure("invalid_cli_response")); }
    });
  });
}
const help = `Helper 同页只读对照（只调用公共 attach/capture/snapshot，不安装、不输入、不重试、不换源）。
采样：bun scripts/helper-performance-benchmark.ts --cli /absolute/cli.cjs --session UUID --serial SERIAL --package APP --apk-sha256 SHA256 --page-check static-page-01 --out-dir /new/output
可选：--warm-samples 1..20（默认5，首采另计） --timeout-ms 60000 --node /path/node --snapshot-file /path/shared.json
对照：bun scripts/helper-performance-benchmark.ts --baseline /run-a/summary.json --candidate /run-b/summary.json --confirm-same-page --out-dir /new/comparison
page-check只用短ASCII标识，不写页面正文。APK hash由操作者提供，脚本不会查询安装包。
${limitations.join("\n")}\n`;
async function main() {
  const o = parseBenchmarkOptions(process.argv.slice(2)); if (o === "help") { process.stdout.write(help); return; }
  const read = (path: string) => { const stat = lstatSync(path); if (!stat.isFile() || stat.size > 16 * 1024 * 1024) fail("invalid_summary_file"); return JSON.parse(readFileSync(path, "utf8")) as unknown; };
  const write = (name: string, value: unknown) => { const temp = join(o.out, `.${name}.tmp`); writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temp, join(o.out, name)); };
  if (o.mode === "compare") {
    const comparison = compareHelperBenchmarks(read(o.baseline), read(o.candidate), o.confirmSamePage);
    mkdirSync(o.out, { mode: 0o700 }); write("comparison.json", comparison); process.stdout.write("只读对照已保存；请结合人工同页、报告图大小和树字段核验解释差值。\n"); return;
  }
  if (!lstatSync(o.cli).isFile()) fail("invalid_cli_file"); mkdirSync(o.out, { mode: 0o700 });
  const controller = new AbortController(), stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const summary = await collectHelperBenchmark(o, publicCli(o), controller.signal, data => write("summary.json", data));
    process.stdout.write(JSON.stringify({ status: summary.status, successfulSamples: summary.samples.length, failure: summary.failure }) + "\n");
    if (summary.status !== "completed") process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => {
  process.stderr.write(`${error instanceof BenchmarkFailure ? error.code : "benchmark_failed"}；使用 --help 查看用法。\n`); process.exitCode = 1;
});
