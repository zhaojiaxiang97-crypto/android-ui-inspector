#!/usr/bin/env bun
/** Offline timing analysis of frozen regression archives. Never connects to a phone. */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { debugTimingsSchema, debugTimingCoveredMs, type DebugTimingSpan, type DebugTimings } from "../shared/debug-timing";
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
const serverFields = ["queueMs", "preObservationMs", "observationMs", "jsonSerializationMs", "utf8EncodingMs",
  "cacheClearMs", "initialWindowReadMs", "getChildMs", "nodeLocalMs"] as const;
const serverBucket = () => ({ snapshotHeaders: 0, timedHeaders: 0, missingTimingHeaders: 0,
  phases: Object.fromEntries(serverFields.map(field => [field, empty()])) as Record<typeof serverFields[number], Stat>,
  measuredBeforeHeaders: empty(), hostHeaderDifference: empty(),
  matchedDeviceObservations: 0, observationOutsideBodyTiming: empty(), hierarchyOutsideNodeWork: empty() });
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

function observationLedgerRow(action: string, stepNumber: number, observationNumber: number, observation: DebugTimingSpan,
  timings: DebugTimings, map: Map<number, DebugTimingSpan>) {
  const children = timings.spans.filter(span => ancestorObservation(span, map)?.id === observation.id);
  // Request wrappers contain headers/body; use the child stages for interval coverage.
  const phases = hostPhases.filter(phase => phase !== "helper_request");
  const measured = children.filter(span => phases.some(phase => phase === span.phase));
  const coverage = debugTimingCoveredMs({ ...timings, spans: measured });
  const phaseCosts = Object.fromEntries(phases.map(phase => {
    const values = children.filter(span => span.phase === phase);
    return [phase, { count: values.length, totalMs: values.length ? rounded(values.reduce((n, s) => n + s.durationMs, 0)) : null }];
  }));
  const tree = children.find(span => span.helperDeviceTiming)?.helperDeviceTiming;
  const headers = children.filter(span => span.phase === "helper_request_headers" && span.helperEndpoint === "snapshot");
  const server = headers.length === 1 ? headers[0].helperServerTiming : undefined;
  const post = tree?.postProcessing;
  const previous = timings.spans.filter(span => span.phase === "observation"
    && (span.startOffsetMs < observation.startOffsetMs || span.startOffsetMs === observation.startOffsetMs && span.id < observation.id))
    .sort((a, b) => b.startOffsetMs - a.startOffsetMs || b.id - a.id)[0];
  const inputEnds = timings.spans.filter(span => span.phase === "input" && span.status === "success"
    && !ancestorObservation(span, map) && span.startOffsetMs + span.durationMs <= observation.startOffsetMs)
    .map(span => span.startOffsetMs + span.durationMs);
  // Dropped spans may hide a later input/read. Never infer adjacency from an incomplete timeline.
  const inputEnd = !timings.droppedSpans && inputEnds.length ? Math.max(...inputEnds) : null;
  const previousEnd = !timings.droppedSpans && previous ? previous.startOffsetMs + previous.durationMs : null;
  return { stepNumber, observationNumber,
    action: ["wait_for_ui", "perform_ui_step", "scroll_until", "resume_ui_step"].includes(action) ? action : "other",
    reason: observation.reason ?? "unspecified", group: group(action, observation),
    status: observation.status, durationMs: observation.durationMs,
    hostTimeline: { complete: timings.droppedSpans === 0, startOffsetMs: observation.startOffsetMs,
      endOffsetMs: rounded(observation.startOffsetMs + observation.durationMs),
      inputEndOffsetMs: inputEnd === null ? null : rounded(inputEnd),
      sinceInputMs: inputEnd === null ? null : rounded(observation.startOffsetMs - inputEnd),
      previousObservationEndOffsetMs: previousEnd === null ? null : rounded(previousEnd),
      sincePreviousObservationMs: previousEnd === null ? null : rounded(observation.startOffsetMs - previousEnd) },
    failedPhases: [...new Set(children.filter(span => span.status === "failed").map(span => span.phase))],
    helperReportedComplete: children.find(span => span.phase === "helper_tree")?.helperReportedComplete ?? null,
    measuredHostCoverageMs: rounded(coverage), unmeasuredHostMs: rounded(Math.max(0, observation.durationMs - coverage)),
    hostPhases: phaseCosts,
    snapshotHeaders: headers.length, snapshotHeaderMs: headers.length ? rounded(headers.reduce((n, s) => n + s.durationMs, 0)) : null,
    serverTiming: server ?? null,
    deviceTiming: tree ? { totalMs: tree.completedAtMs - tree.startedAtMs,
      hierarchyMs: tree.hierarchyCompletedAtMs - tree.hierarchyStartedAtMs,
      screenshotMs: tree.screenshotCompletedAtMs - tree.screenshotStartedAtMs,
      pngEncodingMs: post ? post.pngEncodingCompletedAtMs - post.pngEncodingStartedAtMs : null,
      base64EncodingMs: post ? post.base64EncodingCompletedAtMs - post.base64EncodingStartedAtMs : null,
      windowValidationMs: post ? post.windowValidationCompletedAtMs - post.windowValidationStartedAtMs : null } : null };
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
  private readonly observationLedger: ReturnType<typeof observationLedgerRow>[] = [];
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
  private readonly server = Object.fromEntries(groups.map(g => [g, serverBucket()])) as Record<Group, ReturnType<typeof serverBucket>>;
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
    const serverObservations = new Map<number, NonNullable<DebugTimingSpan["helperServerTiming"]>>();
    const deviceObservations = new Map<number, HelperObservationTiming>();
    for (const span of spans) {
      const observation = span.phase === "observation" ? span : ancestorObservation(span, map);
      if (span.phase === "observation") {
        const bucket = this.host[group(action, span)]; add(bucket.observations, span.durationMs);
        this.observationLedger.push(observationLedgerRow(action, this.steps.size, this.observationLedger.length + 1, span, t, map));
        if (span.status !== "running") bucket[span.status]++;
      }
      const phase = hostPhases.find(p => p === span.phase);
      if (phase) add(observation ? this.host[group(action, observation)].phases[phase] : this.unscopedPhases[phase], span.durationMs);
      if (!observation) {
        if (span.helperDeviceTiming) fail("device_timing_without_observation");
        if (span.helperServerTiming) fail("server_timing_without_observation");
        continue;
      }
      const g = group(action, observation), endpoint = span.helperEndpoint ?? "unlabelled";
      const requestPart = ({ helper_request: "requests", helper_request_headers: "headers",
        helper_response_read: "body", helper_json_parse: "json" } as const)[span.phase as "helper_request"];
      if (requestPart) add(this.host[g].requests[endpoint][requestPart], span.durationMs);
      if (span.phase === "helper_request_headers" && endpoint === "snapshot") {
        const bucket = this.server[g], timing = span.helperServerTiming;
        bucket.snapshotHeaders++;
        if (!timing) bucket.missingTimingHeaders++;
        else {
          if (serverObservations.has(observation.id)) fail("multiple_server_timings_for_observation");
          serverObservations.set(observation.id, timing); bucket.timedHeaders++;
          for (const field of serverFields) if (timing[field] !== undefined) add(bucket.phases[field], timing[field]);
          // These five server intervals are disjoint. Tree details below are nested
          // within observationMs and must never be added to this subtotal.
          const measured = rounded(timing.queueMs + timing.preObservationMs + timing.observationMs
            + timing.jsonSerializationMs + timing.utf8EncodingMs);
          add(bucket.measuredBeforeHeaders, measured);
          // Keep signed differences: clocks and rounded durations are not exact
          // synchronized measurements. Never clamp a negative difference to zero.
          add(bucket.hostHeaderDifference, rounded(span.durationMs - measured));
        }
      }
      if (span.phase !== "helper_tree" || !span.helperDeviceTiming) continue;
      if (timedObservations.has(observation.id)) fail("multiple_device_timings_for_observation");
      timedObservations.add(observation.id); this.host[g].deviceTimedAttempts++;
      deviceObservations.set(observation.id, span.helperDeviceTiming);
      const device = this.device[g]; addDevice(device.phases, span.helperDeviceTiming);
      if (observation.status === "success") device.hostObservationSuccess++;
      else if (observation.status === "cancelled") device.hostObservationCancelled++;
      else device.hostObservationFailed++;
      if (span.helperReportedComplete) device.reportedComplete++; else device.reportedIncomplete++;
    }
    for (const span of spans) if (span.phase === "observation" && !timedObservations.has(span.id))
      this.host[group(action, span)].missingDeviceTimingAttempts++;
    for (const [id, server] of serverObservations) {
      const device = deviceObservations.get(id);
      if (!device) continue;
      const bucket = this.server[group(action, map.get(id)!)]; bucket.matchedDeviceObservations++;
      add(bucket.observationOutsideBodyTiming, rounded(server.observationMs - (device.completedAtMs - device.startedAtMs)));
      if (server.getChildMs !== undefined && server.nodeLocalMs !== undefined)
        add(bucket.hierarchyOutsideNodeWork, rounded(device.hierarchyCompletedAtMs - device.hierarchyStartedAtMs
          - server.getChildMs - server.nodeLocalMs));
    }
  }

  summary() {
    return structuredClone({ format: "helper-timing-profile-v1", archives: this.archives, uniqueSteps: this.steps.size,
      measuredSteps: this.measuredSteps, unmeasuredSteps: this.unmeasuredSteps, droppedSpans: this.droppedSpans,
      productMeasuredMs: rounded(this.productMs), hostObservationGroups: this.host, hostOutsideObservation: this.unscopedPhases,
      deviceAttemptGroups: this.device, archivedDeviceCaptures: this.archivedDevice, serverAttemptGroups: this.server,
      observationLedger: this.observationLedger,
      limitations: ["Only fixed timing fields are exported; page text, identifiers, selectors and authentication material are omitted.",
        "Host phases overlap or nest: phase totals and device totals must not be added to product or observation duration.",
        "Device durations use their own monotonic clock and are never positioned on the host timeline.",
        "Archived captures are a deduplicated retained subset, not all observation attempts; do not add them to per-attempt device timings.",
        "Missing endpoint or timing remains unlabelled/unavailable, never a measured zero. Inspect sample counts and droppedSpans.",
        "A helper-reported complete capture or successful timing span does not prove input or business success.",
        "Unattributed device time includes only unmeasured intervals inside the device observation, not HTTP queueing or JSON response serialization.",
        "Server timing is optional diagnostic data; missing or invalid headers never become zero-cost measurements.",
        "Server tree details nest within observationMs. Only queue, preObservation, observation, JSON and UTF-8 are added as measuredBeforeHeaders.",
        "preObservation includes HTTP reading and authentication, not just CPU work. queue measures worker scheduling after socket acceptance, not the capture tryLock.",
        "Header and observation differences remain signed and unassigned; clocks, rounding and unmeasured work prevent labelling them as pure network or Binder latency.",
        "Ledger step/observation numbers are local ordinals. Host interval coverage is a union, not predicted removable time; purpose does not prove redundancy.",
        "Host timeline offsets and gaps are local to one step; independent resume cannot infer time since the original input. Dropped spans make adjacency gaps unavailable.",
        "Failed phases locate recorded failures, not their cause. Old generic foreground failures cannot be reclassified as a null foreground or safe retry."] });
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
