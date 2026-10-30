import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { writePrivateJson } from "../electron/automation/mcp-snapshot";
import { runCaptureControlStudy, type ControlPorts } from "./capture-control-driver";

const absolute = z.string().refine(isAbsolute, "An absolute path is required");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const artifact = z.object({ path: absolute, sha256: digest, certificateSha256: digest }).strict();
export const captureControlConfig = z.object({ version: z.literal(1), runDirectory: absolute,
  qualificationOnly: z.literal(true).optional(),
  serial: z.literal("DEVICE_SERIAL"), packageName: z.literal("com.androiduiinspector.sdkfree"),
  adbPath: absolute, apksignerPath: absolute, tokenFile: absolute, desktopSnapshotPath: absolute,
  helper: artifact, sample: artifact, sources: z.array(z.object({ path: absolute, sha256: digest }).strict()).min(6).max(64),
}).strict();
export type CaptureControlConfig = z.infer<typeof captureControlConfig>;
export type RecoveryBaseline = { helperSha256: string; sampleSha256: string; bootId: string;
  settings: Record<string, string>; forwards: string; desktopFiles: { path: string; sha256: string | null }[] };
export type CaptureControlPlatform = { ports: ControlPorts;
  preflight(signal: AbortSignal): Promise<RecoveryBaseline>;
  closeSessions(signal: AbortSignal): Promise<void>;
  restorePackages(baseline: RecoveryBaseline, signal: AbortSignal): Promise<void>;
  restorePairing(baseline: RecoveryBaseline, signal: AbortSignal): Promise<void>;
  verifySettings(baseline: RecoveryBaseline, signal: AbortSignal): Promise<void>;
  verifyForwards(baseline: RecoveryBaseline, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void> };
export class ControlEntryFault extends Error {
  constructor(readonly code: string, message: string = code) { super(message); }
}
const failure = (error: unknown) => ({ code: error instanceof ControlEntryFault ? error.code : "entry_failed",
  message: (error instanceof Error ? error.message : String(error)).slice(0, 1000) });
export function readControlJson(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = fstatSync(fd); assert(info.isFile() && info.size <= 4 * 1024 * 1024);
    return JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
}
export function controlFingerprint(config: CaptureControlConfig) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
export function createControlJournal(path: string, initial: unknown) {
  let committed = JSON.stringify(initial);
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, committed); fsyncSync(fd); } finally { closeSync(fd); }
  return (value: unknown) => {
    assert(JSON.stringify(readControlJson(path)) === committed, "Journal changed; refusing overwrite");
    const next = JSON.stringify(value); assert(Buffer.byteLength(next) <= 4 * 1024 * 1024);
    writePrivateJson(path, value);
    const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(file); } finally { closeSync(file); }
    committed = next;
  };
}

/** Recovery is independent of the expired/cancelled sampling signal. Every step gets its own record and deadline. */
export async function recoverCaptureControl(config: CaptureControlConfig, baseline: RecoveryBaseline | null, platform: CaptureControlPlatform) {
  const directory = join(config.runDirectory, "recovery", randomUUID());
  const result = { version: 1, fingerprint: controlFingerprint(config), status: "running", directory, archiveErrors: [] as string[],
    steps: [] as { name: string; status: string; path: string; error?: ReturnType<typeof failure>; archiveError?: string }[] };
  let checkpoint: ReturnType<typeof createControlJournal> | undefined;
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }); checkpoint = createControlJournal(join(directory, "manifest.json"), result); }
  catch { result.archiveErrors.push("recovery_index_start_failed"); }
  const operations = [
    ["sessions", () => platform.closeSessions(AbortSignal.timeout(15_000))],
    ["packages", () => baseline && platform.restorePackages(baseline, AbortSignal.timeout(90_000))],
    ["pairing", () => baseline && platform.restorePairing(baseline, AbortSignal.timeout(60_000))],
    ["settings-and-desktop", () => baseline && platform.verifySettings(baseline, AbortSignal.timeout(15_000))],
    ["forwards", () => baseline && platform.verifyForwards(baseline, AbortSignal.timeout(15_000))],
    ["platform-disposal", () => platform.dispose()],
  ] as const;
  for (const [name, operation] of operations) {
    const step: typeof result.steps[number] = { name, status: "running", path: join(directory, `${result.steps.length + 1}-${name}.json`) };
    result.steps.push(step);
    let save: ReturnType<typeof createControlJournal> | undefined;
    try { save = createControlJournal(step.path, step); } catch { step.archiveError = "step_archive_start_failed"; }
    try { await operation(); step.status = baseline || name === "sessions" || name === "platform-disposal" ? "passed" : "not_needed"; }
    catch (error) { step.status = "failed"; step.error = failure(error); }
    try { save?.(step); } catch { step.archiveError = "step_archive_finish_failed"; }
    try { checkpoint?.(result); } catch { step.archiveError = "recovery_index_write_failed"; }
  }
  result.status = !result.archiveErrors.length && result.steps.every(s => ["passed", "not_needed"].includes(s.status) && !s.archiveError) ? "passed" : "failed";
  try { checkpoint?.(result); } catch { result.status = "failed"; }
  return result;
}

/** Reserves a NEW run before touching any device; never retries or resumes sampling. */
export async function runCaptureControlEntry(raw: CaptureControlConfig, platform: CaptureControlPlatform,
  options: { offlineOnly: boolean; signal?: AbortSignal; study?: typeof runCaptureControlStudy } ) {
  const config = captureControlConfig.parse(raw);
  assert(options.offlineOnly || !options.study, "Synthetic study is forbidden in device entry");
  mkdirSync(config.runDirectory, { mode: 0o700 });
  const result = { version: 1, ownerPid: process.pid, fingerprint: controlFingerprint(config), offlineOnly: options.offlineOnly,
    status: "running", baseline: null as RecoveryBaseline | null, studyPath: join(config.runDirectory, "study", "study.json"),
    failure: null as ReturnType<typeof failure> | null, recoveryPath: null as string | null, recoveryPassed: false,
    recoverySummary: null as Awaited<ReturnType<typeof recoverCaptureControl>> | null };
  const checkpoint = createControlJournal(join(config.runDirectory, "entry.json"), result);
  let archiveFailed = false;
  try {
    options.signal?.throwIfAborted(); result.baseline = await platform.preflight(options.signal ?? AbortSignal.timeout(30_000)); checkpoint(result);
    const study = await (options.study ?? runCaptureControlStudy)({ directory: join(config.runDirectory, "study"), offlineOnly: options.offlineOnly,
      qualificationOnly: config.qualificationOnly, ports: platform.ports, signal: options.signal });
    if (study.status !== "passed") throw new ControlEntryFault(study.failureCode ?? "study_failed", study.failure ?? "Study stopped");
    result.status = "passed";
  } catch (error) { result.status = options.signal?.aborted ? "cancelled" : "failed"; result.failure = failure(error); }
  finally {
    try {
      const recovery = await recoverCaptureControl(config, result.baseline, platform);
      result.recoverySummary = recovery;
      result.recoveryPath = join(recovery.directory, "manifest.json"); result.recoveryPassed = recovery.status === "passed";
      if (!result.recoveryPassed) { result.status = "failed"; result.failure ??= { code: "recovery_failed", message: "Recovery did not pass" }; }
    } catch (error) { result.status = "failed"; result.failure ??= failure(error); }
    try { checkpoint(result); } catch {
      archiveFailed = true;
      // An independent file preserves the primary cause when the main index is unavailable or replaced.
      const fallback = join(config.runDirectory, `entry-failure-${randomUUID()}.json`);
      try {
        const fd = openSync(fallback, "wx", 0o600);
        try { writeFileSync(fd, JSON.stringify({ ...result, status: "failed", archiveFailure: "entry_index_write_failed" })); fsyncSync(fd); }
        finally { closeSync(fd); }
      } catch (error) { throw Object.assign(new ControlEntryFault("failure_archive_unavailable"), { primary: result.failure, recovery: result.recoverySummary, cause: error }); }
    }
  }
  if (archiveFailed) result.status = "failed";
  return result;
}

export async function recoverCaptureControlEntry(raw: CaptureControlConfig, platform: CaptureControlPlatform, recoveryRecord?: string) {
  const config = captureControlConfig.parse(raw), path = recoveryRecord ?? join(config.runDirectory, "entry.json");
  assert(isAbsolute(path) && dirname(resolve(path)) === resolve(config.runDirectory)
    && (basename(path) === "entry.json" || /^entry-failure-[0-9a-f-]{36}\.json$/.test(basename(path))), "Recovery record is outside this run");
  const previous = readControlJson(path);
  assert(previous.version === 1 && previous.fingerprint === controlFingerprint(config), "Recovery scope/config changed");
  if (previous.status === "running") {
    assert(Number.isSafeInteger(previous.ownerPid) && previous.ownerPid > 0);
    let alive = false; try { process.kill(previous.ownerPid, 0); alive = true; } catch { /* An ended process may recover, never resume sampling. */ }
    assert(!alive, "Original entry is still running");
  }
  const baseline = previous.baseline === null ? null : z.object({ helperSha256: digest, sampleSha256: digest,
    bootId: z.string().uuid(), settings: z.record(z.string(), z.string().max(64)), forwards: z.string().max(8192),
    desktopFiles: z.array(z.object({ path: absolute, sha256: digest.nullable() }).strict()).length(2),
  }).strict().parse(previous.baseline);
  if (baseline) assert(baseline.helperSha256 === config.helper.sha256 && baseline.sampleSha256 === config.sample.sha256);
  if (baseline) assert.deepEqual(baseline.desktopFiles.map(f => f.path), [config.desktopSnapshotPath, config.desktopSnapshotPath + ".live"]);
  return recoverCaptureControl(config, baseline, platform);
}
