import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeviceMemory, parseDeviceThermal, parseProcessLoad, parseGcEvents, deviceLoadSampler } from "../scripts/diagnostics/sdk/sdk-device-load";

test("device memory requires the same PID and complete counters", () => {
  const text = "MEMINFO in pid 123 [sample]\nJava Heap: 10\nNative Heap: 20\nGraphics: 30\nTOTAL PSS: 90 TOTAL RSS: 100";
  assert.deepEqual(parseDeviceMemory(text, "123"), { pssKb: 90, rssKb: 100, javaHeapPssKb: 10, nativeHeapPssKb: 20, graphicsPssKb: 30 });
  assert.throws(() => parseDeviceMemory(text, "12"));
  assert.throws(() => parseDeviceMemory(text.replace("Graphics:", "Missing:"), "123"));
});

test("thermal diagnostics exclude stale cached temperatures and thresholds", () => {
  const text = "Thermal Status: 0\nCached temperatures:\nTemperature{mValue=90.0, mType=0, mName=CPU, mStatus=3}\nCurrent temperatures from HAL:\nTemperature{mValue=37.0, mType=0, mName=CPU, mStatus=0}\nCurrent cooling devices from HAL:\n";
  assert.deepEqual(parseDeviceThermal(text), { status: 0, temperatures: [{ celsius: 37, type: 0, status: 0 }] });
  assert.throws(() => parseDeviceThermal("Thermal Status: 0"));
});

test("process counters handle names with parentheses and enforce identity", () => {
  const fields = Array.from({ length: 20 }, () => "0");
  fields[0] = "S"; fields[11] = "10"; fields[12] = "20"; fields[17] = "5"; fields[19] = "999";
  const text = `123 (sample (test)) ${fields.join(" ")}`;
  assert.deepEqual(parseProcessLoad(text, "123"), { cpuTicks: 30, threads: 5, startTicks: 999 });
  assert.throws(() => parseProcessLoad(text, "456"));
  assert.throws(() => parseProcessLoad("123 (sample) S", "123"));
});

test("GC parsing retains only observed events and does not invent missing durations", () => {
  const events = parseGcEvents("[1] sample: Background GC freed 1MB, paused 1ms total 20.5ms\n[2] sample: Starting\n[3] sample: GC freed 2MB");
  assert.equal(events.length, 2); assert.equal(events[0].totalMs, 20.5); assert(Number.isNaN(events[1].totalMs));
  assert.deepEqual(parseGcEvents(""), []);
});

test("sampler deduplicates GC windows, marks inaccessible metrics, and rejects PID reuse", () => {
  let start = "999";
  const fields = Array.from({ length: 20 }, () => "0"); fields[0] = "S";
  const sample = deviceLoadSampler((...args) => {
    if (args.includes("meminfo")) { assert(args.includes("--local")); throw new Error("Permission denied"); }
    if (args.includes("thermalservice")) throw new Error("Permission denied");
    if (args.includes("/proc/loadavg")) return Buffer.from("1.0 2.0 3.0 1/100 123");
    if (args[0] === "logcat") return Buffer.from("[1] sample: GC freed 1MB total 10ms");
    fields[19] = start; return Buffer.from(`123 (sample) ${fields.join(" ")}`);
  }, "123");
  const first = sample();
  assert.deepEqual(first.memory, { unavailable: true });
  assert.deepEqual(first.thermal, { unavailable: true });
  assert.deepEqual(first.loadAverage, [1, 2, 3]);
  assert.deepEqual(first.gcLogs, { newObservedEvents: 1, explicitEvents: 0, observedTotalMs: 10, boundedWindow: true });
  assert.deepEqual(sample().gcLogs, { newObservedEvents: 0, explicitEvents: 0, observedTotalMs: 0, boundedWindow: true });
  start = "1000"; assert.throws(sample, /restarted/);
  assert.throws(() => deviceLoadSampler(() => Buffer.from(""), ""));
});
