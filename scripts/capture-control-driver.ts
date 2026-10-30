import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DebugSession } from "../electron/automation/debug-session";
import { writePrivateJson } from "../electron/automation/mcp-snapshot";
import { CONTROL, controlStages, controlPlan, controlGate, controlDrift, compareControlPages, stageGates, matrixChunkBudget,
  treatments, type ControlStage, type ControlFrame, type ControlBlock } from "./capture-control-protocol";
import { closeControlSession, executeControlBlock, type ControlTarget, type ControlBlockResult } from "./capture-control-session";

export type ControlIdentity = ControlTarget & { helperSha256: string; appSha256: string; bootId: string };
type Identity = ControlIdentity;
export type ControlClock = { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
export const controlClock: ControlClock = { now: Date.now, sleep: async (ms, signal) => { await delay(ms, undefined, { signal }); } };
export type ControlPorts = {
  /** Must return immediately after confirming a NEW Helper PID. This module never installs/rebuilds one. */
  prepare(stage: ControlStage, signal: AbortSignal): Promise<{ processReadyMs: number; helperPid?: number; identity?: Identity }>;
  identity(signal: AbortSignal): Promise<Identity>;
  quiet(signal: AbortSignal): Promise<void>;
  ready(page: "small" | "large", signal: AbortSignal): Promise<void>;
  /** Borrow an existing authorized session, or null. This must never grant access automatically. */
  session(chunk: { id: string; directory: string; limits: ControlBlock["limits"] }, signal: AbortSignal): Promise<DebugSession | null>;
};
type StageRecord = { stage: ControlStage; status: "pending" | "running" | "passed" | "failed" | "cancelled";
  processReadyMs?: number; armedMs?: number; dueMs?: number; firstDispatchMs?: number; identity?: Identity;
  blocks: { plan: ControlBlock; result?: ControlBlockResult }[]; frames: ControlFrame[];
  sessions: { chunk: string; sessionId: string; openedMs: number; closedMs?: number; reportPath?: string; closed?: boolean; error?: string }[];
  gate?: ReturnType<typeof stageGates>; crossQualification?: ReturnType<typeof compareControlPages>;
  counts: { attempts: number; complete: number }; failure?: string; failureCode?: string };
const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "study_failed";

/** Explicitly invoked isolated driver. Importing this file cannot contact a device or start sampling. */
export async function runCaptureControlStudy(options: { directory: string; offlineOnly: boolean; ports: ControlPorts;
  qualificationOnly?: true; clock?: ControlClock; signal?: AbortSignal; offlineExecutor?: typeof executeControlBlock }) {
  assert(options.offlineOnly || !options.offlineExecutor, "Synthetic executor is forbidden in device runs");
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  assert(!lstatSync(options.directory).isSymbolicLink());
  const directory = realpathSync(options.directory), manifestPath = join(directory, "study.json"), clock = options.clock ?? controlClock;
  const stages: readonly ControlStage[] = options.qualificationOnly ? controlStages.slice(0, 2) : controlStages;
  const study = { runId: randomUUID(), offlineOnly: options.offlineOnly, scope: options.qualificationOnly ? "qualification-only" : "full-control",
    status: "running", startedMs: clock.now(), finishedMs: null as number | null,
    constants: CONTROL, actualDeviceSamples: 0, plannedFrames: stages.reduce((n, stage) => n + controlPlan(stage).length * 3, 0), referenceGapMatched: null, overheadPassed: null,
    stages: stages.map(stage => ({ stage, status: "pending", blocks: controlPlan(stage).map(plan => ({ plan })), frames: [], sessions: [],
      counts: { attempts: 0, complete: 0 } }) as StageRecord), failure: null as string | null, failureCode: null as string | null };
  let committed = JSON.stringify(study);
  const fd = openSync(manifestPath, "wx", 0o600);
  try { writeFileSync(fd, committed); fsyncSync(fd); } finally { closeSync(fd); }
  const publish = () => {
    assert(lstatSync(manifestPath).isFile() && !lstatSync(manifestPath).isSymbolicLink()
      && readFileSync(manifestPath, "utf8") === committed, "Study index changed; never overwrite it");
    const next = JSON.stringify(study); assert(Buffer.byteLength(next) <= 4 * 1024 * 1024);
    writePrivateJson(manifestPath, study);
    const file = openSync(manifestPath, "r"); try { fsyncSync(file); } finally { closeSync(file); }
    committed = next;
  };
  const seenSessions = new Set<string>(), seenSnapshots = new Set<string>(), seenProcesses = new Set<number>(), seenServices = new Set<string>();
  let previousIdentity: Identity | undefined;
  try {
    for (const stage of study.stages) {
      const timeout = AbortSignal.timeout(CONTROL.stageTimeoutMs);
      const signal = AbortSignal.any([timeout, ...(options.signal ? [options.signal] : [])]);
      let session: DebugSession | null = null;
      const close = async () => {
        if (!session) return;
        const record = stage.sessions.at(-1)!;
        try {
          const archived = await closeControlSession(session);
          const path = relative(directory, archived.reportPath);
          assert(path && !path.startsWith("..") && !path.startsWith("/"), "Archive escaped this run");
          Object.assign(record, archived);
        } catch (error) { record.error = String(error); throw error; }
        finally { record.closedMs = clock.now(); session = null; publish(); }
      };
      try {
        signal.throwIfAborted(); stage.status = "running"; publish();
        const prepared = await options.ports.prepare(stage.stage, signal);
        stage.armedMs = clock.now(); stage.processReadyMs = prepared.processReadyMs;
        const origin = prepared.processReadyMs, due = stage.dueMs = origin + CONTROL.holdMs;
        let identity: Identity | undefined;
        assert(Number.isSafeInteger(origin) && origin > 0 && stage.armedMs >= origin && stage.armedMs - origin <= CONTROL.maxLagMs,
          "Driver was not armed immediately after Helper rebuild; no rescheduling");
        publish();
        let chunk = "", lastPage = "";
        for (const entry of stage.blocks) {
          signal.throwIfAborted();
          if (clock.now() - stage.armedMs >= CONTROL.stageTimeoutMs) throw Error("Stage deadline exceeded");
          const block = entry.plan;
          if (chunk !== block.chunk) {
            await close(); chunk = block.chunk;
            const blocks = stage.blocks.filter(e => e.plan.chunk === chunk);
            if (!chunk.endsWith("initial")) matrixChunkBudget(blocks.length * 3, block.limits);
            const first = stage.firstDispatchMs === undefined;
            const authDue = first ? due - CONTROL.readyLeadMs : clock.now() + 30_000;
            const specification = { id: chunk, directory: join(directory, "recordings", chunk), limits: block.limits };
            while (!session && clock.now() <= authDue) {
              signal.throwIfAborted(); session = await options.ports.session(specification, signal);
              if (!session) await clock.sleep(CONTROL.authorizationPollMs, signal);
            }
            assert(session, "Authorization missed fixed preparation boundary; no rescheduling");
            stage.sessions.push({ chunk, sessionId: session.state.id, openedMs: clock.now() }); publish();
            // Pairing is cleared by rebuild. Pin service identity AFTER authorization, without moving the PID-based due time.
            if (!identity) {
              identity = prepared.identity ?? await options.ports.identity(signal); stage.identity = identity;
              if (prepared.helperPid !== undefined) assert.equal(identity.helperPid, prepared.helperPid, "Helper changed while awaiting authorization");
              assert(identity.helperPid > 0 && !seenProcesses.has(identity.helperPid) && !seenServices.has(identity.serviceId), "Helper process/service was reused");
              seenProcesses.add(identity.helperPid); seenServices.add(identity.serviceId);
              if (!options.offlineOnly) assert(identity.serial === "DEVICE_SERIAL" && identity.packageName === "com.androiduiinspector.sdkfree"
                && identity.width === 1080 && identity.height === 2400 && identity.rotation === 0
                && identity.nodeCounts.small === 69 && identity.nodeCounts.large === 758, "Device/fixture scope differs from frozen plan");
              if (previousIdentity) {
                const strip = ({ helperPid: _p, serviceId: _s, ...rest }: Identity) => rest;
                assert.deepEqual(strip(identity), strip(previousIdentity), "Environment/package hashes changed between processes");
              }
              previousIdentity = identity; publish();
            }
            assert(session.state.active && !session.state.busy && !session.hasPendingWork && session.state.steps.length === 0 && !seenSessions.has(session.state.id),
              "Chunk must begin with a fresh authorized session");
            assert.equal(session.state.serial, identity.serial); assert.equal(session.state.packageName, identity.packageName);
            assert(!session.state.androidLogsEnabled, "Android logs must remain disabled");
            seenSessions.add(session.state.id);
          }
          assert(identity, "Service identity must be pinned before any capture");
          await options.ports.quiet(signal);
          assert.deepEqual(await options.ports.identity(signal), identity, "Helper/environment changed inside a stage");
          if (lastPage !== block.page) { await options.ports.ready(block.page, signal); lastPage = block.page; }
          if (stage.firstDispatchMs === undefined) {
            assert(due - clock.now() >= CONTROL.readyLeadMs, "Preparation missed fixed start; no rescheduling");
            // Monotonic sleep target; the epoch check detects wall-clock shifts rather than moving the start.
            await clock.sleep(due - clock.now(), signal);
          }
          signal.throwIfAborted();
          const chunkSignal = AbortSignal.any([signal, AbortSignal.timeout(CONTROL.chunkTimeoutMs)]);
          const result = await (options.offlineExecutor ?? executeControlBlock)(session!, block, identity, chunkSignal, update => {
            entry.result = update;
            stage.counts.attempts = stage.blocks.reduce((n, e) => n + (e.result?.requests.reduce((m, q) => m + q.attempts, 0) ?? 0), 0);
            stage.counts.complete = stage.blocks.reduce((n, e) => n + (e.result?.requests.reduce((m, q) => m + q.complete, 0) ?? 0), 0);
            if (!options.offlineOnly) study.actualDeviceSamples = study.stages.reduce((n, s) => n + s.counts.attempts, 0);
            publish();
          }, () => {
            if (stage.firstDispatchMs === undefined) {
              stage.firstDispatchMs = clock.now();
              assert(stage.firstDispatchMs - due >= 0 && stage.firstDispatchMs - due <= CONTROL.maxLagMs, "Fixed dispatch missed; no rescheduling");
            }
          });
          if (result.status !== "passed") throw Object.assign(new Error(result.failure ?? "Complete block failed"), { code: result.failureCode ?? "block_failed" });
          assert.deepEqual(result.frames.map(f => f.role), treatments[block.treatment]);
          for (const frame of result.frames) { assert(!seenSnapshots.has(frame.snapshotId), "Snapshot reused across blocks/sessions"); seenSnapshots.add(frame.snapshotId); }
          stage.frames.push(...result.frames);
          const sameSegment = stage.blocks.filter(e => e.plan.page === block.page && e.plan.segment === block.segment);
          if (["qualification", "before", "after"].includes(block.segment) && sameSegment.at(-1) === entry) {
            const ids = new Set(sameSegment.map(e => e.plan.id));
            assert(controlGate(stage.frames.filter(f => ids.has(f.blockId))).accepted, "Original 5% within-page gate failed; no further sampling");
            if (block.segment === "after") {
              const segment = (name: string) => stage.frames.filter(f => stage.blocks.some(e => e.plan.id === f.blockId && e.plan.page === block.page && e.plan.segment === name));
              for (const metric of ["hostMs", "treeMs"] as const) assert(controlDrift(segment("before").map(f => f[metric]), segment("after").map(f => f[metric])).accepted,
                "Original 5% pre/post sentinel gate failed; next page not started");
            }
          }
          publish();
        }
        await close(); stage.gate = stageGates(stage.stage, stage.frames);
        assert(stage.gate.accepted, "Original 5% stage gate rejected");
        if (stage.stage === "Q2") {
          const measured = (s: StageRecord) => s.frames.filter(f => s.blocks.some(b => b.plan.id === f.blockId && b.plan.segment === "qualification"));
          stage.crossQualification = compareControlPages(measured(study.stages[0]), measured(stage));
          assert(stage.crossQualification.accepted, "Original 5% independent-process gate failed; matrix not started");
        }
        stage.status = "passed"; publish();
      } catch (error) {
        stage.status = signal.aborted ? "cancelled" : "failed"; stage.failure = String(error); stage.failureCode = errorCode(error); throw error;
      } finally { await close(); publish(); }
    }
    study.status = "passed";
  } catch (error) {
    const primary = study.stages.find(s => s.failure);
    study.status = options.signal?.aborted ? "cancelled" : "failed";
    study.failure = primary?.failure ?? String(error); study.failureCode = primary?.failureCode ?? errorCode(error);
  }
  finally { study.finishedMs = clock.now(); publish(); }
  return { manifestPath, ...structuredClone(study) };
}
