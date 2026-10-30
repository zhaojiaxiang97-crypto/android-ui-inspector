// Read-only sample diagnostics. Never clear logs, force GC, or change thermal settings.
export function parseDeviceMemory(output: string, pid: string) {
  if (!output.includes(`MEMINFO in pid ${pid} [`)) throw new Error("Memory sample belongs to another process");
  const read = (pattern: RegExp) => {
    const match = pattern.exec(output);
    if (!match) throw new Error("Incomplete memory sample");
    return Number(match[1]);
  };
  return { pssKb: read(/TOTAL PSS:\s+(\d+)/), rssKb: read(/TOTAL RSS:\s+(\d+)/),
    javaHeapPssKb: read(/Java Heap:\s+(\d+)/), nativeHeapPssKb: read(/Native Heap:\s+(\d+)/),
    graphicsPssKb: read(/Graphics:\s+(\d+)/) };
}

export function parseDeviceThermal(output: string) {
  const status = /Thermal Status:\s+(\d+)/.exec(output);
  if (!status) throw new Error("Thermal status unavailable");
  // OEM cached values can be stale and differ from the HAL reading. Do not mix them.
  const current = output.split("Current temperatures from HAL:")[1]?.split("Current cooling devices from HAL:")[0];
  if (!current) throw new Error("Current thermal readings unavailable");
  const temperatures = [...current.matchAll(/Temperature\{mValue=([-\d.]+), mType=(\d+), mName=[^,}]+, mStatus=(\d+)\}/g)]
    .map(match => ({ celsius: Number(match[1]), type: Number(match[2]), status: Number(match[3]) }));
  if (!temperatures.length || temperatures.some(value => !Number.isFinite(value.celsius))) throw new Error("Invalid thermal readings");
  return { status: Number(status[1]), temperatures };
}

export function parseProcessLoad(output: string, pid: string) {
  const match = /^(\d+) \(.*\) ([\s\S]+)$/.exec(output.trim());
  if (!match || match[1] !== pid) throw new Error("Process sample identity changed");
  const fields = match[2].trim().split(/\s+/); // starts with field 3 (state), including names with spaces/parentheses.
  const read = (index: number) => {
    const value = Number(fields[index]);
    if (!/^\d+$/.test(fields[index] ?? "") || !Number.isSafeInteger(value)) throw new Error("Incomplete process sample");
    return value;
  };
  return { cpuTicks: read(11) + read(12), threads: read(17), startTicks: read(19) };
}

export function parseGcEvents(output: string) {
  // Bounded log window, same PID only. Absence of a matching line does NOT prove absence of GC.
  return output.split("\n").filter(line => /\bGC\b.*freed|freed.*\bGC\b/.test(line))
    .map(line => ({ key: line, explicit: /\bExplicit\b/.test(line), totalMs: Number(/\btotal\s+([\d.]+)ms/.exec(line)?.[1] ?? NaN) }));
}

export function deviceLoadSampler(adb: (...args: string[]) => Buffer, pid: string) {
  if (!/^\d+$/.test(pid)) throw new Error("Sample PID unavailable");
  const observedGc = new Set<string>();
  let processStart: number | undefined;
  return () => {
    const started = performance.now();
    const result: Record<string, unknown> = { pid };
    const read = (name: string, work: () => unknown) => {
      try { result[name] = work(); }
      catch { result[name] = { unavailable: true }; } // Permissions/OEM differences are not zero measurements.
    };
    // --local avoids calling ActivityThread.dumpMemInfo, which requests an explicit GC.
    read("memory", () => parseDeviceMemory(adb("shell", "dumpsys", "meminfo", "--local", "-s", pid).toString(), pid));
    read("thermal", () => parseDeviceThermal(adb("shell", "dumpsys", "thermalservice").toString()));
    read("loadAverage", () => {
      const values = adb("shell", "cat", "/proc/loadavg").toString().trim().split(/\s+/).slice(0, 3).map(Number);
      if (values.length !== 3 || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error("Load unavailable");
      return values;
    });
    // Never silently compare counters after a PID was reused or the process disappeared.
    const process = parseProcessLoad(adb("shell", "run-as", "com.androiduiinspector.sample", "cat", `/proc/${pid}/stat`).toString(), pid);
    if (processStart !== undefined && processStart !== process.startTicks) throw new Error("Sample process restarted");
    processStart = process.startTicks;
    result.process = process;
    read("gcLogs", () => {
      const events = parseGcEvents(adb("logcat", "-d", "-b", "main", "-t", "2000", `--pid=${pid}`, "-v", "monotonic").toString());
      const fresh = events.filter(event => !observedGc.has(event.key));
      for (const event of events) observedGc.add(event.key);
      return { newObservedEvents: fresh.length, explicitEvents: fresh.filter(event => event.explicit).length,
        observedTotalMs: fresh.every(event => Number.isFinite(event.totalMs))
        ? fresh.reduce((sum, event) => sum + event.totalMs, 0) : null, boundedWindow: true };
    });
    result.sampleMs = Math.round(performance.now() - started);
    return result;
  };
}
