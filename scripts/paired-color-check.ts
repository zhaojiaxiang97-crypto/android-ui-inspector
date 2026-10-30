// Offline only. Reuses saved, hash-checked paired sample captures; no ADB calls.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { build } from "vite";
import { validatePairedColorEvidence, verifyPairedPng } from "./paired-color-evidence";
import type { PairedColorInput } from "../benchmarks/paired-color-check";

assert.equal(process.argv.length, 3, "Usage: bun scripts/paired-color-check.ts SAVED_GROUP_COLOR_DIRECTORY");
const source = resolve(process.argv[2]);
const saved = JSON.parse(readFileSync(join(source, "result.json"), "utf8"));
assert.equal(saved.completed, true); assert.equal(saved.extended, true);
assert.equal(saved.nativeGroupVerified, true); assert.equal(saved.report.completed, true);
assert.equal(saved.report.captureTask, "one-main-thread-task-fixed-views-not-simultaneous");
assert.equal(saved.report.timeBase, "elapsedRealtimeNanos");
assert(Number.isSafeInteger(saved.report.pid) && saved.report.pid > 0);
assert.match(saved.report.activityIdentity, /^[0-9a-f]+$/);
assert.match(saved.report.probeToken, /^[0-9a-f]{16}$/);
assert.deepEqual(saved.report.cases.map((r: { case: string }) => r.case), ["solid", "gray-vertical", "gray-horizontal", "color-vertical",
  "leaf-gradient", "leaf-intrinsic-alpha-gradient", "leaf-view-alpha", "overlapping-alpha"]);
const inputs: PairedColorInput[] = saved.report.cases.map((row: PairedColorInput & { hardwareAccelerated: boolean;
  composedVsProductionGroup: PairedColorInput["phoneMetric"] }, i: number) => {
  assert.equal(row.hardwareAccelerated, !saved.softwareWindow);
  validatePairedColorEvidence(row.captures, i, row.hardwareAccelerated);
  const files = [...row.captures.map(c => c.file), `group-color-${i}-composed.png`];
  const images: Record<string, string> = {};
  for (const file of files) {
    const matches = saved.artifacts.filter((a: { file: string }) => a.file === file);
    assert.equal(matches.length, 1, `Missing or duplicate hash: ${file}`);
    const bytes = readFileSync(join(source, file));
    verifyPairedPng(bytes, file.includes("-child-") ? 61 : 240, file.includes("-child-") ? 39 : 160, matches[0].sha256);
    images[file] = "data:image/png;base64," + bytes.toString("base64");
  }
  for (const key of ["pixels", "mismatchedPixels", "maxChannelDelta", "alphaMismatches"] as const)
    assert(Number.isSafeInteger(row.composedVsProductionGroup[key]) && row.composedVsProductionGroup[key] >= 0);
  return { case: row.case, captures: row.captures, images, phoneMetric: row.composedVsProductionGroup };
});
const project = resolve(import.meta.dirname, "..");
const output = join(project, ".benchmarks/paired-color-offline", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "input.json"), JSON.stringify({ source, inputs }));
await build({ configFile: false, root: project, build: { outDir: output, emptyOutDir: false,
  lib: { entry: join(project, "benchmarks/paired-color-check.ts"), name: "PairedColor", formats: ["iife"], fileName: () => "checker.js" } } });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(createRequire(import.meta.url)("electron"), [join(project, "scripts/paired-color-check-main.cjs"), output], { env, stdio: "inherit" });
process.exitCode = await new Promise<number>((done, reject) => {
  child.once("error", reject); child.once("exit", code => done(code ?? 1));
});
