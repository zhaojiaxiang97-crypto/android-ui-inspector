import { parseProcessLoad } from "./sdk-device-load";

export function parseSchedstat(output: string) {
  const fields = output.trim().split(/\s+/);
  if (fields.length !== 3 || fields.some(value => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error("Scheduler counters unavailable");
  return { runtimeNs: Number(fields[0]), waitNs: Number(fields[1]), slices: Number(fields[2]) };
}

export function parseCpuFrequency(output: string) {
  const value = Number(output.trim());
  if (!/^\d+$/.test(output.trim()) || !Number.isSafeInteger(value) || value <= 0) throw new Error("CPU frequency unavailable");
  return value; // kHz, a point reading, not a time-weighted average or a limit.
}

export function parsePowerState(output: string) {
  const wakefulness = /\bmWakefulness=(\w+)/.exec(output)?.[1];
  if (!wakefulness) throw new Error("Power state unavailable");
  const flag = (key: string) => { const value = new RegExp(`\\b${key}=(true|false)`).exec(output)?.[1]; return value === undefined ? null : value === "true"; };
  return { wakefulness, powered: flag("mIsPowered"), lowPowerMode: flag("mLowPowerModeEnabled") };
}

/** One baseline, then bounded samples during the provider call. No writes or setting changes. */
export async function startSchedulerProbe(adb: (...args: string[]) => Promise<Buffer>, pid: string, policies: string[]) {
  if (!/^\d+$/.test(pid) || policies.length > 16 || policies.some(name => !/^policy\d{1,3}$/.test(name))) throw new Error("Invalid sample targets");
  const started = performance.now();
  const samples: Record<string, unknown>[] = [];
  let stopped = false, startTicks: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const take = async () => {
    const began = performance.now();
    const row: Record<string, unknown> = { startedMs: Math.round(began - started) };
    const read = async (name: string, work: () => Promise<unknown>) => {
      try { row[name] = await work(); } catch { row[name] = { unavailable: true }; }
    };
    try {
      const process = parseProcessLoad((await adb("shell", "run-as", "com.androiduiinspector.sample", "cat", `/proc/${pid}/stat`)).toString(), pid);
      if (startTicks !== undefined && process.startTicks !== startTicks) throw new Error("Process restarted");
      startTicks = process.startTicks;
      row.process = process;
    } catch {
      row.identityUnavailable = true;
      stopped = true; // Do not combine counters from another process or continue after disconnect.
    }
    if (!stopped) {
      await read("mainThread", async () => parseSchedstat((await adb("shell", "run-as", "com.androiduiinspector.sample", "cat", `/proc/${pid}/task/${pid}/schedstat`)).toString()));
      const frequencies: Record<string, unknown> = {};
      for (const policy of policies) {
        try { frequencies[policy] = parseCpuFrequency((await adb("shell", "cat", `/sys/devices/system/cpu/cpufreq/${policy}/scaling_cur_freq`)).toString()); }
        catch { frequencies[policy] = { unavailable: true }; }
      }
      row.frequencyKhz = frequencies;
      await read("power", async () => parsePowerState((await adb("shell", "dumpsys", "power")).toString()));
    }
    row.endedMs = Math.round(performance.now() - started);
    row.sampleMs = Math.round(performance.now() - began);
    samples.push(row);
    if (!stopped && samples.length < 60) timer = setTimeout(() => { pending = take(); }, 1000);
  };
  await take(); // First reading is before the call; later readings overlap the provider.
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await pending;
      return { pauseBetweenSamplesMs: 1000, capped: samples.length === 60, samples };
    },
  };
}
