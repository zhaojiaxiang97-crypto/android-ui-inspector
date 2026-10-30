#!/usr/bin/env bun
/** Offline timing analysis of frozen regression archives. Never connects to a phone. */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { debugTimingsSchema, type DebugTimingSpan, type DebugTimings } from "../shared/debug-timing";
import { helperObservationTimingSchema, type HelperObservationTiming } from "../shared/helper-observation-timing";
import type { LoadedTestReport } from "../shared/test-report";
import { loadTestReport } from "../electron/desktop/test-report";

type Group = "normal" | "automaticRetry" | "independentResume";
type Endpoint = "capabilities" | "snapshot" | "unlabelled";
type ProfileSpan = DebugTimingSpan & { helperEndpoint?: Exclude<Endpoint, "unlabelled">;
  helperDeviceTiming?: HelperObservationTiming; helperReportedComplete?: boolean };
const groups: Group[] = ["normal", "automaticRetry", "independentResume"];
const endpoints: Endpoint[] = ["capabilities", "snapshot", "unlabelled"];
const hostPhases = ["helper_request", "helper_request_headers", "helper_response_read", "helper_json_parse",
  "helper_tree", "helper_png_validation", "target_before", "target_after", "save"] as const;
type Stat = { count: number; totalMs: number; meanMs: number | null; minMs: number | null; maxMs: number | null };
const empty = (): Stat => ({ count: 0, totalMs: 0, meanMs: null, minMs: null, maxMs: null });
const rounded = (n: number) => Math.round(n * 1000) / 1000;
function add(s: Stat, value: number) {
  s.count++; s.totalMs = rounded(s.totalMs + value); s.meanMs = rounded(s.totalMs / s.count);
  s.minMs = s.minMs === null ? value : Math.min(s.minMs, value); s.maxMs = s.maxMs === null ? value : Math.max(s.maxMs, value);
}
const deviceBucket = () => ({ count: 0, postProcessingCount: 0, total: empty(), hierarchy: empty(), screenshot: empty(),
  windowValidation: empty(), pngEncoding: empty(), base64Encoding: empty(), unattributed: empty() });
function addDevice(bucket: ReturnType<typeof deviceBucket>, t: HelperObservationTiming) {
  const total = t.completedAtMs - t.startedAtMs, tree = t.hierarchyCompletedAtMs - t.hierarchyStartedAtMs;
  const screenshot = t.screenshotCompletedAtMs - t.screenshotStartedAtMs;
  bucket.count++; add(bucket.total, total); add(bucket.hierarchy, tree); add(bucket.screenshot, screenshot);
  let known = tree + screenshot;
  if (t.postProcessing) {
    bucket.postProcessingCount++;
    const p = t.postProcessing;
    for (const [key, duration] of [["windowValidation", p.windowValidationCompletedAtMs - p.windowValidationStartedAtMs],
      ["pngEncoding", p.pngEncodingCompletedAtMs - p.pngEncodingStartedAtMs],
      ["base64Encoding", p.base64EncodingCompletedAtMs - p.base64EncodingStartedAtMs]] as const) {
      add(bucket[key], duration); known += duration;
    }
  }
  add(bucket.unattributed, total - known);
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
class ProfileError extends Error {}
function fail(code: string): never { throw new ProfileError(code); }
function ancestorObservation(span: DebugTimingSpan, map: Map<number, DebugTimingSpan>) {
  let parent = span.parentId === null ? undefined : map.get(span.parentId);
  while (parent && parent.phase !== "observation") parent = parent.parentId === null ? undefined : map.get(parent.parentId);
  return parent;
}
function group(action: string, observation: DebugTimingSpan): Group {
  return action === "resume_ui_step" ? "independentResume" : observation.reason === "recovery" ? "automaticRetry" : "normal";
}

/** Discards page content immediately; only bounded timing counters and deduplication digests remain. */
export class HelperTimingProfile {
  private session: string | undefined;
  private archives = 0;
  private readonly steps = new Map<number, string>();
  private readonly captures = new Map<string, string>();
  private measuredSteps = 0;
  private unmeasuredSteps = 0;
  private droppedSpans = 0;
  private productMs = 0;
  private readonly host = Object.fromEntries(groups.map(g => [g, { observations: empty(), success: 0, failed: 0, cancelled: 0,
    deviceTimedAttempts: 0, missingDeviceTimingAttempts: 0,
    phases: Object.fromEntries(hostPhases.map(p => [p, empty()])),
    requests: Object.fromEntries(endpoints.map(e => [e, { requests: empty(), headers: empty(), body: empty(), json: empty() }])) }])) as
    Record<Group, { observations: Stat; success: number; failed: number; cancelled: number; deviceTimedAttempts: number;
      missingDeviceTimingAttempts: number; phases: Record<typeof hostPhases[number], Stat>;
      requests: Record<Endpoint, { requests: Stat; headers: Stat; body: Stat; json: Stat }> }>;
  private readonly device = Object.fromEntries(groups.map(g => [g, { phases: deviceBucket(), hostObservationSuccess: 0,
    hostObservationFailed: 0, hostObservationCancelled: 0, reportedComplete: 0, reportedIncomplete: 0 }])) as Record<Group,
      { phases: ReturnType<typeof deviceBucket>; hostObservationSuccess: number; hostObservationFailed: number;
        hostObservationCancelled: number; reportedComplete: number; reportedIncomplete: number }>;
  private readonly archivedDevice = deviceBucket();
  private readonly unscopedPhases = Object.fromEntries(hostPhases.map(p => [p, empty()])) as Record<typeof hostPhases[number], Stat>;

  add(report: LoadedTestReport) {
    const d = report.debug;
    if (!d) fail("debug_report_required");
    if (this.session && this.session !== d.session.id) fail("mixed_sessions");
    this.session = d.session.id;
    if (report.images.some(image => image.error) || d.snapshots.some(snapshot => snapshot.treeError)) fail("invalid_attachment");
    this.archives++;
    for (const entry of d.steps) {
      const t = entry.step.timings;
      const digest = hash([entry.step.action, entry.step.status, t ?? null]);
      const old = this.steps.get(entry.step.id);
      if (old) { if (old !== digest) fail("conflicting_step_measurements"); continue; }
      this.steps.set(entry.step.id, digest);
      if (!t) { this.unmeasuredSteps++; continue; }
      if (!debugTimingsSchema.safeParse(t).success || t.status === "running") fail("invalid_or_unfinished_timings");
      this.measuredSteps++; this.productMs += t.durationMs; this.droppedSpans += t.droppedSpans;
      this.addHost(entry.step.action, t);
    }
    // Older archives retain only selected successful snapshots. Keep this population
    // separate from new per-attempt spans; never add these durations together.
    for (const item of d.snapshots) {
      const evidence = item.snapshot?.helperObservation;
      if (!evidence) continue;
      const parsed = helperObservationTimingSchema.safeParse(evidence.timing);
      if (!parsed.success) fail("invalid_archived_device_timing");
      const key = `${evidence.serviceInstanceId}/${evidence.captureId}`, digest = hash(parsed.data);
      const previous = this.captures.get(key);
      if (previous) { if (previous !== digest) fail("conflicting_capture_measurements"); continue; }
      this.captures.set(key, digest); addDevice(this.archivedDevice, parsed.data);
    }
  }

  private addHost(action: string, t: DebugTimings) {
    const spans = t.spans as ProfileSpan[], map = new Map(spans.map(s => [s.id, s]));
    const timedObservations = new Set<number>();
    for (const span of spans) {
      const observation = span.phase === "observation" ? span : ancestorObservation(span, map);
      if (span.phase === "observation") {
        const bucket = this.host[group(action, span)]; add(bucket.observations, span.durationMs);
        if (span.status !== "running") bucket[span.status]++;
      }
      const phase = hostPhases.find(p => p === span.phase);
      if (phase) add(observation ? this.host[group(action, observation)].phases[phase] : this.unscopedPhases[phase], span.durationMs);
      if (!observation) {
        if (span.helperDeviceTiming) fail("device_timing_without_observation");
        continue;
      }
      const g = group(action, observation), endpoint = span.helperEndpoint ?? "unlabelled";
      const requestPart = ({ helper_request: "requests", helper_request_headers: "headers",
        helper_response_read: "body", helper_json_parse: "json" } as const)[span.phase as "helper_request"];
      if (requestPart) add(this.host[g].requests[endpoint][requestPart], span.durationMs);
      if (span.phase !== "helper_tree" || !span.helperDeviceTiming) continue;
      if (timedObservations.has(observation.id)) fail("multiple_device_timings_for_observation");
      timedObservations.add(observation.id); this.host[g].deviceTimedAttempts++;
      const device = this.device[g]; addDevice(device.phases, span.helperDeviceTiming);
      if (observation.status === "success") device.hostObservationSuccess++;
      else if (observation.status === "cancelled") device.hostObservationCancelled++;
      else device.hostObservationFailed++;
      if (span.helperReportedComplete) device.reportedComplete++; else device.reportedIncomplete++;
    }
    for (const span of spans) if (span.phase === "observation" && !timedObservations.has(span.id))
      this.host[group(action, span)].missingDeviceTimingAttempts++;
  }

  summary() {
    return structuredClone({ format: "helper-timing-profile-v1", archives: this.archives, uniqueSteps: this.steps.size,
      measuredSteps: this.measuredSteps, unmeasuredSteps: this.unmeasuredSteps, droppedSpans: this.droppedSpans,
      productMeasuredMs: rounded(this.productMs), hostObservationGroups: this.host, hostOutsideObservation: this.unscopedPhases,
      deviceAttemptGroups: this.device, archivedDeviceCaptures: this.archivedDevice,
      limitations: ["Only fixed timing fields are exported; page text, identifiers, selectors and authentication material are omitted.",
        "Host phases overlap or nest: phase totals and device totals must not be added to product or observation duration.",
        "Device durations use their own monotonic clock and are never positioned on the host timeline.",
        "Archived captures are a deduplicated retained subset, not all observation attempts; do not add them to per-attempt device timings.",
        "Missing endpoint or timing remains unlabelled/unavailable, never a measured zero. Inspect sample counts and droppedSpans.",
        "A helper-reported complete capture or successful timing span does not prove input or business success.",
        "Unattributed device time includes only unmeasured intervals inside the device observation, not HTTP queueing or JSON response serialization."] });
  }
}

/** Accept only frozen report paths inside the selected regression directory. No live source report reads. */
export async function profileRegressionTimings(samplesFile: string, load = loadTestReport) {
  const file = await realpath(samplesFile), root = dirname(file), info = await lstat(file);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) fail("samples_size_or_type");
  const rows = (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  const paths = new Set<string>();
  for (const row of rows) {
    if (row.event !== "result") continue;
    if (!Array.isArray(row.archives)) fail("archives_unavailable");
    for (const archive of row.archives) {
      if (!archive || typeof archive.reportPath !== "string" || !isAbsolute(archive.reportPath)) fail("archive_path_required");
      const path = await realpath(archive.reportPath), rel = relative(root, path);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("archive_outside_regression");
      paths.add(path);
      if (paths.size > 256) fail("archive_count_limit");
    }
  }
  if (!paths.size) fail("archives_unavailable");
  const profile = new HelperTimingProfile();
  for (const path of paths) profile.add(await load(path));
  return profile.summary();
}

async function main() {
  const { values } = parseArgs({ options: { samples: { type: "string" }, out: { type: "string" }, help: { type: "boolean" } }, strict: true });
  if (values.help) { console.log("bun scripts/helper-timing-profile.ts --samples /absolute/run/samples.jsonl --out /absolute/new-profile.json"); return; }
  if (!values.samples || !values.out || !isAbsolute(values.samples) || !isAbsolute(values.out)) fail("absolute_paths_required");
  const summary = await profileRegressionTimings(values.samples);
  await writeFile(values.out, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ output: values.out, archives: summary.archives, steps: summary.uniqueSteps,
    deviceAttempts: groups.reduce((sum, g) => sum + summary.deviceAttemptGroups[g].phases.count, 0),
    archivedCaptures: summary.archivedDeviceCaptures.count }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => {
  console.error(JSON.stringify({ error: error instanceof ProfileError ? error.message : "profile_failed" })); process.exitCode = 1;
});
