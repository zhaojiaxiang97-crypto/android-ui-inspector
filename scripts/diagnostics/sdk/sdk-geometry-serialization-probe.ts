// Read the sample-only fixed-input report; does not capture or change a business App.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { validateGeometrySplit } from "../../geometry-serialization-validation";

const [serial, token] = process.argv.slice(2);
if (!serial || !/^[\w.:-]+$/.test(serial) || !token || !/^[\w-]{1,100}$/.test(token)) throw new Error("Usage: bun scripts/diagnostics/sdk/sdk-geometry-serialization-probe.ts SERIAL TOKEN");
const original = process.argv.includes("--original");
const split = process.argv.includes("--split");
const cache = process.argv.includes("--format-cache");
assert.ok(!cache || split, "Format cache requires split profiling");
assert.ok(!split || !original, "Split profiling does not run the original/candidate experiment");
const deadline = performance.now() + (cache ? 90_000 : split ? 60_000 : original ? 120_000 : 30_000);
let report: any;
do {
  try {
    const candidate = JSON.parse(execFileSync("adb", ["-s", serial, "exec-out", "run-as", "com.androiduiinspector.sample", "cat", "files/isolation-probe/geometry-serialization.json"], { timeout: 3000, maxBuffer: 64_000 }).toString());
    if (candidate.probeToken === token) { report = candidate; break; }
  } catch {}
  await wait(500);
} while (performance.now() < deadline);
assert.ok(report, "Fresh serialization report missing");
if (split) {
  validateGeometrySplit(report, cache);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
assert.equal(report.passed, true, JSON.stringify(report));
assert.equal(report.edgeCasesPassed, true);
assert.ok(report.records >= 400 && report.records <= 1200);
assert.ok(report.recordBytes > 0 && report.recordBytes < 3_900_000);
const groups = original ? report.groups : [{ rounds: report.rounds }];
if (original) {
  assert.equal(report.originalObjects, true);
  assert.equal(report.workers, 2);
  assert.equal(report.queueDepth, 4);
  assert.ok(Number.isSafeInteger(report.selectedViews) && report.selectedViews >= report.records && report.selectedViews <= 1200);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group: any) => group.parsed).sort(), [false, true]);
  for (const counts of [report.originalTypes, report.parsedTypes]) {
    assert.ok(counts && Object.values(counts).every(value => Number.isSafeInteger(value) && Number(value) >= 0));
  }
  for (const group of groups) {
    for (const profile of [group.scalarProfile?.numbers, group.scalarProfile?.strings]) {
      assert.ok(profile && Number.isSafeInteger(profile.count) && profile.count > 0);
      assert.ok(Number.isSafeInteger(profile.characters) && profile.characters > 0);
      assert.ok(Number.isSafeInteger(profile.wallNanos) && profile.wallNanos >= 0);
      if (profile.cpuNanos !== undefined) assert.ok(Number.isSafeInteger(profile.cpuNanos) && profile.cpuNanos >= 0);
    }
  }
}
for (const group of groups) {
assert.equal(group.rounds.length, 8);
for (const candidate of [false, true]) {
  const rounds = group.rounds.filter((round: any) => round.candidate === candidate);
  assert.equal(rounds.length, 4);
  for (const round of rounds) {
    assert.ok(Number.isSafeInteger(round.wallNanos) && round.wallNanos >= 0);
    if (round.cpuNanos !== undefined) assert.ok(Number.isSafeInteger(round.cpuNanos) && round.cpuNanos >= 0);
    for (const name of ["processAllocatedBytesDelta", "processGcCountDelta"]) {
      if (round[name] !== undefined) assert.ok(Number.isSafeInteger(round[name]) && round[name] >= 0);
    }
  }
}
}
console.log(JSON.stringify(report, null, 2));
