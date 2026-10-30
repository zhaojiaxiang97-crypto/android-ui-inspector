import { parseProcessLoad } from "./sdk-device-load";
import { parseCpuFrequency, parseSchedstat } from "./sdk-scheduler-probe";

export function parseCpuList(text: string) {
  if (!/^\d+(?:-\d+)?(?:[ ,]+\d+(?:-\d+)?)*$/.test(text.trim())) throw new Error("CPU list unavailable");
  const values = text.trim().split(/[ ,]+/).flatMap(part => {
    const [first, last = first] = part.split("-").map(Number);
    if (first! > last! || last! > 255) throw new Error("CPU range invalid");
    return Array.from({ length: last! - first! + 1 }, (_, index) => first! + index);
  });
  if (new Set(values).size !== values.length) throw new Error("Duplicate CPU");
  return values;
}

export function parseThreadStat(text: string, tid: string) {
  const process = parseProcessLoad(text, tid);
  const match = /^\d+ \((.*)\) ([\s\S]+)$/.exec(text.trim());
  if (!match) throw new Error("Thread stat unavailable");
  const fields = match[2]!.split(/\s+/);
  const processor = Number(fields[36]); // /proc stat field 39; fields here begin at field 3.
  if (!/^\d+$/.test(fields[36] ?? "") || !Number.isSafeInteger(processor) || processor > 255) throw new Error("Thread CPU unavailable");
  return { ...process, name: match[1], processor };
}

export function parseThreadSnapshot(text: string, pid: string, policies: string[]) {
  const rows = text.trim().split("\n");
  const before = rows.find(row => row.startsWith("P|"));
  const after = rows.find(row => row.startsWith("Q|"));
  if (!before || !after) throw new Error("Process identity unavailable");
  const process = parseProcessLoad(before.slice(2), pid);
  if (parseProcessLoad(after.slice(2), pid).startTicks !== process.startTicks) throw new Error("Process changed in snapshot");
  const frequency = policies.map(policy => {
    const row = rows.find(value => value.startsWith(`F|${policy}|`));
    try {
      const parts = row?.split("|");
      return { policy, cpus: parseCpuList(parts?.[2] ?? ""), khz: parseCpuFrequency(parts?.[3] ?? "") };
    } catch { return { policy, unavailable: true as const }; }
  });
  const tids = new Set<string>();
  const threads = rows.filter(row => row.startsWith("T|")).map(row => {
    const match = /^T\|(\d+)\|(.+)$/.exec(row);
    if (!match || tids.has(match[1]!)) throw new Error("Thread identity invalid");
    const tid = match[1]!; tids.add(tid);
    const stat = parseThreadStat(match[2]!, tid);
    const role = tid === pid ? "main" : "encoder";
    if (role === "encoder" && !["inspector-encod", "inspector-encode"].includes(stat.name!)) throw new Error("Unrelated worker");
    const mapped = frequency.filter(value => "cpus" in value && value.cpus?.includes(stat.processor));
    if (mapped.length > 1) throw new Error("Ambiguous CPU policy");
    const schedulerRow = rows.find(value => value.startsWith(`S|${tid}|`));
    let scheduler: ReturnType<typeof parseSchedstat> | { unavailable: true };
    try { scheduler = parseSchedstat(schedulerRow?.slice(`S|${tid}|`.length) ?? ""); }
    catch { scheduler = { unavailable: true }; }
    return { tid, role, ...stat, scheduler, frequency: mapped[0] ?? { unavailable: true } };
  });
  if (!tids.has(pid) || threads.length > 3) throw new Error("Main/encoder snapshot incomplete");
  return { process, threads, frequency };
}

/** Bounded point readings: last-executed CPU is not a residency trace. Sample App only. */
export async function startThreadSchedulerProbe(adb: (...args: string[]) => Promise<Buffer>, pid: string, policies: string[]) {
  if (!/^\d+$/.test(pid) || policies.length > 16 || policies.some(value => !/^policy\d{1,3}$/.test(value))) throw new Error("Invalid thread sampler targets");
  const command = `printf 'P|'; cat /proc/${pid}/stat; n=0; for d in /proc/${pid}/task/[0-9]*; do
    n=$((n+1)); [ "$n" -le 128 ] || exit 1
    tid=\${d##*/}; read -r name < "$d/comm" || continue
    if [ "$tid" = '${pid}' ] || [ "$name" = inspector-encod ] || [ "$name" = inspector-encode ]; then
      IFS= read -r stat < "$d/stat" 2>/dev/null || continue
      printf 'T|%s|%s\n' "$tid" "$stat"
      printf 'S|%s|' "$tid"; cat "$d/schedstat" 2>/dev/null || printf '?\n'
    fi
  done
  printf 'Q|'; cat /proc/${pid}/stat`;
  const frequencyCommand = policies.map(policy => `printf 'F|${policy}|'; tr '\n' ' ' < /sys/devices/system/cpu/cpufreq/${policy}/related_cpus 2>/dev/null; printf '|'; cat /sys/devices/system/cpu/cpufreq/${policy}/scaling_cur_freq 2>/dev/null || printf '?\n'`).join("\n");
  const started = performance.now();
  const samples: Record<string, unknown>[] = [];
  let stopped = false, startTicks: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const take = async () => {
    const began = performance.now();
    const row: Record<string, unknown> = { startedMs: Math.round(began - started) };
    try {
      const raw = await adb("shell", "run-as", "com.androiduiinspector.sample", "sh", "-c", `'${command.replace(/'/g, "'\\''")}'`);
      const identity = parseThreadSnapshot(raw.toString(), pid, []);
      if (startTicks !== undefined && identity.process.startTicks !== startTicks) throw new Error("Sample process restarted");
      startTicks = identity.process.startTicks;
      let frequencies = "";
      if (!stopped && frequencyCommand) {
        try { frequencies = (await adb("shell", "sh", "-c", `'${frequencyCommand.replace(/'/g, "'\\''")}'`)).toString(); }
        catch {} // Missing frequency permissions are unknown, not zero.
      }
      const snapshot = parseThreadSnapshot(`${raw.toString()}\n${frequencies}`, pid, policies);
      Object.assign(row, snapshot);
    } catch {
      row.identityUnavailable = true;
      stopped = true;
    }
    row.endedMs = Math.round(performance.now() - started);
    row.sampleMs = Math.round(performance.now() - began);
    samples.push(row);
    if (!stopped && samples.length < 60) timer = setTimeout(() => { pending = take(); }, 1000);
  };
  await take();
  return { async stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    await pending;
    return { pauseBetweenSamplesMs: 1000, capped: samples.length === 60, lastCpuOnly: true, samples };
  } };
}
