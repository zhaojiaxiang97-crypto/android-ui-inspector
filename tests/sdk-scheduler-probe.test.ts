import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSchedstat, parseCpuFrequency, parsePowerState, startSchedulerProbe } from "../scripts/diagnostics/sdk/sdk-scheduler-probe";

test("scheduler readings reject missing, negative and unsafe counters", () => {
  assert.deepEqual(parseSchedstat("1000 200 3\n"), { runtimeNs: 1000, waitNs: 200, slices: 3 });
  for (const value of ["", "1 2", "1 -2 3", "1 2 9007199254740992"]) assert.throws(() => parseSchedstat(value));
  assert.equal(parseCpuFrequency("500000\n"), 500000);
  for (const value of ["", "0", "-1", "permission denied"]) assert.throws(() => parseCpuFrequency(value));
});

test("power fields missing from OEM output remain unknown", () => {
  assert.deepEqual(parsePowerState("mWakefulness=Awake\nmIsPowered=true"), { wakefulness: "Awake", powered: true, lowPowerMode: null });
  assert.throws(() => parsePowerState("Permission denied"));
});

test("scheduler probe stops its timer and marks unavailable frequencies", async () => {
  const fields = Array.from({ length: 20 }, () => "0"); fields[0] = "S"; fields[19] = "999";
  let calls = 0;
  const probe = await startSchedulerProbe(async (...args) => {
    calls++;
    if (args.at(-1)?.endsWith("/stat")) return Buffer.from(`123 (sample) ${fields.join(" ")}`);
    if (args.at(-1)?.endsWith("/schedstat")) return Buffer.from("1000 200 3");
    if (args.at(-1) === "power") return Buffer.from("mWakefulness=Awake");
    throw new Error("Permission denied");
  }, "123", ["policy0"]);
  const report = await probe.stop();
  assert.equal(report.samples.length, 1);
  assert.deepEqual(report.samples[0].frequencyKhz, { policy0: { unavailable: true } });
  const count = calls; await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(calls, count);
  await assert.rejects(() => startSchedulerProbe(async () => Buffer.from(""), "bad", []));
});

test("missing process identity stops sampling without reading unrelated metrics", async () => {
  let calls = 0;
  const probe = await startSchedulerProbe(async () => { calls++; throw new Error("Disconnected"); }, "123", ["policy0"]);
  const report = await probe.stop();
  assert.equal(calls, 1);
  assert.equal(report.samples[0].identityUnavailable, true);
  assert.equal(report.samples[0].frequencyKhz, undefined);
});

test("stopping an in-flight sample drains it without rearming the timer", async () => {
  const fields = Array.from({ length: 20 }, () => "0"); fields[0] = "S"; fields[19] = "999";
  const stat = Buffer.from(`123 (sample) ${fields.join(" ")}`);
  let reads = 0, release: ((value: Buffer) => void) | undefined;
  let began: (() => void) | undefined;
  const inFlight = new Promise<void>(resolve => { began = resolve; });
  const probe = await startSchedulerProbe(async (...args) => {
    if (args.at(-1)?.endsWith("/stat")) {
      if (++reads === 2) { began!(); return new Promise<Buffer>(resolve => { release = resolve; }); }
      return stat;
    }
    if (args.at(-1)?.endsWith("/schedstat")) return Buffer.from("1000 200 3");
    return Buffer.from("mWakefulness=Awake");
  }, "123", []);
  await inFlight;
  const stopped = probe.stop(); release!(stat);
  const report = await stopped;
  assert.equal(report.samples.length, 2);
  assert.equal(report.samples[1].mainThread, undefined);
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(reads, 2);
});
