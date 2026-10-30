#!/usr/bin/env bun
/** Builds an offline Android benchmark and summarizes frozen JSONL. Never invokes adb. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

const names = ["small", "medium", "large", "near"] as const;
const name = z.enum(names), hash = z.string().regex(/^[a-f0-9]{64}$/);
const size = z.number().int().min(0).max(32 * 1024 * 1024), memory = z.number().int().min(0).max(32 * 1024 ** 3);
const duration = z.number().finite().min(0).max(600_000);
const encoding = z.object({ jsonMs: duration, utf8Ms: duration, byteLength: size, sha256: hash,
  javaHeapBeforeBytes: memory, javaHeapAfterBytes: memory, javaHeapObservedMaxBytes: memory.optional(),
  nativeHeapObservedMaxBytes: memory.optional(), memorySamples: z.number().int().min(0).max(1_000_000) }).strict();
const fixture = z.object({ event: z.literal("fixture"), fixture: name, runtime: z.literal("Android"),
  sdkInt: z.number().int().min(26).max(100), platformOrgJson: z.literal(true), width: z.number().int().min(1).max(4096),
  height: z.number().int().min(1).max(4096), pngBytes: size.max(16 * 1024 * 1024), pngSha256: hash, pixelSha256: hash,
  warmPairs: z.number().int().min(2).max(10), warmupPairs: z.number().int().min(1).max(5), firstOrder: z.enum(["AB", "BA"]),
  memorySampleIntervalMs: z.literal(1), memoryLimit: z.string().max(256), coldLimit: z.string().max(256), timingLimit: z.string().max(256) }).strict();
const pair = z.object({ event: z.literal("pair"), fixture: name, phase: z.enum(["cold-first", "warmup", "warm", "memory-probe"]),
  index: z.number().int().min(0).max(10), order: z.enum(["AB", "BA"]), baseline: encoding, candidate: encoding,
  fieldsEqual: z.literal(true), pngBytesEqual: z.literal(true), decodedPixelsEqual: z.literal(true),
  originalUnchanged: z.literal(true), bytesEqual: z.boolean() }).strict();
const complete = z.object({ event: z.literal("complete"), fixture: name, pairs: z.number().int().min(5).max(17), passed: z.literal(true) }).strict();
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw Error(`${command} failed: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}
export function buildJsonAndroidBenchmark(output: string, serializer: string, sdk: string, javaHome: string) {
  if (![output, serializer, sdk, javaHome].every(isAbsolute)) throw Error("absolute paths required");
  if (existsSync(output)) throw Error("output must be a new directory");
  const source = fileURLToPath(new URL("./helper-templates/InspectorJsonAndroidBenchmark.java", import.meta.url));
  const android = join(sdk, "platforms/android-36/android.jar"), d8 = join(sdk, "build-tools/36.0.0/d8");
  for (const path of [source, serializer, android, d8, join(javaHome, "bin/javac")]) if (!existsSync(path)) throw Error("required tool/source unavailable");
  const fixtureBytes = readFileSync(source), serializerBytes = readFileSync(serializer);
  mkdirSync(join(output, "classes"), { recursive: true });
  mkdirSync(join(output, "sources"));
  const frozenFixture = join(output, "sources/InspectorJsonAndroidBenchmark.java"), frozenSerializer = join(output, "sources/InspectorSnapshotJson.java");
  writeFileSync(frozenFixture, fixtureBytes, { flag: "wx", mode: 0o600 });
  writeFileSync(frozenSerializer, serializerBytes, { flag: "wx", mode: 0o600 });
  const javac = join(javaHome, "bin/javac");
  run(javac, ["--release", "8", "-cp", android, "-d", join(output, "classes"), frozenFixture, frozenSerializer]);
  const classes: string[] = [];
  function visit(path: string) { for (const entry of readdirSync(path, { withFileTypes: true })) {
    const next = join(path, entry.name); if (entry.isDirectory()) visit(next); else if (entry.name.endsWith(".class")) classes.push(next);
  } }
  visit(join(output, "classes"));
  const archive = join(output, "inspector-json-benchmark.zip");
  run(d8, ["--release", "--min-api", "26", "--lib", android, "--output", archive, ...classes]);
  const manifest = { format: "helper-json-android-benchmark-v1", archive, archiveSha256: sha(readFileSync(archive)),
    fixtureSourceSha256: sha(fixtureBytes), serializerSourceSha256: sha(serializerBytes),
    javac: run(javac, ["-version"]), platformApi: 36, fixtures: names, requiredRuntime: "Android app_process with platform org.json",
    invocation: "CLASSPATH=/data/local/tmp/inspector-json-benchmark.zip app_process -Xmx512m /system/bin com.artemis.helper.InspectorJsonAndroidBenchmark FIXTURE 6 2 AB",
    method: "Run each fixture in fresh processes with both AB and BA first orders; keep each stdout JSONL separate; run self-test first.",
    limitations: ["No phone commands are executed by this tool.", "Cold means first pair after fixture construction, not a cold OS or JVM.",
      "The 1ms sampler runs only in a separate memory-probe pair, excluded from timing stats; not exact peak or process RSS.",
      "Only JSON/UTF8 intervals are compared; no request or full-task speedup is inferred.",
      "Synthetic fields and near-limit XML padding are encoding stress cases, not product snapshot acceptance fixtures.",
      "Sequential A/B memory probes share process state; neither observed high-water is an independent per-variant peak."] };
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return manifest;
}
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), at = (p: number) => sorted[Math.ceil(p * sorted.length) - 1];
  return { count: values.length, mean: values.reduce((sum, n) => sum + n, 0) / values.length,
    median: sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    min: sorted[0], p95: at(.95), max: sorted[sorted.length - 1] };
}
export function summarizeJsonAndroidBenchmark(contents: string[]) {
  if (!contents.length || contents.length > 32) throw Error("provide 1..32 separate process JSONL files");
  const runs = contents.map(text => {
    if (Buffer.byteLength(text) > 1024 * 1024) throw Error("benchmark output exceeds bound");
    const rows: unknown[] = text.trim().split("\n").map(line => JSON.parse(line));
    const first = fixture.parse(rows[0]), last = complete.parse(rows[rows.length - 1]);
    const pairs = rows.slice(1, -1).map(row => pair.parse(row));
    if (last.fixture !== first.fixture || last.pairs !== pairs.length || pairs.length !== 2 + first.warmupPairs + first.warmPairs) throw Error("incomplete run");
    const expected = [{ phase: "cold-first", index: 0 }, ...Array.from({ length: first.warmupPairs }, (_, index) => ({ phase: "warmup", index })),
      ...Array.from({ length: first.warmPairs }, (_, index) => ({ phase: "warm", index })), { phase: "memory-probe", index: 0 }];
    for (const [index, item] of pairs.entries()) {
      const sequence = expected[index], ab = first.firstOrder === "AB", warmup = item.phase === "warmup";
      const order = item.phase === "cold-first" ? first.firstOrder : (item.index % 2 === 0 ? (warmup ? !ab : ab) : (warmup ? ab : !ab)) ? "AB" : "BA";
      if (item.fixture !== first.fixture || item.phase !== sequence.phase || item.index !== sequence.index || item.order !== order) throw Error("pair order mismatch");
      if ([item.baseline, item.candidate].some(result => item.phase === "memory-probe" ? result.memorySamples === 0 : result.memorySamples !== 0))
        throw Error("memory probe must be separate from timing pairs");
      if ([item.baseline, item.candidate].some(result => item.phase === "memory-probe"
        ? result.javaHeapObservedMaxBytes === undefined || result.nativeHeapObservedMaxBytes === undefined
        : result.javaHeapObservedMaxBytes !== undefined || result.nativeHeapObservedMaxBytes !== undefined)) throw Error("missing or misplaced memory sampling");
      for (const kind of ["baseline", "candidate"] as const) if (item[kind].sha256 !== pairs[0][kind].sha256 || item[kind].byteLength !== pairs[0][kind].byteLength)
        throw Error("immutable output changed between pairs");
    }
    return { fixture: first, pairs };
  });
  const groups = names.flatMap(name => {
    const own = runs.filter(run => run.fixture.fixture === name); if (!own.length) return [];
    if (new Set(own.map(run => `${run.fixture.pngSha256}/${run.fixture.pixelSha256}/${run.pairs[0].baseline.sha256}/${run.pairs[0].candidate.sha256}`)).size !== 1)
      throw Error("fixed payload changed between processes");
    return ["cold-first", "warm"].map(phase => {
      const pairs = own.flatMap(run => run.pairs.filter(pair => pair.phase === phase));
      return { fixture: name, phase, processes: own.length, firstOrders: own.map(run => run.fixture.firstOrder),
        pngBytes: own[0].fixture.pngBytes, bytesEqual: pairs.every(pair => pair.bytesEqual),
        baseline: { jsonMs: stats(pairs.map(p => p.baseline.jsonMs)), utf8Ms: stats(pairs.map(p => p.baseline.utf8Ms)) },
        candidate: { jsonMs: stats(pairs.map(p => p.candidate.jsonMs)), utf8Ms: stats(pairs.map(p => p.candidate.utf8Ms)) },
        pairedJsonDifferenceMs: stats(pairs.map(p => p.baseline.jsonMs - p.candidate.jsonMs)),
        };
    });
  });
  const memoryProbes = runs.map(run => ({ fixture: run.fixture.fixture, order: run.fixture.firstOrder,
    baseline: run.pairs[run.pairs.length - 1].baseline, candidate: run.pairs[run.pairs.length - 1].candidate }));
  return { format: "helper-json-android-benchmark-summary-v1", runs: runs.length, groups, memoryProbes,
    limitations: ["Synthetic immutable payloads; not capture, HTTP or task latency.", "Cold-first and warmed pairs are separate populations.",
      "Observed Java/native allocation samples are not exact memory peaks or process RSS; sequential variants share process state.",
      "Synthetic fields and near-limit padding do not establish product snapshot protocol acceptance.", "No timing result is accepted from a desktop JVM."] };
}
async function main() {
  const { values, positionals } = parseArgs({ options: { build: { type: "boolean" }, out: { type: "string" }, serializer: { type: "string" },
    sdk: { type: "string" }, "java-home": { type: "string" }, summarize: { type: "boolean" } }, allowPositionals: true, strict: true });
  if (!values.out || !isAbsolute(values.out)) throw Error("--out absolute path required");
  if (values.build && !values.summarize && !positionals.length) {
    const result = buildJsonAndroidBenchmark(values.out, resolve(values.serializer ?? "scripts/helper-templates/InspectorSnapshotJson.java"),
      values.sdk ?? process.env.ANDROID_HOME ?? "/opt/homebrew/share/android-commandlinetools", values["java-home"] ?? "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home");
    console.log(JSON.stringify(result));
  } else if (values.summarize && !values.build) {
    const result = summarizeJsonAndroidBenchmark(positionals.map(path => readFileSync(path, "utf8")));
    writeFileSync(values.out, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 }); console.log(JSON.stringify({ output: values.out, runs: result.runs }));
  } else throw Error("use --build or --summarize, never both");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(String(error)); process.exitCode = 1; });
