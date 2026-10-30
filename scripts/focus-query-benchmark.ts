import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDebugFocusReader, FocusUnavailableError, parseFocusedWindowState } from "../electron/device/target";
import type { CommandResult } from "../electron/device/runtime";

type Backend = "legacy" | "cached";
type Sample = { backend: Backend; phase: "warmup" | "measured"; pair: number; order: number;
  durationMs: number; commandCount: number; commandModes: string[]; identityConsistent: boolean; status: "ok" | "failed"; error?: string };
type Execute = (args: string[]) => Promise<CommandResult>;
const round = (n: number) => Math.round(n * 1000) / 1000;
const errorCode = (error: unknown) => error instanceof FocusUnavailableError ? error.focusReason
  : error instanceof Error && ["device_not_online", "command_failed", "focus_changed", "unexpected_command"].includes(error.message)
    ? error.message : "query_failed";
function stats(values: number[]) {
  const a = [...values].sort((x, y) => x - y);
  return a.length ? { count: a.length, medianMs: round((a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2),
    minMs: round(a[0]), maxMs: round(a[a.length - 1]) } : null;
}

export async function benchmarkFocus(execute: Execute, save: (report: unknown) => void) {
  const samples: Sample[] = [];
  let active: Sample | undefined, expected: { id: string; packageName: string } | undefined;
  const measuredExecute = async (_adb: string, _serial: string, args: string[]) => {
    if (!active || args[0] !== "shell" || args[1] !== "dumpsys" || args[2] !== "window"
      || args.length !== 3 && (args.length !== 4 || !["windows", "displays"].includes(args[3]))) throw new Error("unexpected_command");
    active.commandCount++;
    active.commandModes.push(args[3] ?? "all");
    const result = await execute(args);
    if (result.code !== 0 || /Permission\s+(?:Denial|denied)|\bSecurityException\b|Can't find service:|Error dumping service info:|\bDUMP TIMEOUT\b/i.test(`${result.stdout.toString("utf8")}\n${result.stderr}`))
      throw new Error("command_failed");
    return result;
  };
  const cached = createDebugFocusReader(measuredExecute);
  const legacy = async () => {
    const windows = await measuredExecute("benchmark", "same-device", ["shell", "dumpsys", "window", "windows"]);
    if (windows.code !== 0) throw new Error("command_failed");
    let output = windows.stdout.toString("utf8");
    if (!output.includes("mCurrentFocus=")) {
      // Keep the former production windows + displays sequence as the baseline.
      const displays = await measuredExecute("benchmark", "same-device", ["shell", "dumpsys", "window", "displays"]);
      if (displays.code !== 0) throw new Error("command_failed");
      output += `\n${displays.stdout.toString("utf8")}`;
    }
    const parsed = parseFocusedWindowState(output);
    if (!parsed.focus) throw new FocusUnavailableError(parsed.reasonCode!, parsed.reason!);
    return parsed.focus;
  };
  const summary = (status: string) => ({ version: 1, status, measuredPairs: 10, warmupPerBackend: 1,
    noPageOutputPersisted: true, sameIdentityRequired: true, p95: null,
    limits: "One device and one stable window; 10 measured samples per backend. No P95. Warmup is not a device cold start.",
    backends: Object.fromEntries((["legacy", "cached"] as Backend[]).map(backend => {
      const measured = samples.filter(s => s.backend === backend && s.phase === "measured" && s.status === "ok");
      return [backend, { timings: stats(measured.map(s => s.durationMs)), commandCounts: measured.map(s => s.commandCount) }];
    })), samples });
  const run = async (backend: Backend, phase: Sample["phase"], pair: number, order: number) => {
    const sample: Sample = { backend, phase, pair, order, durationMs: 0, commandCount: 0, commandModes: [], identityConsistent: false, status: "failed" };
    active = sample;
    const started = performance.now();
    try {
      const focus = backend === "legacy" ? await legacy() : await cached("benchmark", "same-device");
      if (expected && (focus.id !== expected.id || focus.packageName !== expected.packageName)) throw new Error("focus_changed");
      expected ??= focus;
      sample.identityConsistent = true;
      sample.status = "ok";
    } catch (error) { sample.error = errorCode(error); throw error; }
    finally {
      sample.durationMs = round(performance.now() - started);
      samples.push(sample); active = undefined;
      save(summary(sample.status === "ok" ? "running" : "failed"));
    }
  };
  try {
    const online = await execute(["get-state"]);
    if (online.code !== 0 || online.stdout.toString("utf8").trim() !== "device") throw new Error("device_not_online");
    await run("legacy", "warmup", -1, 0);
    await run("cached", "warmup", -1, 1);
    for (let pair = 0; pair < 10; pair++) {
      const order: Backend[] = pair % 2 === 0 ? ["legacy", "cached"] : ["cached", "legacy"];
      for (let index = 0; index < order.length; index++) await run(order[index], "measured", pair, index);
    }
    const report = summary("complete"); save(report); return report;
  } catch (error) {
    const report = { ...summary("failed"), error: errorCode(error) }; save(report); return report;
  }
}

async function selfTest() {
  const reply = (text: string): CommandResult => ({ code: 0, stdout: Buffer.from(text), stderr: "" });
  let focusCount = 0, saved = "";
  const execute = async (args: string[]) => {
    if (args[0] === "get-state") return reply("device");
    if (args[3] === "windows") return reply("mTopFocusedDisplayId=0");
    focusCount++;
    return reply(`${args.length === 3 ? "mTopFocusedDisplayId=0\n" : ""}Display: mDisplayId=0\nmCurrentFocus=Window{abc u0 com.secret.canary/.Main}`);
  };
  const ok = await benchmarkFocus(execute, report => { saved = JSON.stringify(report); });
  assert.equal(ok.status, "complete"); assert.equal(focusCount, 22); assert.equal(ok.samples.length, 22);
  assert.ok(!saved.includes("canary") && !saved.includes("mCurrentFocus"));
  assert.deepEqual(ok.samples.slice(2).map(s => s.backend), Array.from({ length: 10 }, (_, i) => i % 2 ? ["cached", "legacy"] : ["legacy", "cached"]).flat());
  assert.ok(ok.samples.filter(s => s.backend === "cached" && s.phase === "measured").every(s => s.commandCount === 1));
  assert.ok(ok.samples.filter(s => s.backend === "legacy").every(s => s.commandCount === 2));
  let count = 0;
  const changed = await benchmarkFocus(async args => {
    const r = await execute(args);
    if (r.stdout.includes("mCurrentFocus") && ++count === 3) r.stdout = Buffer.from(r.stdout.toString("utf8").replace("{abc", "{def"));
    return r;
  }, () => undefined);
  assert.equal(changed.status, "failed"); assert.equal(changed.samples.length, 3); assert.equal(changed.samples.at(-1)?.error, "focus_changed");
  const offline = await benchmarkFocus(async () => reply("offline"), () => undefined);
  assert.equal(offline.status, "failed"); assert.equal(offline.samples.length, 0);
  console.log("Self-test passed: 10 interleaved pairs, command counts, identity stop, offline stop, no page output.");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--self-test") return selfTest();
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: bun scripts/focus-query-benchmark.ts --adb /absolute/adb --serial DEVICE --out-dir /absolute/new-directory\nRead-only focus queries. One warmup each, then 10 alternating pairs. Stops on focus change or error; saves timings only."); return;
  }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--adb", "--serial", "--out-dir"].includes(args[i]) || !args[i + 1] || options.has(args[i])) throw new Error("invalid_arguments");
    options.set(args[i], args[i + 1]);
  }
  const adb = options.get("--adb"), serial = options.get("--serial"), out = options.get("--out-dir");
  if (!adb || !isAbsolute(adb) || !serial || !/^[\w.:-]{1,256}$/.test(serial) || !out || !isAbsolute(out)) throw new Error("invalid_arguments");
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  mkdirSync(out, { mode: 0o700 });
  const execute: Execute = args => new Promise((done, reject) => {
    execFile(adb, ["-s", serial, ...args], { encoding: "buffer", timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error("command_failed")); return; }
      done({ code: 0, stdout, stderr: stderr.toString("utf8") });
    });
  });
  const report = await benchmarkFocus(execute, value => writeFileSync(join(out, "focus-query-comparison.json"), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }));
  console.log(JSON.stringify({ status: report.status, results: report.backends, output: join(out, "focus-query-comparison.json") }, null, 2));
  if (report.status !== "complete") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error("Focus benchmark stopped. Check arguments and output directory; raw device output was not printed."); process.exitCode = 1;
});
