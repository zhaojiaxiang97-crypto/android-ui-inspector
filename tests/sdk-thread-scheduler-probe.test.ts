import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCpuList, parseThreadStat, parseThreadSnapshot, startThreadSchedulerProbe } from "../scripts/diagnostics/sdk/sdk-thread-scheduler-probe";

function stat(tid: string, name: string, cpu = 0, start = 99) {
  const fields = Array.from({ length: 37 }, () => "0");
  fields[0] = "S"; fields[19] = String(start); fields[36] = String(cpu);
  return `${tid} (${name}) ${fields.join(" ")}`;
}
function snapshot(main = stat("123", "sample (main)", 6), worker = stat("124", "inspector-encod", 1)) {
  return `P|${main}\nT|123|${main}\nS|123|100 20 3\nT|124|${worker}\nS|124|?\nQ|${main}\n`;
}
test("CPU topology lists reject invalid, duplicate and unbounded CPUs", () => {
  assert.deepEqual(parseCpuList("0-3 6,7"), [0, 1, 2, 3, 6, 7]);
  for (const value of ["", "?", "3-0", "256", "0 0", "0-3 2", "-1"]) assert.throws(() => parseCpuList(value));
});
test("thread stat uses field 39 and verifies TID even with parentheses in comm", () => {
  assert.equal(parseThreadStat(stat("123", "name (a)", 6), "123").processor, 6);
  assert.throws(() => parseThreadStat(stat("124", "sample"), "123"));
  assert.throws(() => parseThreadStat(stat("123", "sample", -1), "123"));
  assert.throws(() => parseThreadStat(stat("123", "sample", 256), "123"));
  assert.throws(() => parseThreadStat("123 (sample) S", "123"));
});
test("maps main and SDK encoder last CPUs to their policies, missing data stays unknown", () => {
  const result = parseThreadSnapshot(snapshot() + "F|policy0|0-3|500000\nF|policy4|4 5 6 7|2000000", "123", ["policy0", "policy4"]);
  assert.equal(result.threads[0]!.role, "main");
  assert.ok("policy" in result.threads[0]!.frequency);
  assert.equal(result.threads[0]!.frequency.policy, "policy4");
  assert.ok("policy" in result.threads[1]!.frequency);
  assert.equal(result.threads[1]!.frequency.policy, "policy0");
  assert.deepEqual(result.threads[1]!.scheduler, { unavailable: true });
  assert.deepEqual(parseThreadSnapshot(snapshot(), "123", ["policy0"]).threads[0]!.frequency, { unavailable: true });
});
test("rejects changed process, unrelated workers and ambiguous CPU mappings", () => {
  assert.throws(() => parseThreadSnapshot(snapshot().replace(`Q|${stat("123", "sample (main)", 6)}`, `Q|${stat("123", "sample", 6, 100)}`), "123", []));
  assert.throws(() => parseThreadSnapshot(snapshot(undefined, stat("124", "other-worker")), "123", []));
  assert.throws(() => parseThreadSnapshot(snapshot() + "F|policy0|0-7|1000\nF|policy4|4-7|2000", "123", ["policy0", "policy4"]));
});
test("thread sampler stops its timer and reports denied frequency as unknown", async () => {
  let calls = 0;
  const probe = await startThreadSchedulerProbe(async (...args) => {
    calls++;
    if (args.includes("run-as")) return Buffer.from(snapshot());
    throw new Error("Denied");
  }, "123", ["policy0"]);
  const report = await probe.stop();
  assert.equal(report.lastCpuOnly, true);
  assert.equal(report.samples.length, 1);
  assert.ok(report.samples[0]!.threads);
  const count = calls; await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(calls, count);
  await assert.rejects(() => startThreadSchedulerProbe(async () => Buffer.from(""), "bad", []));
});
test("missing process identity stops before reading policies", async () => {
  let calls = 0;
  const probe = await startThreadSchedulerProbe(async () => { calls++; throw new Error("Disconnected"); }, "123", ["policy0"]);
  const report = await probe.stop();
  assert.equal(calls, 1);
  assert.equal(report.samples[0]!.identityUnavailable, true);
});

test("stop drains in-flight thread reads and does not rearm sampling", async () => {
  let calls = 0, release: ((value: Buffer) => void) | undefined;
  let began: (() => void) | undefined;
  const inFlight = new Promise<void>(resolve => { began = resolve; });
  const probe = await startThreadSchedulerProbe(async () => {
    if (++calls === 2) { began!(); return new Promise<Buffer>(resolve => { release = resolve; }); }
    return Buffer.from(snapshot());
  }, "123", []);
  await inFlight;
  const stopping = probe.stop(); release!(Buffer.from(snapshot()));
  assert.equal((await stopping).samples.length, 2);
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(calls, 2);
});
